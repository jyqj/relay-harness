// Real Chromium encoder/decoder regression; no Host, credentials, or network.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import ts from 'typescript'

it('encodes preview frames into playable media and ends capture tracks on stop', async () => {
  // Read this dependency-free Client leaf without adding its project to the Host type graph.
  const source = await readFile(new URL('../../../packages/client/ui-preview/src/client/browserRecording.ts', import.meta.url), 'utf8')
  const moduleSource = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.addScriptTag({ type: 'module', content: `${moduleSource}\nwindow.__recording = { startBrowserRecording, stopBrowserRecording };` })
    const result = await page.evaluate(async () => {
      type Frame = { id: string; data: string; width: number; height: number }
      // Mirrors the private browserRecording.ts entry for this isolated browser module load.
      type Recorder = {
        startBrowserRecording: (id: string, bridge: {
          previewStartRecording: (id: string) => Promise<{ ok: boolean }>
          previewStopRecording: () => Promise<{ ok: boolean }>
          onPreviewRecordingFrame: (handler: (frame: Frame) => void) => () => void
          previewSaveRecording: (id: string, input: { mimeType: string; data: ArrayBuffer }) => Promise<{ ok: boolean }>
        }) => Promise<{ ok: boolean }>
        stopBrowserRecording: (id: string) => Promise<{ ok: boolean }>
      }
      const recording = (window as Window & { __recording?: Recorder }).__recording
      if (recording === undefined) throw new Error('Recording module did not load')
      const captured: MediaStream[] = []
      const initialPixels: number[][] = []
      // oxlint-disable-next-line typescript/unbound-method -- called with the original canvas receiver below
      const original = HTMLCanvasElement.prototype.captureStream
      HTMLCanvasElement.prototype.captureStream = function (rate?: number): MediaStream {
        initialPixels.push(Array.from(this.getContext('2d')!.getImageData(160, 90, 1, 1).data))
        const stream = original.call(this, rate)
        captured.push(stream)
        return stream
      }
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = 320
      sourceCanvas.height = 180
      const context = sourceCanvas.getContext('2d')!
      let listener: ((frame: Frame) => void) | undefined
      let timer: ReturnType<typeof setInterval> | undefined
      let artifact: Blob | undefined
      let frame = 0
      const emit = (id: string): void => {
        context.fillStyle = frame++ % 2 === 0 ? 'red' : 'blue'
        context.fillRect(0, 0, 320, 180)
        listener?.({ id, data: sourceCanvas.toDataURL('image/jpeg').split(',')[1]!, width: 320, height: 180 })
      }
      try {
        await recording.startBrowserRecording('real-encoder', {
          onPreviewRecordingFrame: (handler) => { listener = handler; return () => { listener = undefined } },
          previewStartRecording: async (id) => { emit(id); timer = setInterval(() => { emit(id) }, 40); return { ok: true } },
          previewStopRecording: async () => { clearInterval(timer); return { ok: true } },
          previewSaveRecording: async (_id, input) => { artifact = new Blob([input.data], { type: input.mimeType }); return { ok: true } },
        })
        await new Promise(resolve => setTimeout(resolve, 400))
        await recording.stopBrowserRecording('real-encoder')
        if (artifact === undefined) throw new Error('No encoded recording')
        const video = document.createElement('video')
        video.muted = true
        document.body.append(video)
        const url = URL.createObjectURL(artifact)
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { reject(new Error('Media decode timed out')) }, 5000)
            video.onloadeddata = () => { clearTimeout(timeout); resolve() }
            video.onerror = () => { clearTimeout(timeout); reject(new Error('Encoded media could not decode')) }
            video.src = url
            video.load()
          })
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { reject(new Error('No decoded video frame presented')) }, 5000)
            video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve() })
            void video.play().catch((error: unknown) => { clearTimeout(timeout); reject(new Error('Video playback failed', { cause: error })) })
          })
          video.pause()
          const decoded = document.createElement('canvas')
          decoded.width = video.videoWidth
          decoded.height = video.videoHeight
          const pixels = decoded.getContext('2d')!
          pixels.drawImage(video, 0, 0)
          const center = Array.from(pixels.getImageData(160, 90, 1, 1).data)
          return { bytes: artifact.size, width: video.videoWidth, height: video.videoHeight, center, initialPixels,
            tracks: captured.flatMap(stream => stream.getTracks().map(track => track.readyState)),
            subscribed: listener !== undefined, streams: captured.length }
        } finally {
          video.removeAttribute('src')
          video.load()
          video.remove()
          URL.revokeObjectURL(url)
        }
      } finally {
        clearInterval(timer)
        await recording.stopBrowserRecording('real-encoder')
        HTMLCanvasElement.prototype.captureStream = original
      }
    })
    expect(result.bytes).toBeGreaterThan(0)
    expect(Math.max(result.initialPixels[0]![0]!, result.initialPixels[0]![2]!)).toBeGreaterThan(150)
    expect(result).toMatchObject({ width: 320, height: 180, tracks: ['ended'], streams: 1, subscribed: false })
    expect(Math.max(result.center[0]!, result.center[2]!), JSON.stringify(result)).toBeGreaterThan(150)
    expect(result.center[1]).toBeLessThan(80)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 30_000)
