// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readPreviewShell, type PreviewShellInjected } from '../src/client/shell.ts'

type AsyncKey = {
  [K in keyof PreviewShellInjected]-?: PreviewShellInjected[K] extends (...args: never[]) => Promise<unknown> ? K : never
}[keyof PreviewShellInjected]
type ForwardCase = { [K in AsyncKey]: { name: K; args: Parameters<PreviewShellInjected[K]> } }[AsyncKey]
const cases = [
  { name: 'previewOpen', args: [{ url: 'https://fixture.invalid', scope: '/fixture' }] },
  { name: 'previewNavigate', args: ['preview-a', 'https://fixture.invalid/next'] },
  { name: 'previewBack', args: ['preview-a'] },
  { name: 'previewForward', args: ['preview-a'] },
  { name: 'previewReload', args: ['preview-a'] },
  { name: 'previewHardReload', args: ['preview-a'] },
  { name: 'previewStop', args: ['preview-a'] },
  { name: 'previewZoomIn', args: ['preview-a'] },
  { name: 'previewZoomOut', args: ['preview-a'] },
  { name: 'previewResetZoom', args: ['preview-a'] },
  { name: 'previewSetColorScheme', args: ['preview-a', 'dark'] },
  { name: 'previewClearCookies', args: [] },
  { name: 'previewClearCache', args: [] },
  { name: 'previewCaptureScreenshot', args: ['preview-a'] },
  { name: 'previewOpenPictureInPicture', args: ['preview-a'] },
  { name: 'previewClosePictureInPicture', args: [] },
  { name: 'previewPickElement', args: ['preview-a'] },
  { name: 'previewCancelPick', args: ['preview-a'] },
  { name: 'previewStartRecording', args: ['preview-a'] },
  { name: 'previewStopRecording', args: [undefined] },
  { name: 'previewRevealArtifact', args: ['/fixture/output.png'] },
  { name: 'previewCopyArtifactToClipboard', args: ['/fixture/output.png'] },
  { name: 'previewAutomationStatus', args: ['preview-a'] },
  { name: 'previewAutomationSnapshot', args: ['preview-a'] },
  { name: 'previewAutomationClick', args: ['preview-a', { x: 3, y: 4 }] },
  { name: 'previewAutomationType', args: ['preview-a', { text: 'fixture text', selector: '#input' }] },
  { name: 'previewAutomationPress', args: ['preview-a', { key: 'Enter' }] },
  { name: 'previewAutomationScroll', args: ['preview-a', { x: 3, y: 4, deltaX: 5, deltaY: 6 }] },
  { name: 'previewAutomationEvaluate', args: ['preview-a', { expression: '1 + 1' }] },
  { name: 'previewAutomationWaitFor', args: ['preview-a', { selector: '#ready', timeoutMs: 10 }] },
  { name: 'previewState', args: ['preview-a'] },
  { name: 'previewOpenDevTools', args: ['preview-a'] },
] satisfies ForwardCase[]

afterEach(() => { delete (window as Window & { shell?: unknown }).shell })

it.each(cases)('forwards $name arguments and preserves the native receiver and reply', async ({ name, args }) => {
  const reply = { ok: true }
  const method = vi.fn(function (this: unknown, ...received: unknown[]) {
    expect(this).toBe(native)
    expect(received).toEqual(args)
    return Promise.resolve(reply)
  })
  const native = { previewOpen: vi.fn(), [name]: method }
  Object.assign(window, { shell: native })
  const face = readPreviewShell()
  expect(face.previewAvailable).toBe(true)
  // The table validates every parameter tuple before this invocation erases the union.
  const invoke = face[name] as (...input: unknown[]) => Promise<unknown>
  expect(await invoke(...args)).toBe(reply)
  expect(method).toHaveBeenCalledTimes(1)
})

it.each(cases)('returns an explicit unavailable result for absent $name', async ({ name, args }) => {
  const face = readPreviewShell()
  expect(face.previewAvailable).toBe(false)
  const invoke = face[name] as (...input: unknown[]) => Promise<unknown>
  expect(await invoke(...args)).toMatchObject({ ok: false })
})

it('forwards frame/state subscriptions and returns the native unsubscribe handles', () => {
  const offFrames = vi.fn()
  const offState = vi.fn()
  const onFrames = vi.fn(() => offFrames)
  const onState = vi.fn(() => offState)
  Object.assign(window, { shell: { onPreviewRecordingFrame: onFrames, onPreviewStateChange: onState } })
  const face = readPreviewShell()
  const frameHandler = vi.fn()
  const stateHandler = vi.fn()
  const disposeFrames = face.onPreviewRecordingFrame(frameHandler)
  const disposeState = face.onPreviewStateChange(stateHandler)
  expect(face.previewAvailable).toBe(false)
  expect(onFrames).toHaveBeenCalledWith(frameHandler)
  expect(onState).toHaveBeenCalledWith(stateHandler)
  expect(disposeFrames).toBe(offFrames)
  expect(disposeState).toBe(offState)
  disposeFrames()
  disposeState()
  expect(offFrames).toHaveBeenCalledTimes(1)
  expect(offState).toHaveBeenCalledTimes(1)
})

it('provides disposable inert subscriptions and an explanatory unavailable open result without a bridge', async () => {
  const face = readPreviewShell()
  expect(() => { face.onPreviewRecordingFrame(vi.fn())() }).not.toThrow()
  expect(() => { face.onPreviewStateChange(vi.fn())() }).not.toThrow()
  await expect(face.previewOpen({ url: 'https://fixture.invalid' })).resolves.toEqual({
    ok: false, message: 'Browser previews are only available in the desktop app.',
  })
})

type ReplyCase = { [K in AsyncKey]: {
  name: K
  args: Parameters<PreviewShellInjected[K]>
  reply: Awaited<ReturnType<PreviewShellInjected[K]>>
  fallback: Awaited<ReturnType<PreviewShellInjected[K]>>
} }[AsyncKey]
const remainingCases = [
  { name: 'previewSaveRecording', args: ['preview-a', { mimeType: 'video/webm', data: new ArrayBuffer(3) }],
    reply: { ok: true, path: '/fixture/recording.webm' }, fallback: { ok: false } },
  { name: 'previewSetAnnotationTheme', args: ['preview-a', {
    colorScheme: 'dark', radius: '4px', background: '#000', foreground: '#fff', popover: '#000', popoverForeground: '#fff',
    primary: '#fff', primaryForeground: '#000', muted: '#222', mutedForeground: '#ddd', accent: '#333', accentForeground: '#eee',
    border: '#444', input: '#555', ring: '#666', fontSans: 'sans-serif', fontMono: 'monospace',
  }], reply: { ok: true }, fallback: { ok: false } },
  { name: 'previewDiscover', args: [], reply: [{ url: 'http://127.0.0.1:3000', port: 3000 }], fallback: [] },
  { name: 'openExternal', args: ['https://fixture.invalid'], reply: undefined, fallback: undefined },
  { name: 'previewResize', args: ['preview-a', { x: 1, y: 2, width: 300, height: 200 }], reply: undefined, fallback: undefined },
  { name: 'previewHide', args: ['preview-a'], reply: undefined, fallback: undefined },
  { name: 'previewShow', args: ['preview-a', { x: 1, y: 2, width: 300, height: 200 }], reply: undefined, fallback: undefined },
  { name: 'previewClose', args: ['preview-a'], reply: undefined, fallback: undefined },
] satisfies ReplyCase[]

it.each(remainingCases)('forwards $name payload identity and native result', async ({ name, args, reply }) => {
  const method = vi.fn(function (this: unknown, ...received: unknown[]) {
    expect(this).toBe(native)
    expect(received).toHaveLength(args.length)
    for (const [index, value] of received.entries()) expect(value).toBe(args[index])
    return Promise.resolve(reply)
  })
  const native = { [name]: method }
  Object.assign(window, { shell: native })
  const invoke = readPreviewShell()[name] as (...input: unknown[]) => Promise<unknown>
  expect(await invoke(...args)).toBe(reply)
  expect(method).toHaveBeenCalledTimes(1)
})

it.each(remainingCases)('provides the declared fallback without $name', async ({ name, args, fallback }) => {
  const invoke = readPreviewShell()[name] as (...input: unknown[]) => Promise<unknown>
  expect(await invoke(...args)).toEqual(fallback)
})
