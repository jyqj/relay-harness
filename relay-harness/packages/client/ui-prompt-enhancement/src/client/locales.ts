/** Prompt Enhancement composer-control dictionaries. */

/** Simplified Chinese dictionary and key source. */
export const zh = {
  'button.label': '增强提示词',
  'button.busy': '正在增强提示词',
  'button.cancel': '取消提示词增强',
  'button.cancelling': '正在取消提示词增强',
  'draft.changed': '草稿已发生变化，增强结果未应用',
  'result.mismatch': '增强结果与本次草稿不匹配，已拒绝应用',
  'proposal.title': '增强建议',
  'proposal.description': '确认差异后再替换当前草稿；不会自动发送。',
  'proposal.close': '关闭增强建议',
  'proposal.assumptions': '新增假设',
  'proposal.questions': '待确认问题',
  'proposal.cancel': '取消',
  'proposal.accept': '接受增强',
  'proposal.applied': '已应用增强结果',
  'proposal.undo': '撤销增强',
  'proposal.undone': '已撤销增强结果',
} satisfies Record<string, string>

/** Locale key union. */
export type PromptEnhancementKey = keyof typeof zh

/** English dictionary, complete against the Chinese key set. */
export const en = {
  'button.label': 'Enhance prompt',
  'button.busy': 'Enhancing prompt',
  'button.cancel': 'Cancel prompt enhancement',
  'button.cancelling': 'Cancelling prompt enhancement',
  'draft.changed': 'The draft changed, so the enhancement was not applied',
  'result.mismatch': 'The enhancement result did not match this draft and was rejected',
  'proposal.title': 'Enhancement proposal',
  'proposal.description': 'Review the diff before replacing the draft. Nothing is submitted automatically.',
  'proposal.close': 'Close enhancement proposal',
  'proposal.assumptions': 'New assumptions',
  'proposal.questions': 'Open questions',
  'proposal.cancel': 'Cancel',
  'proposal.accept': 'Accept enhancement',
  'proposal.applied': 'Enhancement applied',
  'proposal.undo': 'Undo enhancement',
  'proposal.undone': 'Enhancement undone',
} satisfies Record<PromptEnhancementKey, string>
