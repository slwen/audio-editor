import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/audio/AudioEngine', () => ({ audioEngine: { stop: vi.fn() } }))
import { useProjectStore } from './useProjectStore'
import { getCachedBuffer } from '@/audio/bufferCache'
import { getPeaks } from '@/lib/peaksCache'
import { getOriginalBytes } from '@/persistence/fileBytes'

beforeEach(() => useProjectStore.getState().resetProject())
afterEach(() => useProjectStore.getState().resetProject())
const buffer = { duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(256).fill(0.5) } as unknown as AudioBuffer

it('keeps deleted audio playable through undo/redo and releases it when history expires', () => {
  const bytes = new ArrayBuffer(12)
  const store = useProjectStore.getState()
  store.addClipFromBuffer(buffer, 'audio.wav', 0, 0, bytes)
  const bufferId = useProjectStore.getState().clips[0]!.bufferId
  store.deleteSelected()
  expect(useProjectStore.getState().clips).toHaveLength(0)
  expect(getCachedBuffer(bufferId)).toBe(buffer)
  store.undo()
  expect(useProjectStore.getState().clips[0]?.bufferId).toBe(bufferId)
  expect(getPeaks(bufferId)?.[1]).toBe(0.5)
  expect(getOriginalBytes(bufferId)).toBe(bytes)
  store.redo()
  for (let i = 0; i < 51; i++) store.pushUndo()
  expect(getCachedBuffer(bufferId)).toBeUndefined()
  expect(getPeaks(bufferId)).toBeUndefined()
  expect(getOriginalBytes(bufferId)).toBeUndefined()
})

it('releases an unreferenced source immediately when no history owns it', () => {
  const id = useProjectStore.getState().addClipFromBuffer(buffer, 'audio.wav', 0, 0, new ArrayBuffer(12))
  const bufferId = useProjectStore.getState().clips[0]!.bufferId
  useProjectStore.getState().removeClip(id)
  expect(getCachedBuffer(bufferId)).toBeUndefined()
  expect(getOriginalBytes(bufferId)).toBeUndefined()
})
