/** Full-pagination MCP Resources/Templates/Prompts synchronization. */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { GetPromptResult, Prompt, Resource, ResourceTemplate } from '@modelcontextprotocol/sdk/types.js'
import type { McpCatalog, McpJsonValue, McpRichContent, McpServerCatalogGeneration } from '@relay-harness/rlh-mcp-catalog'

const MAX_CATALOG_ITEMS = 10_000
const MAX_CATALOG_PAGES = 1_000

/**
 * Fully fetch and atomically publish one MCP Resources/Templates/Prompts generation.
 * @param client - connected MCP SDK client.
 * @param catalog - process-wide protocol-native catalog.
 * @param serverName - stable server identity owning the generation.
 * @param isActive - generation ownership guard for late reads/resolution.
 * @returns disposer that unpublishes this exact generation.
 */
export async function syncCatalog(
  client: Client,
  catalog: McpCatalog,
  serverName: string,
  isActive: () => boolean = () => true,
): Promise<() => void> {
  const capabilities = client.getServerCapabilities()
  const resources = capabilities?.resources === undefined ? [] : await paginate<Resource, 'resources'>(async cursor => client.listResources(cursor === undefined ? undefined : { cursor }), 'resources')
  const resourceTemplates = capabilities?.resources === undefined ? [] : await paginate<ResourceTemplate, 'resourceTemplates'>(async cursor => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }), 'resourceTemplates')
  const prompts = capabilities?.prompts === undefined ? [] : await paginate<Prompt, 'prompts'>(async cursor => client.listPrompts(cursor === undefined ? undefined : { cursor }), 'prompts')
  const generation: McpServerCatalogGeneration = {
    serverName,
    resources: resources.map(item => ({
      uri: item.uri, name: item.name,
      ...item.title === undefined ? {} : { title: item.title },
      ...item.description === undefined ? {} : { description: item.description },
      ...item.mimeType === undefined ? {} : { mimeType: item.mimeType },
      ...item.size === undefined ? {} : { size: item.size },
    })),
    resourceTemplates: resourceTemplates.map(item => ({
      uriTemplate: item.uriTemplate, name: item.name,
      ...item.title === undefined ? {} : { title: item.title },
      ...item.description === undefined ? {} : { description: item.description },
      ...item.mimeType === undefined ? {} : { mimeType: item.mimeType },
    })),
    prompts: prompts.map(item => ({
      name: item.name,
      ...item.title === undefined ? {} : { title: item.title },
      ...item.description === undefined ? {} : { description: item.description },
      arguments: (item.arguments ?? []).map(argument => ({
        name: argument.name,
        ...argument.description === undefined ? {} : { description: argument.description },
        required: argument.required === true,
      })),
    })),
    async readResource(uri, signal) {
      if (!isActive()) throw new Error(`MCP server ${serverName} generation is disconnected`)
      const result = await client.readResource({ uri }, signal === undefined ? undefined : { signal })
      if (!isActive()) throw new Error(`MCP server ${serverName} generation changed during Resource read`)
      return { contents: result.contents.map(content => 'text' in content
        ? { uri: content.uri, text: content.text, ...content.mimeType === undefined ? {} : { mimeType: content.mimeType } }
        : { uri: content.uri, blob: content.blob, ...content.mimeType === undefined ? {} : { mimeType: content.mimeType } }) }
    },
    async getPrompt(name, args, signal) {
      if (!isActive()) throw new Error(`MCP server ${serverName} generation is disconnected`)
      const result = await client.getPrompt({ name, arguments: { ...args } }, signal === undefined ? undefined : { signal })
      if (!isActive()) throw new Error(`MCP server ${serverName} generation changed during Prompt resolution`)
      return {
        ...result.description === undefined ? {} : { description: result.description },
        messages: result.messages.map(message => ({ role: message.role, content: normalizeContent(message.content) })),
      }
    },
  }
  return catalog.publish(generation)
}

async function paginate<T, K extends string>(
  fetch: (cursor?: string) => Promise<Record<K, T[]> & { nextCursor?: string | undefined }>,
  key: K,
): Promise<T[]> {
  const values: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    pages += 1
    if (pages > MAX_CATALOG_PAGES) throw new Error(`MCP ${key} pagination exceeds ${MAX_CATALOG_PAGES} pages`)
    const result = await fetch(cursor)
    const page = result[key]
    if (!Array.isArray(page)) throw new Error(`MCP ${key} response is not an array`)
    values.push(...page as T[])
    if (values.length > MAX_CATALOG_ITEMS) throw new Error(`MCP ${key} catalog exceeds ${MAX_CATALOG_ITEMS} items`)
    cursor = result.nextCursor
    if (cursor !== undefined && seen.has(cursor)) throw new Error(`MCP ${key} pagination repeated cursor ${cursor}`)
    if (cursor !== undefined) seen.add(cursor)
  } while (cursor !== undefined)
  return values
}

function normalizeContent(content: GetPromptResult['messages'][number]['content']): McpRichContent {
  const annotations = 'annotations' in content && content.annotations !== undefined
    ? { annotations: structuredClone(content.annotations) as McpJsonValue }
    : {}
  switch (content.type) {
    case 'text': return { type: 'text', text: content.text, ...annotations }
    case 'image':
    case 'audio': return { type: content.type, data: content.data, mimeType: content.mimeType, ...annotations }
    case 'resource_link': return {
      type: 'resource_link', uri: content.uri, name: content.name,
      ...annotations,
      ...content.title === undefined ? {} : { title: content.title },
      ...content.description === undefined ? {} : { description: content.description },
      ...content.mimeType === undefined ? {} : { mimeType: content.mimeType },
    }
    case 'resource': return {
      type: 'resource',
      ...annotations,
      resource: 'text' in content.resource
        ? {
          uri: content.resource.uri, text: content.resource.text,
          ...content.resource.mimeType === undefined ? {} : { mimeType: content.resource.mimeType },
        }
        : {
          uri: content.resource.uri, blob: content.resource.blob,
          ...content.resource.mimeType === undefined ? {} : { mimeType: content.resource.mimeType },
        },
    }
    default: throw new Error('Unsupported MCP Prompt content type')
  }
}
