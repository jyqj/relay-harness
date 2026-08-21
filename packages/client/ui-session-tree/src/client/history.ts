import type { HistoryEntry, IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** Protocol batch size; pagination continues until the complete log is read. */
const HISTORY_PAGE_MESSAGES = 100

/**
 * Read one Session without resuming its Agent. Pages are stitched in ascending
 * seq order and a non-progressing Host response fails loud.
 * @param api - connected typed API client.
 * @param sessionId - live or persisted Session to read.
 * @param signal - optional cancellation for overlay close or graph replacement.
 * @returns the complete raw history in ascending seq order.
 */
export async function readCompleteHistory(
  api: IApiClient,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<HistoryEntry[]> {
  const pages: HistoryEntry[][] = []
  let beforeSeq: number | undefined
  for (;;) {
    signal?.throwIfAborted()
    const response = await api.sessions.history({
      sessionId,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: HISTORY_PAGE_MESSAGES,
    })
    if (!response.result.ok) {
      throw new Error(`session tree history failed: ${response.result.error.code}: ${response.result.error.message}`)
    }
    const page = response.result.value
    pages.unshift(page.events)
    if (!page.hasMore || page.events.length === 0) break
    const next = page.events[0]?.event.seq
    if (next === undefined || (beforeSeq !== undefined && next >= beforeSeq)) {
      throw new Error(`session tree history for "${sessionId}" did not advance`)
    }
    beforeSeq = next
  }
  return pages.flat()
}
