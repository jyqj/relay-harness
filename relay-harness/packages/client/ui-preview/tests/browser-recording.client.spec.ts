// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPreviewShell } from '../src/client/shell.ts'

const {
  frameSubscription,
  onPreviewRecordingFrame,
  previewSaveRecording,
  previewStartRecording,
  previewStopRecording,
} = vi.hoisted(() => {
  type Frame = {
    readonly id: string
    readonly data: string
    readonly width: number
    readonly height: number
  }
  const frameSubscription: { listener: ((frame: Frame) => void) | null } = { listener: null }
  return {
    frameSubscription,
    onPreviewRecordingFrame: vi.fn((listener: (frame: Frame) => void) => {
      frameSubscription.listener = listener
      return () => {
        if (frameSubscription.listener === listener) frameSubscription.listener = null
      }
    }),
    previewSaveRecording: vi.fn(async () => ({ ok: true, path: '/tmp/recording-test.webm' })),
    previewStartRecording: vi.fn(async (id: string) => {
      frameSubscription.listener?.({
        id,
        data: 'initial-frame',
        width: 800,
        height: 600,
      })
      return { ok: true }
    }),
    previewStopRecording: vi.fn(async () => ({ ok: true })),
  }
})

import {
  startBrowserRecording,
  stopBrowserRecording,
} from '../src/client/browserRecording.ts'

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true
  }

  state: RecordingState = 'inactive'
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    for (const listener of this.listeners.get('stop') ?? []) {
      if (typeof listener === 'function') listener(new Event('stop'))
      else listener.handleEvent(new Event('stop'))
    }
  }
}

function recordingBridge() {
  return {
    previewStartRecording,
    previewStopRecording,
    onPreviewRecordingFrame,
    previewSaveRecording,
  }
}

describe('browser recording', () => {
  beforeEach(() => {
    frameSubscription.listener = null
    vi.clearAllMocks()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    class ImmediateImage {
      private loadListener: EventListenerOrEventListenerObject | undefined

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === 'load') this.loadListener = listener
      }

      set src(_value: string) {
        const event = new Event('load')
        if (typeof this.loadListener === 'function') this.loadListener(event)
        else this.loadListener?.handleEvent(event)
      }
    }
    vi.stubGlobal('Image', ImmediateImage)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('draws the first frame and saves an artifact on stop', async () => {
    const stopTrack = vi.fn()
    const drawImage = vi.fn()
    const fillRect = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      getContext: () => ({ drawImage, fillRect, fillStyle: '' }),
    }
    // oxlint-disable-next-line typescript/unbound-method, typescript/no-deprecated -- delegates non-canvas tags to the native factory
    const nativeCreateElement = Document.prototype.createElement
    vi.spyOn(document, 'createElement').mockImplementation(function createElement(
      this: Document,
      tag: string,
      options?: ElementCreationOptions,
    ) {
      if (tag === 'canvas') return canvas as unknown as HTMLCanvasElement
      return nativeCreateElement.call(this, tag, options)
    })

    const started = await startBrowserRecording('pv-1', recordingBridge())
    expect(started.ok).toBe(true)
    expect(previewStartRecording).toHaveBeenCalledWith('pv-1')
    expect(canvas).toMatchObject({ width: 800, height: 600 })
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600)
    expect(fillRect).toHaveBeenCalledWith(0, 0, 800, 600)

    await stopBrowserRecording('pv-1')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(previewStopRecording).toHaveBeenCalled()
    expect(previewSaveRecording).toHaveBeenCalledWith('pv-1', expect.objectContaining({
      mimeType: expect.stringContaining('webm') as string,
      data: expect.any(ArrayBuffer) as ArrayBuffer,
    }))
  })

  it.each(['construct', 'unsupported-mime', 'start', 'stop-host', 'stop-declined', 'save', 'save-declined'] as const)('releases captured tracks after a %s failure', async (failure) => {
    const stopTrack = vi.fn()
    const canvas = { width: 0, height: 0,
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    if (failure === 'unsupported-mime') vi.spyOn(FakeMediaRecorder, 'isTypeSupported').mockReturnValue(false)
    if (failure === 'construct' || failure === 'unsupported-mime') {
      vi.stubGlobal('MediaRecorder', class extends FakeMediaRecorder {
        constructor() { super(); throw new Error('fixture constructor failure') }
      })
    } else if (failure === 'start') {
      vi.spyOn(FakeMediaRecorder.prototype, 'start').mockImplementationOnce(() => { throw new Error('fixture start failure') })
    } else if (failure === 'stop-declined') {
      previewStopRecording.mockResolvedValueOnce({ ok: false })
    } else if (failure === 'stop-host') {
      previewStopRecording.mockRejectedValueOnce(new Error('fixture stop failure'))
    } else if (failure === 'save-declined') {
      previewSaveRecording.mockResolvedValueOnce({ ok: false, path: '' })
    } else {
      previewSaveRecording.mockRejectedValueOnce(new Error('fixture save failure'))
    }
    if (failure === 'construct' || failure === 'unsupported-mime' || failure === 'start') {
      await expect(startBrowserRecording('failure-preview', recordingBridge())).rejects.toMatchObject({
        operation: failure === 'start' ? 'start-media-recorder' : 'initialize-media-recorder',
      })
    } else {
      await startBrowserRecording('failure-preview', recordingBridge())
      await expect(stopBrowserRecording('failure-preview')).rejects.toMatchObject({
        operation: failure === 'stop-host' || failure === 'stop-declined' ? 'stop-screencast' : 'save-artifact',
      })
    }
    if (failure === 'stop-declined') expect(previewSaveRecording).not.toHaveBeenCalled()
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(frameSubscription.listener).toBeNull()
    await expect(stopBrowserRecording('failure-preview')).resolves.toEqual({ ok: true })
    expect(stopTrack).toHaveBeenCalledTimes(1)
  })

  it.each(['early-frame', 'no-frame', 'stop-declined', 'stop-rejected'] as const)('does not resurrect abandoned startup after late IPC: %s', async (scenario) => {
    const earlyFrame = scenario !== 'no-frame'
    const stopFailure = scenario === 'stop-declined' || scenario === 'stop-rejected'
    vi.useFakeTimers()
    const late = Promise.withResolvers<{ ok: boolean }>()
    const stopTrack = vi.fn()
    const captureStream = vi.fn(() => ({ getTracks: () => [{ stop: stopTrack }] }))
    const canvas = { width: 0, height: 0, captureStream,
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    previewStartRecording.mockImplementationOnce((id) => {
      if (earlyFrame) frameSubscription.listener?.({ id, data: 'early-frame', width: 800, height: 600 })
      return late.promise
    })
    const abandoned = startBrowserRecording('restart-preview', recordingBridge()).then(
      value => ({ value }), (error: unknown) => ({ error }),
    )
    try {
      if (scenario === 'stop-declined') previewStopRecording.mockResolvedValueOnce({ ok: false })
      if (scenario === 'stop-rejected') previewStopRecording.mockRejectedValueOnce(new Error('Host stop unavailable'))
      const stopping = stopBrowserRecording('restart-preview')
      const stopped = expect(stopping).rejects.toMatchObject({ operation: stopFailure ? 'stop-screencast' : 'wait-startup' })
      await vi.advanceTimersByTimeAsync(5000)
      await stopped
      if (stopFailure) {
        await expect(stopping).rejects.toMatchObject({ cause: { errors: [
          expect.objectContaining({ operation: 'wait-startup' }), expect.any(Error),
        ] } })
      }
      expect(previewStopRecording).toHaveBeenCalledTimes(1)
      expect(previewStopRecording).toHaveBeenCalledWith('restart-preview')
      expect(frameSubscription.listener).toBeNull()
      await startBrowserRecording('restart-preview', recordingBridge())
      expect(captureStream).toHaveBeenCalledTimes(1)
      const currentSubscription = frameSubscription.listener
      late.resolve({ ok: true })
      expect(await abandoned).toMatchObject({ error: { operation: 'wait-startup' } })
      expect(captureStream).toHaveBeenCalledTimes(1)
      expect(frameSubscription.listener).toBe(currentSubscription)
      expect(previewStopRecording).toHaveBeenCalledTimes(1)
    } finally {
      late.resolve({ ok: true })
      await abandoned
      await stopBrowserRecording('restart-preview')
      vi.useRealTimers()
    }
    expect(stopTrack).toHaveBeenCalledTimes(1)
  })

  it('times out without valid frame dimensions, cancels capture, and permits a fresh recording', async () => {
    vi.useFakeTimers()
    const stopTrack = vi.fn()
    const captureStream = vi.fn(() => ({ getTracks: () => [{ stop: stopTrack }] }))
    const drawImage = vi.fn()
    const canvas = { width: 0, height: 0, captureStream,
      getContext: () => ({ drawImage, fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    previewStartRecording.mockImplementationOnce(async (id) => {
      for (const [width, height] of [[0, 600], [800, -1], [NaN, 600], [800, Infinity]]) {
        frameSubscription.listener?.({ id, data: 'invalid-dimensions', width: width!, height: height! })
      }
      frameSubscription.listener?.({ id: 'unrelated-preview', data: 'wrong-owner', width: 800, height: 600 })
      return { ok: true }
    })
    try {
      const started = startBrowserRecording('frame-timeout', recordingBridge())
      const failed = expect(started).rejects.toMatchObject({ operation: 'wait-first-frame' })
      await vi.advanceTimersByTimeAsync(5000)
      await failed
      expect(captureStream).not.toHaveBeenCalled()
      expect(drawImage).not.toHaveBeenCalled()
      expect(previewStopRecording).toHaveBeenCalledWith('frame-timeout')
      expect(frameSubscription.listener).toBeNull()
      await expect(startBrowserRecording('frame-timeout', recordingBridge())).resolves.toEqual({ ok: true })
      expect(captureStream).toHaveBeenCalledTimes(1)
    } finally {
      await stopBrowserRecording('frame-timeout')
      vi.useRealTimers()
    }
    expect(stopTrack).toHaveBeenCalledTimes(1)
  })

  it('shares a pending stop and refuses another start until the artifact save settles', async () => {
    const saved = Promise.withResolvers<{ ok: boolean; path: string }>()
    const stopTrack = vi.fn()
    const canvas = { width: 0, height: 0,
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    previewSaveRecording.mockReturnValueOnce(saved.promise)
    await startBrowserRecording('saving-preview', recordingBridge())
    await expect(startBrowserRecording('saving-preview', recordingBridge())).resolves.toEqual({ ok: true })
    expect(previewStartRecording).toHaveBeenCalledTimes(1)
    const stopping = stopBrowserRecording('saving-preview')
    try {
      expect(stopBrowserRecording('saving-preview')).toBe(stopping)
      await expect(startBrowserRecording('saving-preview', recordingBridge())).rejects.toMatchObject({
        name: 'BrowserRecordingConflictError', requestedId: 'saving-preview', activeId: 'saving-preview',
      })
      await vi.waitFor(() => { expect(previewSaveRecording).toHaveBeenCalledTimes(1) })
      saved.resolve({ ok: true, path: '/tmp/saved-fixture.webm' })
      await expect(stopping).resolves.toEqual({ ok: true, path: '/tmp/saved-fixture.webm' })
      expect(stopTrack).toHaveBeenCalledTimes(1)
      expect(frameSubscription.listener).toBeNull()
    } finally {
      saved.resolve({ ok: true, path: '/tmp/saved-fixture.webm' })
      await stopping
    }
  })

  it.each(['decoded', 'timeout'] as const)('waits for actual first-frame drawing: %s', async (outcome) => {
    vi.useFakeTimers()
    let loaded: (() => void) | undefined
    vi.stubGlobal('Image', class {
      addEventListener(_type: string, listener: () => void): void { loaded = listener }
      set src(_value: string) {}
    })
    const stopTrack = vi.fn()
    const captureStream = vi.fn(() => ({ getTracks: () => [{ stop: stopTrack }] }))
    const drawImage = vi.fn()
    const canvas = { width: 0, height: 0, captureStream,
      getContext: () => ({ drawImage, fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    const starting = startBrowserRecording('delayed-image', recordingBridge())
    const observed = starting.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(canvas).toMatchObject({ width: 800, height: 600 })
      expect(loaded).toBeDefined()
      expect(captureStream).not.toHaveBeenCalled()
      expect(drawImage).not.toHaveBeenCalled()
      if (outcome === 'decoded') {
        loaded!()
        expect(await observed).toEqual({ value: { ok: true } })
        expect(drawImage).toHaveBeenCalledTimes(1)
        expect(captureStream).toHaveBeenCalledTimes(1)
      } else {
        await vi.advanceTimersByTimeAsync(5000)
        expect(await observed).toMatchObject({ error: { operation: 'wait-first-frame' } })
        expect(previewStopRecording).toHaveBeenCalledWith('delayed-image')
        expect(frameSubscription.listener).toBeNull()
        loaded!()
        expect(drawImage).not.toHaveBeenCalled()
        expect(captureStream).not.toHaveBeenCalled()
      }
    } finally {
      loaded?.()
      await observed
      await stopBrowserRecording('delayed-image')
      vi.useRealTimers()
    }
    expect(stopTrack).toHaveBeenCalledTimes(outcome === 'decoded' ? 1 : 0)
  })

  it.each(['subscribe', 'start-rejected', 'start-declined', 'canvas', 'missing-bridge'] as const)('rolls back %s startup failure and allows retry', async (failure) => {
    const stopTrack = vi.fn()
    const captureStream = vi.fn(() => ({ getTracks: () => [{ stop: stopTrack }] }))
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }
    const getContext = vi.fn((): typeof context | null => context)
    const canvas = { width: 0, height: 0, captureStream, getContext }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    if (failure === 'canvas') getContext.mockReturnValueOnce(null)
    if (failure === 'subscribe') onPreviewRecordingFrame.mockImplementationOnce(() => { throw new Error('Subscription unavailable') })
    if (failure === 'start-rejected') previewStartRecording.mockRejectedValueOnce(new Error('Host unavailable'))
    if (failure === 'start-declined') previewStartRecording.mockResolvedValueOnce({ ok: false })
    await expect(startBrowserRecording('admission-preview', failure === 'missing-bridge' ? readPreviewShell() : recordingBridge())).rejects.toMatchObject(
      failure === 'canvas'
        ? { name: 'BrowserRecordingCanvasUnavailableError', width: 1280, height: 800 }
        : { operation: failure === 'subscribe' ? 'subscribe-frames' : 'start-screencast' },
    )
    expect(captureStream).not.toHaveBeenCalled()
    expect(frameSubscription.listener).toBeNull()
    expect(previewSaveRecording).not.toHaveBeenCalled()
    await expect(startBrowserRecording('admission-preview', recordingBridge())).resolves.toEqual({ ok: true })
    await stopBrowserRecording('admission-preview')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(frameSubscription.listener).toBeNull()
  })

  it.each([false, true])('preserves encoded chunk order and cleans up after recorder stop failure=%s', async (stopFails) => {
    const stopTrack = vi.fn()
    const canvas = { width: 0, height: 0,
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    vi.stubGlobal('MediaRecorder', class extends FakeMediaRecorder {
      private dataListener: EventListenerOrEventListenerObject | undefined
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        super.addEventListener(type, listener)
        if (type === 'dataavailable') this.dataListener = listener
      }
      override stop(): void {
        if (stopFails) throw new Error('Encoder stop failed')
        for (const data of [new Blob(['first']), new Blob([]), new Blob(['second'])]) {
          const event = Object.assign(new Event('dataavailable'), { data })
          if (typeof this.dataListener === 'function') this.dataListener(event)
          else this.dataListener?.handleEvent(event)
        }
        super.stop()
      }
    })
    let encoded: ArrayBuffer | undefined
    const bridge = { ...recordingBridge(), previewSaveRecording: vi.fn(async (_id: string, input: { data: ArrayBuffer }) => {
      encoded = input.data
      return { ok: true }
    }) }
    await startBrowserRecording('encoder-preview', bridge)
    if (stopFails) {
      await expect(stopBrowserRecording('encoder-preview')).rejects.toMatchObject({ operation: 'stop-media-recorder' })
      expect(bridge.previewSaveRecording).not.toHaveBeenCalled()
    } else {
      await expect(stopBrowserRecording('encoder-preview')).resolves.toEqual({ ok: true })
      expect(encoded).toBeDefined()
      expect(new TextDecoder().decode(encoded)).toBe('firstsecond')
      expect(bridge.previewSaveRecording).toHaveBeenCalledTimes(1)
    }
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(frameSubscription.listener).toBeNull()
    await expect(stopBrowserRecording('encoder-preview')).resolves.toEqual({ ok: true })
  })

  it('draws the newest decoded frame and ignores an older late decode without resizing the encoder', async () => {
    const decodes: Array<() => void> = []
    vi.stubGlobal('Image', class {
      addEventListener(_type: string, listener: () => void): void { decodes.push(listener) }
      set src(_value: string) {}
    })
    const drawImage = vi.fn()
    const canvas = { width: 0, height: 0,
      captureStream: () => ({ getTracks: () => [] }),
      getContext: () => ({ drawImage, fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    const starting = startBrowserRecording('frame-order', recordingBridge())
    frameSubscription.listener?.({ id: 'frame-order', data: 'newer', width: 1600, height: 900 })
    try {
      decodes[1]!()
      await starting
      expect(drawImage).toHaveBeenCalledTimes(1)
      expect(drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 75, 800, 450)
      decodes[0]!()
      expect(drawImage).toHaveBeenCalledTimes(1)
      expect(canvas).toMatchObject({ width: 800, height: 600 })
    } finally {
      decodes[1]?.()
      await starting
      await stopBrowserRecording('frame-order')
    }
  })

  it.each(['success', 'failure'] as const)('finishes a concurrent stop when pending startup settles with %s', async (outcome) => {
    const ready = Promise.withResolvers<{ ok: boolean }>()
    const stopTrack = vi.fn()
    const canvas = { width: 0, height: 0,
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }),
    }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
    previewStartRecording.mockImplementationOnce((id) => {
      frameSubscription.listener?.({ id, data: 'first', width: 800, height: 600 })
      return ready.promise
    })
    const starting = startBrowserRecording('pending-stop', recordingBridge()).then(
      value => ({ value }), (error: unknown) => ({ error }),
    )
    const stopping = stopBrowserRecording('pending-stop')
    expect(stopBrowserRecording('pending-stop')).toBe(stopping)
    ready.resolve({ ok: outcome === 'success' })
    if (outcome === 'success') expect(await starting).toEqual({ value: { ok: true } })
    else expect(await starting).toMatchObject({ error: { operation: 'start-screencast' } })
    expect((await stopping).ok).toBe(true)
    expect(previewSaveRecording).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
    expect(stopTrack).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
    expect(frameSubscription.listener).toBeNull()
  })

  it('keeps the shared frame subscription until every active preview recording stops', async () => {
    const stopTrack = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation(() => ({ width: 0, height: 0,
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }),
    }) as unknown as HTMLCanvasElement)
    await startBrowserRecording('first-owner', recordingBridge())
    await startBrowserRecording('second-owner', recordingBridge())
    try {
      expect(onPreviewRecordingFrame).toHaveBeenCalledTimes(1)
      const shared = frameSubscription.listener
      await stopBrowserRecording('first-owner')
      expect(frameSubscription.listener).toBe(shared)
      expect(stopTrack).toHaveBeenCalledTimes(1)
      await stopBrowserRecording('second-owner')
      expect(frameSubscription.listener).toBeNull()
      expect(stopTrack).toHaveBeenCalledTimes(2)
    } finally {
      await stopBrowserRecording('first-owner')
      await stopBrowserRecording('second-owner')
    }
  })

})
