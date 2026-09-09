/**
 * Browser conversation plugin. `contract/` is the shared type boundary
 * between the independently implemented skeleton and chat domains; `apply.ts`
 * owns their slot assembly.
 */











export { apply,inject } from './apply.ts'
export type { DraftAttachmentId } from './contract/input.ts'
export { ConversationController } from './service.ts'
export type { IConversation } from './service.ts'

export type {
  AssistantChatData,ChatNode,ChatNodeDataMap,ChatNodeKind,ManualCompactionChatData,
  RetryChatData,ToolChatData,TurnTailChatData,
} from './contract/chat-nodes.ts'
export type {
  ChatFileMentions,ChatNodeOwnerProps,ChatNodeViewProps,
  ChatStore,
  ChatViewInjected,
  ChatViewSlotProps,
  CommandRowOwnerProps,
  CommandRowProps,
  ComposerAttachment,
  ComposerAttachmentsOwnerProps,
  ComposerAttachmentsProps,
  ComposerBarInjected,
  ComposerChainProps,
  ConvViewOwnerProps,
  ConvViewProps,ConversationInjected,
  ConversationSessionHeaderInjected,
  ConversationSessionInjected,
  ConversationSlotProps,
  DetailsInjected,
  DetailsSlotProps,
  DetailsToolOwnerProps,
  EmptyWorkspaceOwnerProps,
  HeroBrandMarkOwnerProps,
  MessageImagesOwnerProps,
  MessageImagesProps,
  RenderMessageImages,
  TurnTailOwnerProps,
  UseChatNodeTurnData,
  UserActionContentBlock,
  UserActionOwnerProps,
  UserEditorOwnerProps,
} from './contract/slots.ts'
export type {
  CallId,ChatStoreState,SelectionTarget,ViewTab,
} from './contract/views.ts'
export type { ConversationKey } from './locales.ts'
// Export discipline: packages/client/AGENTS.md.

declare module '@relay-harness/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    conversation: import('./service.ts').IConversation
  }
}

// Retain shipped node registry declarations for built type consumers.
export type {} from './conversation-nodes/assistant.ts'
export type {} from './conversation-nodes/command.ts'
export type {} from './conversation-nodes/compaction.ts'
export type {} from './conversation-nodes/fallback.ts'
export type {} from './conversation-nodes/message.ts'
export type {} from './conversation-nodes/retry.ts'
export type {} from './conversation-nodes/tool.ts'
export type {} from './conversation-nodes/turn-error.ts'
export type {} from './conversation-nodes/turn-max-tokens.ts'
export type {} from './conversation-nodes/turn-tail.ts'
