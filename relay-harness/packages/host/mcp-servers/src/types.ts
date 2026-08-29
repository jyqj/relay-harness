/**
 * Wire types for the MCP server Settings Remote.
 * @module @relay-harness/rlh-host-mcp-servers/types
 */

import type { ChildFiberPhase, McpServerRecord } from '@relay-harness/rlh-mcp-servers-file/types'

export type { McpServerRecord } from '@relay-harness/rlh-mcp-servers-file/types'

/** Whether the row comes from the managed file or a composition plugin. */
export type McpServerOrigin = 'managed' | 'composition'

/** Live connection health reported by the mounted mcp-client instance. */
export interface McpServerConnection {
  readonly health: 'connecting' | 'connected' | 'reconnecting' | 'failed'
  readonly lastError?: string
  /** Public `mcp__<serverName>__…` names registered for the current generation. */
  readonly tools?: readonly string[]
  readonly resources?: readonly string[]
  readonly prompts?: readonly string[]
}

/** One MCP server as Settings lists it. */
export interface McpServerEntry {
  readonly id: string
  readonly origin: McpServerOrigin
  readonly writable: boolean
  readonly enabled: boolean
  readonly fiberPhase: ChildFiberPhase
  /** Present when a live mcp-client instance for this row reports connection health. */
  readonly connection?: McpServerConnection
  readonly spec: McpServerRecord
}

/** Point-in-time Settings snapshot. */
export interface McpServerSnapshot {
  readonly servers: readonly McpServerEntry[]
}

/** Upsert request body. */
export interface McpServerUpsertRequest {
  readonly spec: McpServerRecord
}

/** Id-addressed mutation. */
export interface McpServerIdRequest {
  readonly id: string
}

/** Enablement mutation. */
export interface McpServerEnableRequest {
  readonly id: string
  readonly enabled: boolean
}

/** Protocol-native MCP Settings catalog snapshot. */
export interface McpCatalogSnapshot {
  readonly resources: readonly McpResourceDescriptor[]
  readonly resourceTemplates: readonly McpResourceTemplateDescriptor[]
  readonly prompts: readonly McpPromptDescriptor[]
}
/** One concrete MCP Resource exposed on the Settings wire. */
export interface McpResourceDescriptor {
  readonly serverName: string
  readonly uri: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
  readonly size?: number
}
/** One MCP Resource Template exposed on the Settings wire. */
export interface McpResourceTemplateDescriptor {
  readonly serverName: string
  readonly uriTemplate: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
}
/** One MCP Prompt argument exposed on the Settings wire. */
export interface McpPromptArgument {
  readonly name: string
  readonly description?: string
  readonly required: boolean
}
/** One MCP Prompt exposed on the Settings wire. */
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
/** MCP text or base64 Resource content. */
export type McpResourceContent =
  | { readonly uri: string; readonly text: string; readonly mimeType?: string }
  | { readonly uri: string; readonly blob: string; readonly mimeType?: string }
/** Complete MCP Resource read result. */
export interface McpResourceRead { readonly contents: readonly McpResourceContent[] }
/** Protocol-native rich MCP Prompt content. */
export type McpRichContent =
  | {
    readonly type: 'text'
    readonly text: string
    readonly annotations?: McpJsonValue
  }
  | {
    readonly type: 'image' | 'audio'
    readonly data: string
    readonly mimeType: string
    readonly annotations?: McpJsonValue
  }
  | {
    readonly type: 'resource_link'
    readonly uri: string
    readonly name: string
    readonly title?: string
    readonly description?: string
    readonly mimeType?: string
    readonly annotations?: McpJsonValue
  }
  | {
    readonly type: 'resource'
    readonly resource: McpResourceContent
    readonly annotations?: McpJsonValue
  }
/** Role-addressed MCP Prompt message. */
export interface McpPromptMessage {
  readonly role: 'user' | 'assistant'
  readonly content: McpRichContent
}
/** Resolved MCP Prompt result. */
export interface McpPromptResult {
  readonly description?: string
  readonly messages: readonly McpPromptMessage[]
}
/** Id-addressed MCP Resource read request. */
export interface McpResourceReadRequest { readonly serverName: string; readonly uri: string }
/** MCP Prompt invocation request. */
export interface McpPromptGetRequest {
  readonly serverName: string
  readonly name: string
  readonly arguments: Readonly<Record<string, string>>
}
