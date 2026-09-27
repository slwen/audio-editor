import { create } from 'zustand'
import { audioEngine } from '@/audio/AudioEngine'
import { cacheBuffer, clearBufferCache, removeCachedBuffer } from '@/audio/bufferCache'
import {
  clampFadeSeconds,
  clampLinearGain,
  clampPlaybackSpeed,
  clipTimelineDuration,
  clipTimelineEnd,
} from '@/lib/clipMath'
import { clearPeaks, removePeaks, setPeaksForBuffer } from '@/lib/peaksCache'
import {
  pickRandomAccentAvoiding,
  pickRandomTrackAccent,
  pickTwoDistinctTrackAccents,
  stableAccentForClipId,
} from '@/lib/trackAccent'
import { clearOriginalBytes, rememberOriginalBytes } from '@/persistence/fileBytes'
import type { BufferId, BufferMeta, Clip, ClipId, EditorMode, ProjectSnapshot } from '@/types'

const MAX_UNDO = 50

function cloneClips(clips: Clip[]): Clip[] {
  return clips.map((c) => ({ ...c }))
}

function cloneBufferMeta(meta: BufferMeta[]): BufferMeta[] {
  return meta.map((b) => ({ ...b }))
}

function snapshot(state: ProjectState): ProjectSnapshot {
  return {
    clips: cloneClips(state.clips),
    bufferMeta: cloneBufferMeta(state.bufferMeta),
    playhead: state.playhead,
    masterGain: state.masterGain,
  }
}

function restore(s: ProjectSnapshot): Pick<ProjectState, 'clips' | 'bufferMeta' | 'playhead' | 'masterGain'> {
  return {
    clips: cloneClips(s.clips),
    bufferMeta: cloneBufferMeta(s.bufferMeta),
    playhead: s.playhead,
    masterGain: s.masterGain,
  }
}

type ProjectState = {
  clips: Clip[]
  bufferMeta: BufferMeta[]
  selection: ClipId[]
  playhead: number
  isPlaying: boolean
  masterGain: number
  pixelsPerSecond: number
  scrollX: number
  editorMode: EditorMode
  undoStack: ProjectSnapshot[]
  redoStack: ProjectSnapshot[]
}

type ProjectActions = {
  pushUndo: () => void
  undo: () => void
  redo: () => void
  setPlayhead: (t: number) => void
  setIsPlaying: (v: boolean) => void
  setMasterGain: (g: number) => void
  setPixelsPerSecond: (pps: number) => void
  setScrollX: (x: number) => void
  selectOnly: (id: ClipId | null) => void
  toggleSelect: (id: ClipId) => void
  selectRangeFromAnchor: (anchorId: ClipId, targetId: ClipId) => void
  setSelection: (ids: ClipId[]) => void
  addClipFromBuffer: (
    buffer: AudioBuffer,
    name: string,
    startTime: number,
    row: number,
    persistOriginal?: ArrayBuffer
  ) => ClipId
  addClipOnExistingBuffer: (opts: {
    bufferId: BufferId
    label: string
    startTime: number
    row: number
    trimStart: number
    trimEnd: number
  }) => ClipId | null
  setEditorMode: (mode: EditorMode) => void
  updateClip: (id: ClipId, patch: Partial<Clip>) => void
  removeClip: (id: ClipId) => void
  deleteSelected: () => void
  duplicateSelected: () => void
  /** Same start/row as source, new id, stacked above via `layerIndex`. */
  duplicateClipForDrag: (sourceId: ClipId) => ClipId | null
  splitAt: (time: number, opts?: { onlyClipId?: ClipId; column?: boolean }) => void
  setClipGain: (id: ClipId, g: number) => void
  setAllClipGains: (g: number) => void
  setClipSpeed: (id: ClipId, s: number) => void
  setAllClipSpeeds: (s: number) => void
  setSpeedOnClips: (ids: ClipId[], s: number) => void
  setGainOnClips: (ids: ClipId[], g: number) => void
  setClipFadeIn: (id: ClipId, sec: number) => void
  setClipFadeOut: (id: ClipId, sec: number) => void
  resetProject: () => void
  loadSnapshot: (s: ProjectSnapshot) => void
}

const initialState: ProjectState = {
  clips: [],
  bufferMeta: [],
  selection: [],
  playhead: 0,
  isPlaying: false,
  masterGain: 1,
  pixelsPerSecond: 80,
  scrollX: 0,
  editorMode: 'edit',
  undoStack: [],
  redoStack: [],
}

export const useProjectStore = create<ProjectState & ProjectActions>((set, get) => ({
  ...initialState,

  pushUndo: () =>
    set((s) => {
      const snap = snapshot(s)
      const stack = [...s.undoStack, snap].slice(-MAX_UNDO)
      return { undoStack: stack, redoStack: [] }
    }),

  undo: () =>
    set((s) => {
      if (s.undoStack.length === 0) return s
      if (s.isPlaying) audioEngine.stop()
      const current = snapshot(s)
      const prev = s.undoStack[s.undoStack.length - 1]
      const undoStack = s.undoStack.slice(0, -1)
      const redoStack = [...s.redoStack, current].slice(-MAX_UNDO)
      return { ...restore(prev), undoStack, redoStack, selection: [], isPlaying: false }
    }),

  redo: () =>
    set((s) => {
      if (s.redoStack.length === 0) return s
      if (s.isPlaying) audioEngine.stop()
      const current = snapshot(s)
      const next = s.redoStack[s.redoStack.length - 1]
      const redoStack = s.redoStack.slice(0, -1)
      const undoStack = [...s.undoStack, current].slice(-MAX_UNDO)
      return { ...restore(next), undoStack, redoStack, selection: [], isPlaying: false }
    }),

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setMasterGain: (g) => set({ masterGain: clampLinearGain(g) }),
  setPixelsPerSecond: (pps) => set({ pixelsPerSecond: Math.max(10, Math.min(500, pps)) }),
  setScrollX: (x) => set({ scrollX: Math.max(0, x) }),

  selectOnly: (id) => set({ selection: id ? [id] : [] }),
  toggleSelect: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
    })),
  selectRangeFromAnchor: (anchorId, targetId) =>
    set((s) => {
      const sorted = [...s.clips].sort((a, b) => {
        if (a.row !== b.row) return a.row - b.row
        return a.startTime - b.startTime
      })
      const ia = sorted.findIndex((c) => c.id === anchorId)
      const ib = sorted.findIndex((c) => c.id === targetId)
      if (ia < 0 || ib < 0) return { selection: [targetId] }
      const lo = Math.min(ia, ib)
      const hi = Math.max(ia, ib)
      const ids = sorted.slice(lo, hi + 1).map((c) => c.id)
      return { selection: ids }
    }),
  setSelection: (ids) => set({ selection: [...new Set(ids)] }),

  addClipFromBuffer: (buffer, name, startTime, row, persistOriginal) => {
    const id = crypto.randomUUID()
    const bufferId = crypto.randomUUID()
    cacheBuffer(bufferId, buffer)
    setPeaksForBuffer(bufferId, buffer)
    if (persistOriginal) rememberOriginalBytes(bufferId, persistOriginal)
    const clip: Clip = {
      id,
      bufferId,
      startTime,
      row,
      layerIndex: 0,
      trimStart: 0,
      trimEnd: buffer.duration,
      gain: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      speed: 1,
      accentColor: pickRandomTrackAccent(),
    }
    const meta: BufferMeta = {
      id: bufferId,
      name,
      durationSec: buffer.duration,
    }
    set((s) => ({
      clips: [...s.clips, clip],
      bufferMeta: [...s.bufferMeta, meta],
      selection: [id],
    }))
    return id
  },

  addClipOnExistingBuffer: ({ bufferId, label, startTime, row, trimStart, trimEnd }) => {
    const s0 = get()
    const meta = s0.bufferMeta.find((b) => b.id === bufferId)
    if (!meta) return null
    const id = crypto.randomUUID()
    const clip: Clip = {
      id,
      bufferId,
      startTime,
      row,
      layerIndex: 0,
      trimStart,
      trimEnd,
      gain: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      speed: 1,
      accentColor: pickRandomTrackAccent(),
      label,
    }
    set((s) => ({
      clips: [...s.clips, clip],
    }))
    return id
  },

  setEditorMode: (mode) => set({ editorMode: mode }),

  updateClip: (id, patch) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),

  removeClip: (id) =>
    set((s) => {
      const clip = s.clips.find((c) => c.id === id)
      const clips = s.clips.filter((c) => c.id !== id)
      const selection = s.selection.filter((x) => x !== id)
      if (!clip) return { clips, selection }
      const stillUsed = clips.some((c) => c.bufferId === clip.bufferId)
      if (!stillUsed) {
        removeCachedBuffer(clip.bufferId)
        removePeaks(clip.bufferId)
        return {
          clips,
          bufferMeta: s.bufferMeta.filter((b) => b.id !== clip.bufferId),
          selection,
        }
      }
      return { clips, selection }
    }),

  deleteSelected: () => {
    const s0 = get()
    if (s0.selection.length === 0) return
    get().pushUndo()
    if (get().isPlaying) {
      audioEngine.stop()
      set({ isPlaying: false })
    }
    const ids = [...get().selection]
    for (const id of ids) {
      get().removeClip(id)
    }
  },

  duplicateSelected: () => {
    const s0 = get()
    if (s0.selection.length === 0) return
    get().pushUndo()
    if (s0.isPlaying) {
      audioEngine.stop()
      set({ isPlaying: false })
    }
    const selected = new Set(s0.selection)
    const picked = s0.clips.filter((c) => selected.has(c.id))
    if (picked.length === 0) return

    const byRow = new Map<number, Clip[]>()
    for (const c of picked) {
      const arr = byRow.get(c.row) ?? []
      arr.push(c)
      byRow.set(c.row, arr)
    }

    const dupes: Clip[] = []
    for (const rowClips of byRow.values()) {
      rowClips.sort((a, b) => a.startTime - b.startTime)
      let appendT = Math.max(...rowClips.map((c) => clipTimelineEnd(c)))
      for (const c of rowClips) {
        const prevAccent = c.accentColor ?? stableAccentForClipId(c.id)
        const dup: Clip = {
          ...c,
          id: crypto.randomUUID(),
          startTime: appendT,
          accentColor: pickRandomAccentAvoiding(prevAccent),
        }
        dupes.push(dup)
        appendT += clipTimelineDuration(dup)
      }
    }

    set((s) => ({
      clips: [...s.clips, ...dupes],
      selection: dupes.map((c) => c.id),
    }))
  },

  duplicateClipForDrag: (sourceId) => {
    const s0 = get()
    const source = s0.clips.find((c) => c.id === sourceId)
    if (!source) return null
    const layers = s0.clips.filter((c) => c.row === source.row).map((c) => c.layerIndex)
    const maxLayer = layers.length ? Math.max(...layers) : 0
    const prevAccent = source.accentColor ?? stableAccentForClipId(source.id)
    const dup: Clip = {
      ...source,
      id: crypto.randomUUID(),
      layerIndex: maxLayer + 1,
      accentColor: pickRandomAccentAvoiding(prevAccent),
    }
    set((s) => ({ clips: [...s.clips, dup] }))
    return dup.id
  },

  splitAt: (time, opts) =>
    set((s) => {
      const crossing = (c: Clip) =>
        time > c.startTime + 1e-4 && time < clipTimelineEnd(c) - 1e-4
      let targets: Clip[]
      if (opts?.onlyClipId) {
        targets = s.clips.filter((c) => c.id === opts.onlyClipId)
      } else if (opts?.column) {
        targets = s.clips.filter(crossing)
      } else if (s.selection.length > 0) {
        targets = s.clips.filter((c) => s.selection.includes(c.id))
      } else {
        targets = s.clips.filter(crossing)
      }
      const toRemove = new Set<ClipId>()
      const toAdd: Clip[] = []
      for (const c of targets) {
        const end = clipTimelineEnd(c)
        if (time <= c.startTime + 1e-4 || time >= end - 1e-4) continue
        const sp = clampPlaybackSpeed(c.speed)
        const srcT = c.trimStart + (time - c.startTime) * sp
        if (srcT <= c.trimStart + 1e-4 || srcT >= c.trimEnd - 1e-4) continue
        const [acLeft, acRight] = pickTwoDistinctTrackAccents()
        const left: Clip = { ...c, trimEnd: srcT, accentColor: acLeft }
        const right: Clip = {
          ...c,
          id: crypto.randomUUID(),
          startTime: time,
          trimStart: srcT,
          trimEnd: c.trimEnd,
          layerIndex: c.layerIndex,
          accentColor: acRight,
        }
        toRemove.add(c.id)
        toAdd.push(left, right)
      }
      if (toAdd.length === 0) return s
      const nextClips = s.clips.filter((c) => !toRemove.has(c.id))
      nextClips.push(...toAdd)
      return { clips: nextClips, selection: toAdd.map((c) => c.id) }
    }),

  setClipGain: (id, g) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, gain: clampLinearGain(g) } : c)),
    })),

  setAllClipGains: (g) =>
    set((s) => ({
      clips: s.clips.map((c) => ({ ...c, gain: clampLinearGain(g) })),
    })),

  setClipSpeed: (id, sp) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id ? { ...c, speed: clampPlaybackSpeed(sp) } : c
      ),
    })),

  setAllClipSpeeds: (sp) =>
    set((s) => ({
      clips: s.clips.map((c) => ({ ...c, speed: clampPlaybackSpeed(sp) })),
    })),

  setSpeedOnClips: (ids, sp) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        ids.includes(c.id) ? { ...c, speed: clampPlaybackSpeed(sp) } : c
      ),
    })),

  setGainOnClips: (ids, g) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        ids.includes(c.id) ? { ...c, gain: clampLinearGain(g) } : c
      ),
    })),

  setClipFadeIn: (id, sec) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id ? { ...c, fadeInSec: clampFadeSeconds(sec) } : c
      ),
    })),

  setClipFadeOut: (id, sec) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id ? { ...c, fadeOutSec: clampFadeSeconds(sec) } : c
      ),
    })),

  resetProject: () => {
    clearBufferCache()
    clearPeaks()
    clearOriginalBytes()
    set({ ...initialState, editorMode: 'edit' })
  },

  loadSnapshot: (snap) =>
    set((s) => {
      const r = restore(snap)
      return {
        ...initialState,
        ...r,
        clips: r.clips.map((c) => ({
          ...c,
          accentColor: c.accentColor ?? stableAccentForClipId(c.id),
        })),
        selection: [],
        isPlaying: false,
        // The Game song screen does not use timeline clips, so a late restore must not close it.
        editorMode: s.editorMode === 'game-song' ? 'game-song' as const : 'edit' as const,
        undoStack: [],
        redoStack: [],
      }
    }),
}))
