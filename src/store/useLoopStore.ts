import { mergeSavedLoops } from '@/loop/savedLoops'
import { create } from 'zustand'
import type { BufferId, ClipId } from '@/types'
import { applyRatingRecord, collectTags, collectNotes, latestRatings, loopRatingKey, type LoopRatingRecord } from '@/loop/loopRatings'
import { DEFAULT_LOOP_RENDER, loopRenderOptions } from '@/loop/renderSettings'
import {
  clampVibeWindowSec,
  DEFAULT_VIBE_WINDOW_SEC,
  type LoopFeel,
  type LoopReviewFilter,
  type LoopBarFilter,
  type LoopCandidate,
  type LoopLengthFilter,
  type LoopSession,
} from '@/loop/types'

const DEFAULT_MIN_QUALITY = 0.4
const DEFAULT_MIN_VIBE = 0.58

const emptySession = (): LoopSession => ({
  sourceClipId: '',
  bufferId: '',
  sourceName: '',
  trimStart: 0,
  trimEnd: 0,
  bpm: null,
  manualBpm: null,
  beatOffsetSec: null,
  status: 'idle',
  isRescoring: false,
  candidateView: 'found',
  feelFilter: 'all',
  reviewFilter: 'not-bad',
  candidates: [],
  selectedIds: [],
  previewId: null,
  renderOverrides: {},
  wrapCrossfadeSec: DEFAULT_LOOP_RENDER.wrapCrossfadeSec,
  normalizeExport: DEFAULT_LOOP_RENDER.normalize,
  minQuality: DEFAULT_MIN_QUALITY,
  minVibe: DEFAULT_MIN_VIBE,
  vibeWindowSec: DEFAULT_VIBE_WINDOW_SEC,
  barFilter: 'beds',
  lengthFilter: 'all',
})

type LoopState = LoopSession & {
  ratingRecords: LoopRatingRecord[]
  ratings: Record<string, 'good' | 'bad'>
  ratingError: string | null
  /** Notes keyed by loop identity, not by whichever row is selected. */
  notes: Record<string, string>
  tags: Record<string, LoopFeel[]>
}

type LoopActions = {
  startSession: (opts: {
    sourceClipId: ClipId
    bufferId: BufferId
    sourceName: string
    trimStart: number
    trimEnd: number
  }) => void
  setFeelFilter: (value: 'all' | LoopFeel) => void
  setReviewFilter: (value: LoopReviewFilter) => void
  setCandidateView: (view: 'found' | 'saved') => void
  setManualBpm: (bpm: number | null) => void
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
  replaceRatings: (records: LoopRatingRecord[]) => void
  applyRating: (record: LoopRatingRecord) => void
  setRatingError: (message: string | null) => void
  setLoopNote: (key: string, note: string) => void
}

export const useLoopStore = create<LoopState & LoopActions>((set, get) => ({
  ...emptySession(),
  ratingRecords: [],
  ratings: {},
  ratingError: null,
  notes: {},
  tags: {},

  startSession: (opts) =>
    set({
      ...emptySession(),
      ratings: get().ratings,
      notes: get().notes,
      ...opts,
      status: 'analyzing',
    }),

  setFeelFilter: (feelFilter) => set({ feelFilter }),
  setReviewFilter: (reviewFilter) => set({ reviewFilter }),
  setCandidateView: (candidateView) => set({ candidateView, selectedIds: [], previewId: null }),

  setManualBpm: (manualBpm) => set({ manualBpm }),

  setAnalyzing: () => set({ status: 'analyzing', isRescoring: false, errorMessage: undefined }),

  setResults: ({ bpm, beatOffsetSec, candidates }) => {
    const merged = mergeSavedLoops(candidates, get().ratingRecords, get())
    const savedView = get().candidateView === 'saved'
    const previewId = savedView
      ? merged.find(c => c.id === get().previewId)?.id ?? merged.find(c => c.origin === 'saved')?.id ?? null
      : candidates[0]?.id ?? null
    const savedSelected = get().selectedIds.filter(id => merged.some(c => c.id === id))
    const preview = merged.find(c => c.id === previewId)
    const render = preview ? loopRenderOptions(get(), preview) : DEFAULT_LOOP_RENDER
    set({
      status: 'ready',
      bpm,
      beatOffsetSec,
      candidates: merged,
      selectedIds: savedView && savedSelected.length ? savedSelected : previewId ? [previewId] : [],
      previewId,
      wrapCrossfadeSec: render.wrapCrossfadeSec,
      normalizeExport: render.normalize,
      errorMessage: undefined,
    })
  },

  setError: (message) => set({ status: 'error', errorMessage: message }),

  clear: () =>
    set({
      ...emptySession(),
      vibeWindowSec: get().vibeWindowSec,
      ratings: get().ratings,
      notes: get().notes,
    }),

  setSelectedIds: (ids) => set({ selectedIds: [...new Set(ids)] }),

  toggleSelected: (id) => {
    const s = get()
    const has = s.selectedIds.includes(id)
    const selectedIds = has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
    set({ selectedIds })
    get().setPreviewId(id)
  },

  setPreviewId: (id) => {
    const candidate = get().candidates.find(c => c.id === id)
    const render = candidate ? loopRenderOptions(get(), candidate) : DEFAULT_LOOP_RENDER
    set({ previewId: id, wrapCrossfadeSec: render.wrapCrossfadeSec, normalizeExport: render.normalize })
  },

  setWrapCrossfadeSec: (sec) => {
    if (!Number.isFinite(sec)) return
    const s = get()
    const candidate = s.candidates.find(c => c.id === s.previewId)
    if (!candidate) return
    const wrapCrossfadeSec = Math.max(0, Math.min(1.5, sec))
    const key = loopRatingKey({ sourceName: s.sourceName, ...candidate })
    set({ wrapCrossfadeSec, renderOverrides: { ...s.renderOverrides,
      [key]: { ...loopRenderOptions(s, candidate), wrapCrossfadeSec } } })
  },

  setNormalizeExport: (normalize) => {
    const s = get()
    const candidate = s.candidates.find(c => c.id === s.previewId)
    if (!candidate) return
    const key = loopRatingKey({ sourceName: s.sourceName, ...candidate })
    set({ normalizeExport: normalize, renderOverrides: { ...s.renderOverrides,
      [key]: { ...loopRenderOptions(s, candidate), normalize } } })
  },

  setMinQuality: (v) => set({ minQuality: Math.max(0, Math.min(1, v)) }),

  setMinVibe: (v) => set({ minVibe: Math.max(0, Math.min(1, v)) }),

  setVibeWindowSec: (v) => set({ vibeWindowSec: clampVibeWindowSec(v) }),

  setBarFilter: (v) => set({ barFilter: v }),

  setLengthFilter: (v) => set({ lengthFilter: v }),

  patchCandidate: (id, patch) => set(s => {
    const previous = s.candidates.find(c => c.id === id)
    if (!previous) return {}
    const updated = { ...previous, ...patch }
    const key = loopRatingKey({ sourceName: s.sourceName, ...updated })
    return { candidates: s.candidates.map(c => c.id === id ? updated : c),
      renderOverrides: { ...s.renderOverrides, [key]: loopRenderOptions(s, previous) } }
  }),

  replaceRatings: (records) => {
    set({ ratingRecords: records, ratings: latestRatings(records), notes: collectNotes(records), tags: collectTags(records),
      candidates: mergeSavedLoops(get().candidates, records, get()) })
  },

  applyRating: (record) => set((s) => {
    const records = [...s.ratingRecords, record]
    return { ratingRecords: records, ratings: applyRatingRecord(s.ratings, record),
      tags: { ...s.tags, ...collectTags([record]) },
      candidates: mergeSavedLoops(s.candidates, records, s), ratingError: null }
  }),

  setRatingError: (message) => set({ ratingError: message }),

  setLoopNote: (key, note) => set((s) => ({ notes: { ...s.notes, [key]: note } })),
}))
