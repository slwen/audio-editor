import { afterEach, expect, it, vi } from 'vitest'
import { ensureSoundTouchWorklet } from './ensureSoundTouchWorklet'
vi.mock('./ensureSoundTouchWorklet', () => ({ ensureSoundTouchWorklet: vi.fn() }))
vi.mock('@soundtouchjs/audio-worklet', () => ({ SoundTouchNode: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks() })

it('shares in-flight initialization instead of creating concurrent native audio contexts', async () => {
  let finish!: () => void
  vi.mocked(ensureSoundTouchWorklet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const gain = { connect: vi.fn() }
  const context = { createGain: () => gain, destination: {}, close: vi.fn() }
  const constructor = vi.fn(function () { return context })
  vi.stubGlobal('AudioContext', constructor)
  const { audioEngine } = await import('./AudioEngine')
  const first = audioEngine.init()
  const second = audioEngine.init()
  expect(constructor).toHaveBeenCalledOnce()
  finish()
  expect(await first).toBe(context)
  expect(await second).toBe(context)
  expect(await audioEngine.init()).toBe(context)
  expect(gain.connect).toHaveBeenCalledOnce()
})
