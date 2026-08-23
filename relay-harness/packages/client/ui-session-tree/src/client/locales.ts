/** Session Tree locale namespace. */
export const NS = 'sessionTree' as const

/** Keys rendered by the native Tree action and canvas. */
export type SessionTreeKey =
  | 'open' | 'title' | 'conversation' | 'search' | 'newSession' | 'focusCurrent'
  | 'resetLayout' | 'zoomIn' | 'zoomOut' | 'loading' | 'empty' | 'fork' | 'rewrite'
  | 'continue' | 'archive' | 'label' | 'messageDraft' | 'send' | 'tools' | 'branchAt'
  | 'running' | 'blank' | 'turn' | 'openSession' | 'expand' | 'collapse' | 'moveCard' | 'filterAria' | 'titlebarOpen'
  | 'filters.default' | 'filters.no-tools' | 'filters.user-only' | 'filters.labeled-only' | 'filters.all'

/** Chinese source dictionary. */
export const zh: Record<SessionTreeKey, string> = {
  open: '会话树', title: '会话树', conversation: '返回对话', search: '搜索会话、消息、工具或标签',
  newSession: '新会话', focusCurrent: '定位当前会话', resetLayout: '重置布局', zoomIn: '放大', zoomOut: '缩小',
  loading: '正在读取会话历史…', empty: '这个工作区还没有可显示的会话。', fork: '从此处分支', rewrite: '重写此问题',
  continue: '继续当前会话', archive: '归档会话', label: '标签', messageDraft: '输入继续或重写后的消息…',
  send: '发送', tools: '工具过程', branchAt: '分叉位置', 'filters.default': '默认', 'filters.no-tools': '隐藏工具',
  running: '运行中', blank: '新会话', turn: '轮次', openSession: '打开', expand: '展开', collapse: '折叠', moveCard: '移动卡片', filterAria: '会话树过滤模式', titlebarOpen: '打开会话树',
  'filters.user-only': '仅问题', 'filters.labeled-only': '仅标签', 'filters.all': '全部过程',
}

/** English dictionary with the same complete key set. */
export const en: Record<SessionTreeKey, string> = {
  open: 'Session Tree', title: 'Session Tree', conversation: 'Back to conversation', search: 'Search sessions, messages, tools, or labels',
  newSession: 'New session', focusCurrent: 'Focus current session', resetLayout: 'Reset layout', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
  loading: 'Loading session history…', empty: 'No sessions are available in this workspace.', fork: 'Fork here', rewrite: 'Rewrite this question',
  continue: 'Continue this session', archive: 'Archive session', label: 'Label', messageDraft: 'Enter a continuation or replacement message…',
  send: 'Send', tools: 'Tool process', branchAt: 'Fork cut', 'filters.default': 'Default', 'filters.no-tools': 'Hide tools',
  running: 'Running', blank: 'New session', turn: 'Turn', openSession: 'Open', expand: 'Expand', collapse: 'Collapse', moveCard: 'Move card', filterAria: 'Session Tree filter mode', titlebarOpen: 'Open Session Tree',
  'filters.user-only': 'Questions only', 'filters.labeled-only': 'Labeled only', 'filters.all': 'All process',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session Tree product copy. */
    'sessionTree': SessionTreeKey
  }
}
