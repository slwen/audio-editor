import { createStore } from 'zustand/vanilla'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeAutosave } from './autosave'
import type { ProjectSnapshot } from '@/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const makeStore = () => createStore<ProjectSnapshot & { isPlaying: boolean }>(() => ({ clips: [], bufferMeta: [], playhead: 0, masterGain: 1, isPlaying: true }))

it('ignores playback ticks while saving edits during playback at the latest position', () => {
  const store = makeStore()
  const save = vi.fn()
  const unsubscribe = subscribeAutosave(store, save)
  for (let i = 0; i < 100; i++) store.setState({ playhead: i / 60 })
  expect(vi.getTimerCount()).toBe(0)
  store.setState({ masterGain: 0.7 })
  for (let i = 100; i < 130; i++) { store.setState({ playhead: i / 60 }); vi.advanceTimersByTime(17) }
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]![0]).toMatchObject({ masterGain: 0.7, isPlaying: true })
  store.setState({ isPlaying: false })
  vi.advanceTimersByTime(500)
  expect(save).toHaveBeenLastCalledWith(store.getState())
  unsubscribe()
})

it('bounds save delay during continuous edits and cancels pending work on cleanup', () => {
  const store = makeStore()
  const save = vi.fn()
  const unsubscribe = subscribeAutosave(store, save)
  for (let i = 0; i < 20; i++) { store.setState({ masterGain: i / 20 }); vi.advanceTimersByTime(100) }
  expect(save).toHaveBeenCalledOnce()
  store.setState({ masterGain: 1 })
  unsubscribe()
  vi.advanceTimersByTime(3000)
  expect(save).toHaveBeenCalledOnce()
})
