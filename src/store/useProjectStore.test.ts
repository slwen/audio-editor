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

it('duplicates a drag group in place, preserving spacing, audio settings and layer order', () => {
  const store = useProjectStore.getState()
  const a = store.addClipFromBuffer(buffer, 'a.wav', 1.137, 0)
  const b = store.addClipFromBuffer(buffer, 'b.wav', 4.283, 0)
  const c = store.addClipFromBuffer(buffer, 'c.wav', 2.719, 2)
  store.updateClip(a, { layerIndex: 2, trimStart: 0.1, trimEnd: 0.9, speed: 1.37, gain: 0.7,
    fadeInSec: 0.2, fadeOutSec: 0.3, label: 'edited' })
  store.updateClip(b, { layerIndex: 5 })
  store.setSelection([a, b, c])
  const originals = useProjectStore.getState().clips
  // Selection order must not change the stacking order of overlapping clips.
  const ids = store.duplicateClipsForDrag([c, b, a])
  const state = useProjectStore.getState()
  expect(state.clips).toHaveLength(6)
  expect(new Set(state.selection)).toEqual(new Set(Object.values(ids)))
  for (const original of originals) {
    const copy = state.clips.find((clip) => clip.id === ids[original.id])!
    expect(copy).toEqual({ ...original, id: copy.id, layerIndex: copy.layerIndex, accentColor: copy.accentColor })
    expect(copy.layerIndex).toBeGreaterThan(original.layerIndex)
    expect(state.clips.find((clip) => clip.id === original.id)).toEqual(original)
  }
  const copyA = state.clips.find((clip) => clip.id === ids[a])!
  const copyB = state.clips.find((clip) => clip.id === ids[b])!
  expect(copyA.layerIndex).toBeGreaterThan(5)
  expect(copyB.layerIndex).toBeGreaterThan(copyA.layerIndex)
})

it.each([1, 3])('undoes and redoes an entire %i-clip duplicate drag in one step', (count) => {
  const store = useProjectStore.getState()
  const sourceIds = Array.from({ length: count }, (_, i) => store.addClipFromBuffer(buffer, 'audio.wav', i * 2, i))
  const originals = useProjectStore.getState().clips
  const historySize = useProjectStore.getState().undoStack.length
  const ids = store.duplicateClipsForDrag(sourceIds)
  for (const source of originals) {
    store.updateClip(ids[source.id]!, { startTime: source.startTime + 3.017, row: source.row + 1 })
  }
  const placed = useProjectStore.getState().clips
  expect(useProjectStore.getState().undoStack).toHaveLength(historySize + 1)
  store.undo()
  expect(useProjectStore.getState().clips).toEqual(originals)
  store.redo()
  expect(useProjectStore.getState().clips).toEqual(placed)
})

it('ignores missing or repeated source ids without creating extra copies or empty undo entries', () => {
  const store = useProjectStore.getState()
  const id = store.addClipFromBuffer(buffer, 'audio.wav', 0, 0)
  const historySize = useProjectStore.getState().undoStack.length
  expect(store.duplicateClipsForDrag(['missing'])).toEqual({})
  expect(useProjectStore.getState().undoStack).toHaveLength(historySize)
  expect(Object.keys(store.duplicateClipsForDrag([id, id, 'missing']))).toEqual([id])
  expect(useProjectStore.getState().clips).toHaveLength(2)
})
