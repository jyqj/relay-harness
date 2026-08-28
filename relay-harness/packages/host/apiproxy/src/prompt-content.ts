/**
 * Durable prompt-content helpers: batch image admission before publish, and
 * image-reference search across the durable event carriers.
 * @module @relay-harness/rlh-host-apiproxy/prompt-content
 */

import type { Context } from '@relay-harness/cordis'
import { admitEncodedImages } from '@relay-harness/rlh-attachment'
import type { ImageAttachmentRef } from '@relay-harness/rlh-attachment'
import { contentHasImage } from '@relay-harness/rlh-llm'
import type { ContentBlock } from '@relay-harness/rlh-llm'
import type { SessionEvent } from '@relay-harness/rlh-session'
import type { PromptContentPart } from './api/index.ts'

/**
 * Validate one prompt as a batch before publishing any durable image object.
 * @param ctx - the host context owning the attachment service.
 * @param content - the prompt parts to validate and convert.
 * @returns the model-request blocks, image parts admitted as attachment
 * references in input order.
 */
export async function durablePromptContent(ctx: Context, content: readonly PromptContentPart[]): Promise<ContentBlock[]> {
  if (content.every(part => part.type === 'text')) {
    return content.map(part => ({ type: 'text', text: part.text }))
  }
  const refs = await admitEncodedImages(ctx.attachments, content.filter(part => part.type === 'image'))
  let next = 0
  return content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    // admitEncodedImages returns one reference per image part in order.
    : { type: 'image', attachment: refs[next++] as ImageAttachmentRef })
}

/** Search durable content for an image reference, including nested tool results. */
function imageBlockIn(content: unknown, match: (ref: ImageAttachmentRef) => boolean): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Search every durable event carrier that can own model-visible content. */
function imageInEvent(event: SessionEvent, match: (ref: ImageAttachmentRef) => boolean): ImageAttachmentRef | undefined {
  const data = event.data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  if (data.message !== undefined) {
    const wrapped = imageBlockIn(data.message.content, match)
    if (wrapped !== undefined) return wrapped
  }
  if (data.inserted !== undefined) {
    for (const message of data.inserted) {
      const inserted = imageBlockIn(message.content, match)
      if (inserted !== undefined) return inserted
    }
  }
  if (event.type === 'assistant/chunk' && data.chunk?.type === 'block-end') {
    return imageBlockIn([data.chunk.block], match)
  }
  return undefined
}

/**
 * True when the current model-visible surface contains an image.
 * @param messages - the current model-visible message surface.
 * @returns whether any message's content carries an image.
 */
export function messagesHaveImage(messages: readonly { content: readonly ContentBlock[] }[]): boolean {
  return messages.some(message => contentHasImage(message.content))
}

/**
 * Resolve the first reference matching one opaque id.
 * @param events - the durable events searched in order.
 * @param attachmentId - the opaque id compared against each image reference.
 * @returns the first matching reference, or undefined when no event carries it.
 */
export function referencedImage(events: readonly SessionEvent[], attachmentId: string): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}
