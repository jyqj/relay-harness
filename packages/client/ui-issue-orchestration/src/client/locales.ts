/** Locale namespace owned by the issue orchestration surface. */
export const NS = 'issueOrchestration' as const

/** Simplified-Chinese operator copy. */
export const zh = {
  open: '工单自动化', close: '关闭工单自动化', title: '工单自动化', refresh: '立即刷新',
  loading: '正在读取调度状态…', empty: '当前没有运行、重试或阻塞的工单。',
  running: '运行中', retrying: '等待重试', blocked: '需要处理', attempt: '第 {{attempt}} 次尝试',
  retry: '重试', release: '释放', openSession: '打开会话', workspace: '工作区', session: '会话',
  nextRetry: '下次重试', lastProgress: '最近进展', error: '错误', poll: '下次轮询',
  checking: '正在对账', ready: '等待轮询', workflow: '策略版本', loadFailed: '读取失败：{{message}}',
  actionFailed: '操作失败：{{message}}',
} as const

/** English operator copy with the same key set. */
export const en: Record<keyof typeof zh, string> = {
  open: 'Issue automation', close: 'Close issue automation', title: 'Issue automation', refresh: 'Refresh now',
  loading: 'Loading orchestration state…', empty: 'No running, retrying, or blocked issues.',
  running: 'Running', retrying: 'Retry queued', blocked: 'Needs attention', attempt: 'Attempt {{attempt}}',
  retry: 'Retry', release: 'Release', openSession: 'Open session', workspace: 'Workspace', session: 'Session',
  nextRetry: 'Next retry', lastProgress: 'Last progress', error: 'Error', poll: 'Next poll',
  checking: 'Reconciling', ready: 'Waiting for poll', workflow: 'Workflow revision', loadFailed: 'Load failed: {{message}}',
  actionFailed: 'Action failed: {{message}}',
}

/** Closed locale key set for slot typing. */
export type IssueOrchestrationKey = keyof typeof zh
