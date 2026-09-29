import type { ProjectSnapshot } from '@/types'

type SaveState = ProjectSnapshot & { isPlaying: boolean }
type SaveStore = {
  getState: () => SaveState
  subscribe: (listener: (state: SaveState, previous: SaveState) => void) => () => void
}

/** Ignore transport ticks. Edits save during playback, with a maximum wait. */
export function subscribeAutosave(store: SaveStore, save: (state: SaveState) => void): () => void {
  let debounce: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(debounce)
    clearTimeout(deadline)
    debounce = deadline = undefined
    save(store.getState())
  }
  const unsubscribe = store.subscribe((state, previous) => {
    const edited = state.clips !== previous.clips || state.bufferMeta !== previous.bufferMeta || state.masterGain !== previous.masterGain
    const positionChanged = (!state.isPlaying && state.playhead !== previous.playhead) || (previous.isPlaying && !state.isPlaying)
    if (!edited && !positionChanged) return
    clearTimeout(debounce)
    debounce = setTimeout(flush, 500)
    deadline ??= setTimeout(flush, 2000)
  })
  return () => { unsubscribe(); clearTimeout(debounce); clearTimeout(deadline) }
}
