/** Client-safe MCP catalog resource and prompt vocabulary. */

export interface McpResourceDescriptor {
  readonly serverName: string
  readonly uri: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
  readonly size?: number
}
/** One advertised MCP Resource Template. */
export interface McpResourceTemplateDescriptor {
  readonly serverName: string
  readonly uriTemplate: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
}
/** One declared MCP Prompt argument. */
export interface McpPromptArgument { readonly name: string; readonly description?: string; readonly required: boolean }
/** One advertised MCP Prompt. */
export interface McpPromptDescriptor {
  readonly serverName: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly arguments: readonly McpPromptArgument[]
}
/** Lossless JSON metadata carried by rich MCP blocks. */
export type McpJsonValue = null | boolean | number | string | readonly McpJsonValue[]
  | { readonly [key: string]: McpJsonValue }
/** Persistable protocol-native MCP Prompt content. */
export type McpRichContent =
  | { readonly type: 'text'; readonly text: string; readonly annotations?: McpJsonValue }
  | { readonly type: 'image' | 'audio'; readonly data: string; readonly mimeType: string; readonly annotations?: McpJsonValue }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string; readonly title?: string; readonly description?: string; readonly mimeType?: string; readonly annotations?: McpJsonValue }
  | { readonly type: 'resource'; readonly resource: McpResourceContent; readonly annotations?: McpJsonValue }
/** Text or base64-blob MCP Resource content. */
export type McpResourceContent =
  | { readonly uri: string; readonly text: string; readonly mimeType?: string }
  | { readonly uri: string; readonly blob: string; readonly mimeType?: string }
/** Complete result of one MCP Resource read. */
export interface McpResourceRead { readonly contents: readonly McpResourceContent[] }
/** One role-addressed MCP Prompt message. */
export interface McpPromptMessage { readonly role: 'user' | 'assistant'; readonly content: McpRichContent }
/** Complete resolved MCP Prompt. */
export interface McpPromptResult { readonly description?: string; readonly messages: readonly McpPromptMessage[] }

/** One atomically published connected-server catalog generation. */
export interface McpServerCatalogGeneration {
  readonly serverName: string
  readonly resources: readonly Omit<McpResourceDescriptor, 'serverName'>[]
  readonly resourceTemplates: readonly Omit<McpResourceTemplateDescriptor, 'serverName'>[]
  readonly prompts: readonly Omit<McpPromptDescriptor, 'serverName'>[]
  readonly readResource: (uri: string, signal?: AbortSignal) => Promise<McpResourceRead>
  readonly getPrompt: (name: string, args: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<McpPromptResult>
}
