/** Host-renderer MediaRecorder for Browser preview (frames arrive over IPC). */

/** How long a start waits for the first decoded, drawn frame. */
export const BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS = 5_000

/** How long a start waits for the frame size to stop changing before recording. */
export const BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS = 5_000

/** The step of the recording lifecycle a `BrowserRecordingOperationError` failed in. */
export type BrowserRecordingOperation =
  | 'initialize-media-recorder'
  | 'subscribe-frames'
  | 'start-media-recorder'
  | 'start-screencast'
  | 'stop-screencast'
  | 'wait-first-frame'
  | 'wait-startup'
  | 'stop-media-recorder'
  | 'save-artifact'
  | 'cleanup'

/** One screencast frame as it crosses IPC from the host. */
export interface PreviewRecordingFrame {
  /** Which preview the frame came from. */
  id: string
  /** The frame image, base64-encoded. */
  data: string
  /** The frame's width in device pixels. */
  width: number
  /** The frame's height in device pixels. */
  height: number
}

/** The host calls this recording needs, injected so the renderer stays testable. */
export interface BrowserRecordingBridge {
  /** Ask the host to begin screencasting one preview. */
  previewStartRecording: (id: string) => Promise<{ ok: boolean; message?: string }>
  /** Ask the host to stop screencasting; omitting the id stops whatever is active. */
  previewStopRecording: (id?: string) => Promise<{ ok: boolean; message?: string }>
  /** Subscribe to screencast frames; the return value unsubscribes. */
  onPreviewRecordingFrame: (handler: (frame: PreviewRecordingFrame) => void) => () => void
  /** Hand the encoded recording to the host to write, which answers with its path. */
  previewSaveRecording: (
    id: string,
    input: { mimeType: string; data: ArrayBuffer },
  ) => Promise<{ ok: boolean; path?: string; message?: string }>
}

/** Thrown when the same preview is asked to start while starting or stopping. */
export class BrowserRecordingConflictError extends Error {
  /** The preview whose request was refused. */
  readonly requestedId: string
  /** The preview whose startup or stop is still pending. */
  readonly activeId: string

  /**
   * @param requestedId - the preview whose request was refused.
   * @param activeId - the preview already recording.
   */
  constructor(requestedId: string, activeId: string) {
    super('Browser recording is already active.')
    this.name = 'BrowserRecordingConflictError'
    this.requestedId = requestedId
    this.activeId = activeId
  }
}

/**
 * Thrown when the frame size the screencast reported yields no drawable
 * canvas, so there is nothing for the encoder to capture.
 */
export class BrowserRecordingCanvasUnavailableError extends Error {
  /** The preview being recorded. */
  readonly previewId: string
  /** The frame width that produced no canvas. */
  readonly width: number
  /** The frame height that produced no canvas. */
  readonly height: number

  /**
   * @param previewId - the preview being recorded.
   * @param width - the frame width that produced no canvas.
   * @param height - the frame height that produced no canvas.
   */
  constructor(previewId: string, width: number, height: number) {
    super('Browser recording canvas is unavailable.')
    this.name = 'BrowserRecordingCanvasUnavailableError'
    this.previewId = previewId
    this.width = width
    this.height = height
  }
}

/**
 * Thrown when one step of the recording lifecycle fails, naming the step so a
 * report says where recording broke rather than only that it did.
 */
export class BrowserRecordingOperationError extends Error {
  /** The lifecycle step that failed. */
  readonly operation: BrowserRecordingOperation
  /** The preview being recorded. */
  readonly previewId: string
  /** Whatever the step threw, when it threw something. */
  override readonly cause: unknown

  /**
   * @param input - the failing step, its preview, and the underlying error.
   */
  constructor(input: { operation: BrowserRecordingOperation; previewId: string; cause?: unknown }) {
    super(`Browser recording operation ${input.operation} failed.`)
    this.name = 'BrowserRecordingOperationError'
    this.operation = input.operation
    this.previewId = input.previewId
    this.cause = input.cause
  }
}

type BrowserRecordingLifecycle =
  | { readonly phase: 'starting' }
  | { readonly phase: 'recording' }
  | {
    readonly phase: 'stopping'
    readonly stopPromise: Promise<{ ok: boolean; path?: string; message?: string }>
  }

interface ActiveRecording {
  readonly previewId: string
  readonly bridge: BrowserRecordingBridge
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
  readonly chunks: Blob[]
  readonly startupSettled: Promise<void>
  readonly firstFrameSize: Promise<'frame' | 'cancelled'>
  readonly settleFirstFrameSize: (outcome: 'frame' | 'cancelled') => void
  stream: MediaStream | null
  recorder: MediaRecorder | null
  mimeType: string | null
  frameSizeEstablished: boolean
  frameSequence: number
  lastDrawnFrameSequence: number
  lifecycle: BrowserRecordingLifecycle
}

const activeRecordings = new Map<string, ActiveRecording>()
let unsubscribeFrames: (() => void) | null = null

const preferredMimeType = (): string => {
  const candidates = ['video/webm', 'video/webm;codecs=vp9', 'video/mp4']
  return candidates.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm'
}

const drawFrame = (frame: PreviewRecordingFrame): void => {
  const recording = activeRecordings.get(frame.id)
  if (!recording) return
  if (
    !Number.isFinite(frame.width)
    || !Number.isFinite(frame.height)
    || frame.width <= 0
    || frame.height <= 0
  ) {
    return
  }
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  if (!recording.frameSizeEstablished) {
    recording.canvas.width = width
    recording.canvas.height = height
    recording.frameSizeEstablished = true
  }
  const frameSequence = ++recording.frameSequence
  const image = new Image()
  image.addEventListener(
    'load',
    () => {
      if (
        activeRecordings.get(frame.id) !== recording
        || frameSequence <= recording.lastDrawnFrameSequence
      ) {
        return
      }
      recording.lastDrawnFrameSequence = frameSequence
      const scale = Math.min(recording.canvas.width / width, recording.canvas.height / height)
      const targetWidth = width * scale
      const targetHeight = height * scale
      const targetX = (recording.canvas.width - targetWidth) / 2
      const targetY = (recording.canvas.height - targetHeight) / 2
      recording.context.fillStyle = '#000000'
      recording.context.fillRect(0, 0, recording.canvas.width, recording.canvas.height)
      recording.context.drawImage(image, targetX, targetY, targetWidth, targetHeight)
      recording.settleFirstFrameSize('frame')
    },
    { once: true },
  )
  image.src = `data:image/jpeg;base64,${frame.data}`
}

const stopMediaRecorder = async (recorder: MediaRecorder | null): Promise<void> => {
  if (!recorder || recorder.state === 'inactive') return
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () =>{  resolve() }, { once: true })
  })
  recorder.stop()
  await stopped
}

const clearActiveRecording = (recording: ActiveRecording): void => {
  if (activeRecordings.get(recording.previewId) !== recording) return
  recording.settleFirstFrameSize('cancelled')
  activeRecordings.delete(recording.previewId)
  for (const track of recording.stream?.getTracks() ?? []) track.stop()
  recording.stream = null
  if (activeRecordings.size === 0) {
    unsubscribeFrames?.()
    unsubscribeFrames = null
  }
}

const waitForFirstFrameSize = async (recording: ActiveRecording): Promise<boolean> => {
  if (recording.lastDrawnFrameSequence > 0) return true
  // Cleared without a null test: the executor assigns the timer synchronously, and
  // clearTimeout tolerates an unset handle.
  let timeout: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    recording.firstFrameSize,
    new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => { resolve('timeout') }, BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS)
    }),
  ])
  clearTimeout(timeout)
  return outcome === 'frame'
}

const waitForRecordingStartupToSettle = async (recording: ActiveRecording): Promise<void> => {
  // Cleared without a null test: the executor assigns the timer synchronously, and
  // clearTimeout tolerates an unset handle.
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      recording.startupSettled,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Browser recording startup did not settle.'))
        }, BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS)
      }),
    ])
  } catch (cause) {
    throw new BrowserRecordingOperationError({
      operation: 'wait-startup',
      previewId: recording.previewId,
      cause,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Start host MediaRecorder for one preview. Frames are JPEGs from main.
 * @param previewId - guest preview id
 * @param bridge - desktop IPC used for screencast + save
 * @returns `{ ok: true }` when recording
 */
export async function startBrowserRecording(
  previewId: string,
  bridge: BrowserRecordingBridge,
): Promise<{ ok: boolean; message?: string }> {
  const activeRecording = activeRecordings.get(previewId)
  if (activeRecording) {
    if (activeRecording.lifecycle.phase === 'recording') return { ok: true }
    throw new BrowserRecordingConflictError(previewId, activeRecording.previewId)
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 800
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new BrowserRecordingCanvasUnavailableError(previewId, canvas.width, canvas.height)
  }
  const chunks: Blob[] = []
  let settleStartup: (() => void) | undefined
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve
  })
  let settleFirstFrameSize: ((outcome: 'frame' | 'cancelled') => void) | undefined
  const firstFrameSize = new Promise<'frame' | 'cancelled'>((resolve) => {
    settleFirstFrameSize = resolve
  })
  const recording: ActiveRecording = {
    previewId,
    bridge,
    canvas,
    context,
    chunks,
    startupSettled,
    firstFrameSize,
    settleFirstFrameSize: outcome => settleFirstFrameSize?.(outcome),
    stream: null,
    recorder: null,
    mimeType: null,
    frameSizeEstablished: false,
    frameSequence: 0,
    lastDrawnFrameSequence: 0,
    lifecycle: { phase: 'starting' },
  }
  activeRecordings.set(previewId, recording)
  try {
    try {
      unsubscribeFrames ??= bridge.onPreviewRecordingFrame(drawFrame)
    } catch (cause) {
      clearActiveRecording(recording)
      throw new BrowserRecordingOperationError({
        operation: 'subscribe-frames',
        previewId,
        cause,
      })
    }
    try {
      const started = await bridge.previewStartRecording(previewId)
      if (!started.ok) {
        throw new Error(started.message ?? 'start recording failed')
      }
    } catch (cause) {
      clearActiveRecording(recording)
      throw new BrowserRecordingOperationError({
        operation: 'start-screencast',
        previewId,
        cause,
      })
    }
    const hasFirstFrame = await waitForFirstFrameSize(recording)
    if (activeRecordings.get(previewId) !== recording) {
      throw new BrowserRecordingOperationError({
        operation: 'wait-startup',
        previewId,
        cause: new Error('Browser recording startup was abandoned.'),
      })
    }
    if (!hasFirstFrame) {
      try {
        await bridge.previewStopRecording(previewId)
      } catch {
        // Drop the consumer even if stop IPC fails.
      }
      clearActiveRecording(recording)
      throw new BrowserRecordingOperationError({
        operation: 'wait-first-frame',
        previewId,
        cause: new Error('No valid recording frame arrived.'),
      })
    }

    let mimeType: string
    let recorder: MediaRecorder
    try {
      mimeType = preferredMimeType()
      recording.stream = canvas.captureStream(12)
      recorder = new MediaRecorder(recording.stream, {
        mimeType,
        videoBitsPerSecond: 4_000_000,
      })
      recording.mimeType = mimeType
      recording.recorder = recorder
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      })
    } catch (cause) {
      try {
        await bridge.previewStopRecording(previewId)
      } catch {
        // Drop the consumer even if stop IPC fails.
      }
      clearActiveRecording(recording)
      throw new BrowserRecordingOperationError({
        operation: 'initialize-media-recorder',
        previewId,
        cause,
      })
    }
    try {
      recorder.start(1_000)
    } catch (cause) {
      try {
        await bridge.previewStopRecording(previewId)
      } catch {
        // Drop the consumer even if stop IPC fails.
      }
      clearActiveRecording(recording)
      throw new BrowserRecordingOperationError({
        operation: 'start-media-recorder',
        previewId,
        cause,
      })
    }
    if (recording.lifecycle.phase === 'starting') {
      recording.lifecycle = { phase: 'recording' }
    }
    return { ok: true }
  } finally {
    settleStartup?.()
  }
}

const finalizeBrowserRecording = async (
  recording: ActiveRecording,
): Promise<{ ok: boolean; path?: string; message?: string }> => {
  const { previewId, bridge } = recording
  try {
    try {
      await waitForRecordingStartupToSettle(recording)
    } catch (startupError) {
      try {
        const stopped = await bridge.previewStopRecording(previewId)
        if (!stopped.ok) throw new Error(stopped.message ?? 'stop recording failed')
      } catch (stopError) {
        throw new BrowserRecordingOperationError({
          operation: 'stop-screencast', previewId,
          cause: new AggregateError([startupError, stopError], 'Startup and stop both failed.'),
        })
      }
      throw startupError
    }
    try {
      const stopped = await bridge.previewStopRecording(previewId)
      if (!stopped.ok) throw new Error(stopped.message ?? 'stop recording failed')
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: 'stop-screencast',
        previewId,
        cause,
      })
    }
    if (!recording.recorder || !recording.mimeType) return { ok: true }
    try {
      await stopMediaRecorder(recording.recorder)
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: 'stop-media-recorder',
        previewId,
        cause,
      })
    }
    try {
      const blob = new Blob(recording.chunks, { type: recording.mimeType })
      const saved = await bridge.previewSaveRecording(previewId, {
        mimeType: recording.mimeType,
        data: await blob.arrayBuffer(),
      })
      if (!saved.ok) {
        throw new Error(saved.message ?? 'save recording failed')
      }
      return saved.path === undefined ? { ok: true } : { ok: true, path: saved.path }
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: 'save-artifact',
        previewId,
        cause,
      })
    }
  } finally {
    try {
      await stopMediaRecorder(recording.recorder)
    } catch {
      // Recorder already stopped.
    }
    clearActiveRecording(recording)
  }
}

/**
 * Stop host MediaRecorder and save the webm/mp4 artifact.
 * @param previewId - guest preview id
 * @returns `{ ok: true }` even when already stopped
 */
export function stopBrowserRecording(
  previewId: string,
): Promise<{ ok: boolean; path?: string; message?: string }> {
  const recording = activeRecordings.get(previewId)
  if (!recording) return Promise.resolve({ ok: true })
  if (recording.lifecycle.phase === 'stopping') return recording.lifecycle.stopPromise
  const stopPromise = finalizeBrowserRecording(recording).catch((error: unknown) => {
    throw error
  })
  recording.lifecycle = { phase: 'stopping', stopPromise }
  return stopPromise
}
