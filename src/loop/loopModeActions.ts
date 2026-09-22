import { audioBufferFromChannels, writeWavStereo16 } from '@/audio/wavBytes'
import { audioEngine } from '@/audio/AudioEngine'
import { useAdaptiveStore } from '@/adaptive/store'
import { getCachedBuffer } from '@/audio/bufferCache'
import {
  downmix,
  joinPreviewOffset,
  nearestBarLength,
  softenSeamShiftSec,
} from '@/loop/detectLoops'
import { exportLoopCandidates } from '@/loop/exportLoops'
import { logLoopRating, loopRatingKey, type LoopRatingValue } from '@/loop/loopRatings'
import { analyzeBufferInWorker, rescoreBufferInWorker, terminateAnalysisWorker } from '@/loop/runDetection'
import { renderLoopChannels, sliceBufferChannels } from '@/loop/wrapLoop'
import { DEFAULT_LOOP_RENDER, loopRenderOptions } from '@/loop/renderSettings'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'
import { LOOP_ANALYSIS_VERSION, type LoopFeel, type LoopCandidate } from '@/loop/types'

let analysisGen = 0
let vibeRerunTimer: ReturnType<typeof setTimeout> | null = null

function stopPlayback(): void {
  audioEngine.stop()
  useProjectStore.getState().setIsPlaying(false)
}

async function runAnalysis(): Promise<void> {
  const gen = ++analysisGen
  const loop = useLoopStore.getState()
  const buf = getCachedBuffer(loop.bufferId)
  if (!buf) {
    useLoopStore.getState().setError('Source audio is not loaded.')
    return
  }
  useLoopStore.getState().setAnalyzing()
  try {
    const result = await analyzeBufferInWorker(
      buf,
      loop.trimStart,
      loop.trimEnd,
      loop.vibeWindowSec,
      loop.manualBpm ?? undefined
    )
    if (gen !== analysisGen) return
    const candidates: LoopCandidate[] = result.candidates.map((c, i) => ({
      id: `loop-${i}-${c.bars}-${Math.round(c.startSec * 1000)}`,
      startSec: loop.trimStart + c.startSec,
      endSec: loop.trimStart + c.endSec,
      bars: c.bars,
      seamScore: c.seamScore,
      contextScore: c.contextScore,
      homogeneityScore: c.homogeneityScore,
      qualityScore: c.qualityScore,
      bpm: result.bpm,
      closureScore: c.closureScore,
    }))
    useLoopStore.getState().setResults({
      bpm: result.bpm,
      beatOffsetSec: loop.trimStart + result.beatOffsetSec,
      candidates,
    })
    const current = useLoopStore.getState()
    const first = current.candidates.find(c => c.id === current.previewId)
    if (first) {
      useProjectStore.getState().setPlayhead(
        joinPreviewOffset(first.startSec, first.endSec, first.bpm)
      )
    }
  } catch (err) {
    if (gen !== analysisGen) return
    const message = err instanceof Error ? err.message : 'Loop analysis failed'
    useLoopStore.getState().setError(message)
  }
}

export function enterLoopModeFromSelection(): void {
  const st = useProjectStore.getState()
  if (st.selection.length !== 1) return
  const clip = st.clips.find((c) => c.id === st.selection[0])
  if (!clip) return
  const buf = getCachedBuffer(clip.bufferId)
  if (!buf) return
  const meta = st.bufferMeta.find((b) => b.id === clip.bufferId)
  stopPlayback()
  useAdaptiveStore.setState({ open: false })
  st.setEditorMode('loop')
  useLoopStore.getState().startSession({
    sourceClipId: clip.id,
    bufferId: clip.bufferId,
    sourceName: clip.label ?? meta?.name ?? 'clip',
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
  })
  st.setPlayhead(clip.trimStart)
  void runAnalysis()
}

export function exitLoopMode(): void {
  if (vibeRerunTimer) clearTimeout(vibeRerunTimer)
  vibeRerunTimer = null
  analysisGen++
  terminateAnalysisWorker()
  stopPlayback()
  useAdaptiveStore.setState({ open: false })
  useProjectStore.getState().setEditorMode('edit')
  useLoopStore.getState().clear()
}

export function rerunLoopAnalysis(): void {
  const loop = useLoopStore.getState()
  if (!loop.bufferId) return
  stopPlayback()
  void runAnalysis()
}

/** Updates how many seconds around the join are compared, then re-finds loops. */
export function setVibeWindowAndRerun(sec: number): void {
  useLoopStore.getState().setVibeWindowSec(sec)
  if (!useLoopStore.getState().bufferId) return
  if (vibeRerunTimer) clearTimeout(vibeRerunTimer)
  vibeRerunTimer = setTimeout(() => {
    vibeRerunTimer = null
    rerunLoopAnalysis()
  }, 400)
}

function ratingRecord(
  candidate: LoopCandidate,
  rating: LoopRatingValue | undefined,
  note: string | undefined
) {
  const loop = useLoopStore.getState()
  return {
    analysisVersion: candidate.scoreVersion ?? LOOP_ANALYSIS_VERSION,
    ...loopRenderOptions(loop, candidate),
    closureScore: candidate.closureScore,
    at: new Date().toISOString(),
    sourceName: loop.sourceName,
    startSec: candidate.startSec,
    endSec: candidate.endSec,
    bars: candidate.bars,
    seamScore: candidate.seamScore,
    contextScore: candidate.contextScore,
    homogeneityScore: candidate.homogeneityScore,
    qualityScore: candidate.qualityScore,
    bpm: candidate.bpm,
    vibeWindowSec: candidate.scoreVibeWindowSec ?? loop.vibeWindowSec,
    ...(rating ? { rating } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function updateLoopNote(id: string, note: string): void {
  const loop = useLoopStore.getState()
  const candidate = loop.candidates.find((c) => c.id === id)
  if (!candidate) return
  const key = loopRatingKey({ sourceName: loop.sourceName, ...candidate })
  useLoopStore.getState().setLoopNote(key, note)
  const pending = noteSaveTimers.get(key)
  if (pending) clearTimeout(pending)
  const record = ratingRecord(candidate, undefined, note)
  noteSaveTimers.set(
    key,
    setTimeout(() => {
      noteSaveTimers.delete(key)
      void logLoopRating(record).then(() => useLoopStore.getState().applyRating(record)).catch(() => {
        useLoopStore.getState().setRatingError('Could not save that note. Restart the dev server and try again.')
      })
    }, 400)
  )
}

export async function toggleLoopTag(id: string, tag: LoopFeel): Promise<void> {
  const loop = useLoopStore.getState()
  const candidate = loop.candidates.find(c => c.id === id)
  if (!candidate) return
  const key = loopRatingKey({ sourceName: loop.sourceName, ...candidate })
  const tags = loop.tags[key] ?? []
  const record = { ...ratingRecord(candidate, undefined, undefined),
    tags: tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag] }
  try {
    await logLoopRating(record)
    useLoopStore.getState().applyRating(record)
  } catch {
    useLoopStore.getState().setRatingError('Could not save the feel tag. Please retry.')
  }
}

export function setLoopTempo(bpm: number | null): void {
  if (bpm !== null && (!Number.isFinite(bpm) || bpm < 40 || bpm > 240)) return
  useLoopStore.getState().setManualBpm(bpm)
  rerunLoopAnalysis()
}

export async function rateLoopCandidate(id: string, rating: LoopRatingValue): Promise<void> {
  const loop = useLoopStore.getState()
  const candidate = loop.candidates.find((c) => c.id === id)
  if (!candidate) return
  const key = loopRatingKey({ sourceName: loop.sourceName, ...candidate })
  const next: LoopRatingValue = loop.ratings[key] === rating ? 'clear' : rating
  const note = loop.notes[key]
  try {
    const record = ratingRecord(candidate, next, note)
    await logLoopRating(record)
    useLoopStore.getState().applyRating(record)
  } catch {
    useLoopStore.getState().setRatingError('Could not save that mark. Restart the dev server and try again.')
  }
}

export function selectLoopCandidate(id: string, opts?: { toggle?: boolean }): void {
  const loop = useLoopStore.getState()
  if (opts?.toggle) loop.toggleSelected(id)
  else {
    loop.setSelectedIds([id])
    loop.setPreviewId(id)
  }
  const cand = useLoopStore.getState().candidates.find((c) => c.id === id)
  if (cand) {
    const bpm = cand.bpm || useLoopStore.getState().bpm || 120
    useProjectStore.getState().setPlayhead(joinPreviewOffset(cand.startSec, cand.endSec, bpm))
    if (useProjectStore.getState().isPlaying) {
      void startLoopPreview(cand.id)
    }
  }
}

export async function startLoopPreview(candidateId?: string, mode: 'join' | 'full' = 'join'): Promise<void> {
  await audioEngine.init()
  const st = useProjectStore.getState()
  const loop = useLoopStore.getState()
  const id = candidateId ?? loop.previewId ?? loop.selectedIds[0]
  const cand = loop.candidates.find((c) => c.id === id)
  const start = cand?.startSec ?? loop.trimStart
  const end = cand?.endSec ?? loop.trimEnd
  if (end - start < 1e-3) return
  const clip = st.clips.find((c) => c.id === loop.sourceClipId)
  const gain = clip?.gain ?? 1
  if (cand) {
    useLoopStore.getState().setPreviewId(cand.id)
    if (!loop.selectedIds.includes(cand.id)) {
      useLoopStore.getState().setSelectedIds([cand.id])
    }
  }
  const bpm = cand?.bpm ?? loop.bpm ?? 120
  const from = mode === 'full' ? start : joinPreviewOffset(start, end, bpm)
  st.setIsPlaying(true)
  st.setPlayhead(from)
  audioEngine.playLoopingRegion(
    loop.bufferId,
    start,
    end,
    gain,
    (t) => {
      useProjectStore.getState().setPlayhead(t)
    },
    from,
    cand ? loopRenderOptions(loop, cand) : DEFAULT_LOOP_RENDER
  )
}

export function stopLoopPreview(): void {
  const t = audioEngine.getCurrentTimelineTime()
  audioEngine.stop()
  useProjectStore.getState().setPlayhead(t)
  useProjectStore.getState().setIsPlaying(false)
}

function beatSec(): number | null {
  const loop = useLoopStore.getState()
  const candidate = loop.candidates.find(c => c.id === (loop.previewId ?? loop.selectedIds[0]))
  const bpm = candidate?.bpm ?? loop.bpm
  if (!bpm || bpm <= 0) return null
  return 60 / bpm
}

async function applyRegionEdit(
  picked: NonNullable<ReturnType<typeof selectedCandidate>>,
  patch: Pick<LoopCandidate, 'startSec' | 'endSec'> & Partial<Pick<LoopCandidate, 'bars'>>
): Promise<void> {
  const { loop, candidate, id } = picked
  const buffer = getCachedBuffer(loop.bufferId)
  if (!buffer) return
  const gen = analysisGen
  useLoopStore.setState({ isRescoring: true })
  try {
    const scores = await rescoreBufferInWorker(buffer, loop.trimStart, loop.trimEnd,
      patch.startSec, patch.endSec, candidate.bpm, loop.vibeWindowSec)
    if (gen !== analysisGen || useLoopStore.getState().bufferId !== loop.bufferId) return
    loop.patchCandidate(id, { ...patch, ...scores })
    if (useLoopStore.getState().previewId === id) {
      useProjectStore.getState().setPlayhead(patch.startSec)
      if (useProjectStore.getState().isPlaying) void startLoopPreview(id)
    }
  } catch (error) {
    if (gen === analysisGen) useLoopStore.getState().setRatingError(
      error instanceof Error ? error.message : 'Could not score the edited loop.')
  } finally {
    if (gen === analysisGen) useLoopStore.setState({ isRescoring: false })
  }
}

/** Move the whole loop earlier or later by whole beats. Length stays the same. */
export function shiftSelectedByBeats(beats: number): void {
  const picked = selectedCandidate()
  const step = beatSec()
  if (!picked || step == null) return
  const delta = beats * step
  const start = picked.candidate.startSec + delta
  const end = picked.candidate.endSec + delta
  if (start < picked.loop.trimStart || end > picked.loop.trimEnd) return
  void applyRegionEdit(picked, { startSec: start, endSec: end })
}

/** Resize an edge to the next supported whole-bar length. */
export function resizeSelectedLoop(which: 'start' | 'end', direction: -1 | 1): void {
  const picked = selectedCandidate()
  const step = beatSec()
  if (!picked || step == null) return
  const { loop, candidate: c } = picked
  const lengths = [1, 2, 4, 6, 8, 12, 16] as const
  const index = lengths.indexOf(nearestBarLength(c.endSec - c.startSec, step))
  const nextIndex = index + (which === 'start' ? -direction : direction)
  const bars = lengths[nextIndex]
  if (bars == null) return
  const start = which === 'start' ? c.endSec - bars * 4 * step : c.startSec
  const end = which === 'end' ? c.startSec + bars * 4 * step : c.endSec
  if (start < loop.trimStart || end > loop.trimEnd) return
  void applyRegionEdit(picked, { startSec: start, endSec: end, bars })
}

function selectedCandidate() {
  const loop = useLoopStore.getState()
  if (loop.status !== 'ready' || loop.isRescoring) return null
  const id = loop.previewId ?? loop.selectedIds[0]
  if (!id) return null
  const candidate = loop.candidates.find((c) => c.id === id)
  if (!candidate || candidate.origin === 'saved') return null
  return { id, candidate, loop }
}

/** Slide both edges together a few milliseconds to shrink a click. Length stays the same. */
export function softenSelectedSeam(): void {
  const picked = selectedCandidate()
  if (!picked) return
  const buf = getCachedBuffer(picked.loop.bufferId)
  if (!buf) return
  const { channels, sampleRate } = sliceBufferChannels(buf, 0, buf.duration)
  const mono = downmix(channels)
  const shift = softenSeamShiftSec(
    mono,
    sampleRate,
    picked.candidate.startSec,
    picked.candidate.endSec,
    0.03
  )
  if (Math.abs(shift) < 1 / sampleRate) return
  const start = picked.candidate.startSec + shift
  const end = picked.candidate.endSec + shift
  if (start < picked.loop.trimStart || end > picked.loop.trimEnd) return
  if (end - start < 0.25) return
  void applyRegionEdit(picked, { startSec: start, endSec: end })
}

/** Move the start onto the beat grid and set the length to the nearest whole bar count. */
export function fitSelectedToBars(): void {
  const picked = selectedCandidate()
  const step = beatSec()
  if (!picked || step == null) return
  const grid = picked.loop.beatOffsetSec ?? picked.loop.trimStart
  const beatsFromGrid = Math.round((picked.candidate.startSec - grid) / step)
  let start = grid + beatsFromGrid * step
  start = Math.max(picked.loop.trimStart, Math.min(picked.candidate.endSec - 0.25, start))
  const bars = nearestBarLength(picked.candidate.endSec - picked.candidate.startSec, step)
  const end = start + bars * 4 * step
  if (end > picked.loop.trimEnd) return
  if (end - start < 0.25) return
  void applyRegionEdit(picked, { startSec: start, endSec: end, bars })
}

export async function exportSelectedLoops(ids?: string[]): Promise<void> {
  const loop = useLoopStore.getState()
  const buf = getCachedBuffer(loop.bufferId)
  if (!buf) return
  const selected = loop.candidates.filter((c) => (ids ?? loop.selectedIds).includes(c.id))
  if (selected.length === 0) return
  await exportLoopCandidates(buf, loop.sourceName, loop.bpm ?? 120, selected, {
    wrapCrossfadeSec: loop.wrapCrossfadeSec,
    normalize: loop.normalizeExport,
    tags: loop.tags,
    notes: loop.notes,
    renderOptionsById: Object.fromEntries(selected.map(c => [c.id, loopRenderOptions(loop, c)])),
  })
}

export function addSelectedLoopsToTimeline(candidateIds?: string[]): void {
  const loop = useLoopStore.getState()
  const st = useProjectStore.getState()
  const selected = loop.candidates.filter((c) => (candidateIds ?? loop.selectedIds).includes(c.id))
  if (selected.length === 0) return
  stopPlayback()
  st.pushUndo()
  const maxRow = st.clips.reduce((m, c) => Math.max(m, c.row), -1)
  const ids: string[] = []
  selected.forEach((c, i) => {
    const source = getCachedBuffer(loop.bufferId)
    if (!source) return
    const rendered = renderLoopChannels(source, c.startSec, c.endSec, loopRenderOptions(loop, c))
    const buffer = audioBufferFromChannels(rendered.sampleRate, rendered.channels)
    const id = st.addClipFromBuffer(buffer,
      `${loop.sourceName} ${(loop.tags[loopRatingKey({ sourceName: loop.sourceName, ...c })] ?? []).join(' ')} loop ${i + 1} (${c.bars} bar)`,
      0, maxRow + 1 + i, writeWavStereo16(buffer))
    if (id) ids.push(id)
  })
  if (ids.length) st.setSelection(ids)
  exitLoopMode()
}
