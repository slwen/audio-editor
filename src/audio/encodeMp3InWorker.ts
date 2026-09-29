import type { Mp3Request, Mp3Response } from './mp3Messages'

export type ExportOptions = {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

// One chunk in flight bounds memory and gives the UI a turn between copies.
const CHUNK_SAMPLES = 1152 * 128

export function encodeMp3InWorker(buffer: AudioBuffer, options: ExportOptions = {}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = options
    const cancelled = () => new DOMException('Export cancelled', 'AbortError')
    if (signal?.aborted) { reject(cancelled()); return }
    const worker = new Worker(new URL('./encodeMp3.worker.ts', import.meta.url), { type: 'module' })
    let offset = 0
    let progressAt = -Infinity
    const cleanup = () => {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const abort = () => fail(cancelled())
    signal?.addEventListener('abort', abort, { once: true })
    const send = (message: Mp3Request, transfer: Transferable[] = []) => worker.postMessage(message, transfer)
    worker.onerror = () => fail(new Error('MP3 encoder failed'))
    worker.onmessage = (event: MessageEvent<Mp3Response>) => {
      const message = event.data
      if (message.kind === 'error') { fail(new Error(message.error)); return }
      if (message.kind === 'done') { cleanup(); onProgress?.(1); resolve(message.blob); return }
      const now = performance.now()
      if (now - progressAt >= 250) { onProgress?.(offset / Math.max(1, buffer.length)); progressAt = now }
      if (offset >= buffer.length) { send({ kind: 'finish' }); return }
      const end = Math.min(buffer.length, offset + CHUNK_SAMPLES)
      // Transfer owned copies, never the AudioBuffer's playback storage.
      const left = buffer.getChannelData(0).slice(offset, end)
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(offset, end) : undefined
      offset = end
      send({ kind: 'chunk', left, right }, right ? [left.buffer, right.buffer] : [left.buffer])
    }
    send({ kind: 'init', channels: Math.min(2, Math.max(1, buffer.numberOfChannels)), sampleRate: buffer.sampleRate, bitrateKbps: 128 })
  })
}
