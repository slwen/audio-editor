import { create } from 'zustand'
import type { BufferId, ClipId } from '@/types'
import {
  clampVibeWindowSec,
  DEFAULT_VIBE_WINDOW_SEC,
  type LoopBarFilter,
  type LoopCandidate,
  type LoopLengthFilter,
  type LoopSession,
} from '@/loop/types'

const DEFAULT_WRAP = 0.02
const DEFAULT_MIN_QUALITY = 0.6
const DEFAULT_MIN_VIBE = 0.7

const emptySession = (): LoopSession => ({
  sourceClipId: '',
  bufferId: '',
  sourceName: '',
  trimStart: 0,
  trimEnd: 0,
  bpm: null,
  beatOffsetSec: null,
  status: 'idle',
  candidates: [],
  selectedIds: [],
  previewId: null,
  wrapCrossfadeSec: DEFAULT_WRAP,
  normalizeExport: true,
  minQuality: DEFAULT_MIN_QUALITY,
  minVibe: DEFAULT_MIN_VIBE,
  vibeWindowSec: DEFAULT_VIBE_WINDOW_SEC,
  barFilter: 'all',
  lengthFilter: 'all',
})

type LoopState = LoopSession

type LoopActions = {
  startSession: (opts: {
    sourceClipId: ClipId
    bufferId: BufferId
    sourceName: string
    trimStart: number
    trimEnd: number
  }) => void
  setAnalyzing: () => void
  setResults: (opts: { bpm: number; beatOffsetSec: number; candidates: LoopCandidate[] }) => void
  setError: (message: string) => void
  clear: () => void
  setSelectedIds: (ids: string[]) => void
  toggleSelected: (id: string) => void
  setPreviewId: (id: string | null) => void
  setWrapCrossfadeSec: (sec: number) => void
  setNormalizeExport: (v: boolean) => void
  setMinQuality: (v: number) => void
  setMinVibe: (v: number) => void
  setVibeWindowSec: (v: number) => void
  setBarFilter: (v: LoopBarFilter) => void
  setLengthFilter: (v: LoopLengthFilter) => void
  patchCandidate: (id: string, patch: Partial<LoopCandidate>) => void
}

export const useLoopStore = create<LoopState & LoopActions>((set, get) => ({
  ...emptySession(),

  startSession: (opts) =>
    set({
      ...emptySession(),
      vibeWindowSec: get().vibeWindowSec,
      ...opts,
      status: 'analyzing',
    }),

  setAnalyzing: () => set({ status: 'analyzing', errorMessage: undefined }),

  setResults: ({ bpm, beatOffsetSec, candidates }) => {
    const previewId = candidates[0]?.id ?? null
    set({
      status: 'ready',
      bpm,
      beatOffsetSec,
      candidates,
      selectedIds: previewId ? [previewId] : [],
      previewId,
      errorMessage: undefined,
    })
  },

  setError: (message) => set({ status: 'error', errorMessage: message }),

  clear: () => set({ ...emptySession(), vibeWindowSec: get().vibeWindowSec }),

  setSelectedIds: (ids) => set({ selectedIds: [...new Set(ids)] }),

  toggleSelected: (id) => {
    const s = get()
    const has = s.selectedIds.includes(id)
    const selectedIds = has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
    set({ selectedIds, previewId: id })
  },

  setPreviewId: (id) => set({ previewId: id }),

  setWrapCrossfadeSec: (sec) =>
    set({ wrapCrossfadeSec: Math.max(0, Math.min(0.25, sec)) }),

  setNormalizeExport: (v) => set({ normalizeExport: v }),

  setMinQuality: (v) => set({ minQuality: Math.max(0, Math.min(1, v)) }),

  setMinVibe: (v) => set({ minVibe: Math.max(0, Math.min(1, v)) }),

  setVibeWindowSec: (v) => set({ vibeWindowSec: clampVibeWindowSec(v) }),

  setBarFilter: (v) => set({ barFilter: v }),

  setLengthFilter: (v) => set({ lengthFilter: v }),

  patchCandidate: (id, patch) =>
    set((s) => ({
      candidates: s.candidates.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
}))
