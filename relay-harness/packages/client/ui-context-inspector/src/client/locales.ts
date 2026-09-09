/** Simplified-Chinese Context Inspector dictionary. */
export const zh = {
  open: '查看本次使用的上下文', title: '上下文检查器', empty: '当前会话还没有 durable context/prepared 记录。',
  omitted: '更早的 {count} 条 trace 已从有界投影中省略。', step: 'Turn {turn} / Step {step}',
  summary: '{contributors} 个贡献 · {evidence} 条证据 · {rejected} 个未采纳贡献', admitted: '已进入模型', rejected: '未采纳或被改写',
  evidence: '证据', noEvidence: '没有证据记录', coverage: '检索覆盖', searched: '已检索', notSearched: '未检索',
  linked: '关联 user/message', noLink: '没有关联 user/message；该贡献未进入模型或被后续 waterfall 改写。', why: '使用原因', close: '关闭',
  badge: '上下文 {count}', tracePrepared: 'context/prepared #{seq}', truncated: '已截断',
} as const
/** English Context Inspector dictionary. */
export const en = {
  open: 'Inspect context used for this session', title: 'Context Inspector', empty: 'No durable context/prepared trace is available for this session.',
  omitted: '{count} older traces were omitted from the bounded projection.', step: 'Turn {turn} / Step {step}',
  summary: '{contributors} contributions · {evidence} evidence · {rejected} rejected', admitted: 'Model-admitted', rejected: 'Rejected or rewritten',
  evidence: 'Evidence', noEvidence: 'No evidence records', coverage: 'Retrieval coverage', searched: 'Searched', notSearched: 'Not searched',
  linked: 'Linked user/message', noLink: 'No linked user/message; this contribution was rejected or rewritten by the later waterfall.', why: 'Why used', close: 'Close',
  badge: 'Context {count}', tracePrepared: 'context/prepared #{seq}', truncated: 'truncated',
} as const
/** Closed Context Inspector locale key set. */
export type ContextInspectorLocaleKey = keyof typeof en
