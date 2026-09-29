import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodeMp3InWorker } from './encodeMp3InWorker'
import type { Mp3Request, Mp3Response } from './mp3Messages'

class WorkerStub {
  static instance: WorkerStub
  onmessage: ((event: MessageEvent<Mp3Response>) => void) | null = null
  onerror: (() => void) | null = null
  messages: Mp3Request[] = []
  terminate = vi.fn()
  constructor() { WorkerStub.instance = this }
  postMessage(request: Mp3Request, transfer: Transferable[] = []) {
    this.messages.push(structuredClone(request, { transfer }))
  }
  emit(response: Mp3Response) { this.onmessage?.({ data: response } as MessageEvent<Mp3Response>) }
}
beforeEach(() => vi.stubGlobal('Worker', WorkerStub))
afterEach(() => vi.unstubAllGlobals())

it('transfers one owned chunk at a time, preserves playback PCM and finishes with progress', async () => {
  const left = new Float32Array(1152 * 129).fill(0.25)
  const right = new Float32Array(left.length).fill(-0.5)
  const buffer = { length: left.length, numberOfChannels: 2, sampleRate: 48000,
    getChannelData: (channel: number) => channel ? right : left } as AudioBuffer
  const progress = vi.fn()
  const result = encodeMp3InWorker(buffer, { onProgress: progress })
  const worker = WorkerStub.instance
  expect(worker.messages).toHaveLength(1)
  worker.emit({ kind: 'ready' })
  expect(worker.messages[1]).toMatchObject({ kind: 'chunk' })
  expect((worker.messages[1] as Extract<Mp3Request, { kind: 'chunk' }>).left).toHaveLength(1152 * 128)
  expect(left[0]).toBe(0.25)
  expect(right[0]).toBe(-0.5)
  worker.emit({ kind: 'ready' })
  worker.emit({ kind: 'ready' })
  expect(worker.messages.at(-1)).toEqual({ kind: 'finish' })
  const blob = new Blob(['mpeg'], { type: 'audio/mpeg' })
  worker.emit({ kind: 'done', blob })
  expect(await result).toBe(blob)
  expect(progress).toHaveBeenLastCalledWith(1)
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('cancellation terminates the encoder and settles the export', async () => {
  const controller = new AbortController()
  const result = encodeMp3InWorker({ numberOfChannels: 1, sampleRate: 48000 } as AudioBuffer, { signal: controller.signal })
  const check = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await check
  expect(WorkerStub.instance.terminate).toHaveBeenCalledOnce()
})
