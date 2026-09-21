import { audioEngine } from '@/audio/AudioEngine'
import { getCachedBuffer } from '@/audio/bufferCache'
import { downmix, joinPreviewOffset, scoreLoopWindow } from '@/loop/detectLoops'
import { exportLoopCandidates } from '@/loop/exportLoops'
import { analyzeBufferInWorker, terminateAnalysisWorker } from '@/loop/runDetection'
import { sliceBufferChannels } from '@/loop/wrapLoop'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'
import type { LoopCandidate } from '@/loop/types'

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
      loop.vibeWindowSec
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
    }))
    useLoopStore.getState().setResults({
      bpm: result.bpm,
      beatOffsetSec: loop.trimStart + result.beatOffsetSec,
      candidates,
    })
    const first = candidates[0]
    if (first) {
      useProjectStore.getState().setPlayhead(
        joinPreviewOffset(first.startSec, first.endSec, result.bpm)
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

export async function startLoopPreview(candidateId?: string): Promise<void> {
  await audioEngine.init()
  const st = useProjectStore.getState()
  const loop = useLoopStore.getState()
  const id = candidateId ?? loop.previewId ?? loop.selectedIds[0]
  const cand = loop.candidates.find((c) => c.id === id)
  const start = cand?.startSec ?? loop.trimStart
  const end = cand?.endSec ?? loop.trimEnd
  if (end - start < 1e-3) return
  const clip = st.clips.find((c) => c.id === loop.sourceClipId)
  const gain = (clip?.gain ?? 1) * st.masterGain
  if (cand) {
    useLoopStore.getState().setPreviewId(cand.id)
    if (!loop.selectedIds.includes(cand.id)) {
      useLoopStore.getState().setSelectedIds([cand.id])
    }
  }
  const bpm = cand?.bpm ?? loop.bpm ?? 120
  const from = joinPreviewOffset(start, end, bpm)
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
    from
  )
}

export function stopLoopPreview(): void {
  const t = audioEngine.getCurrentTimelineTime()
  audioEngine.stop()
  useProjectStore.getState().setPlayhead(t)
  useProjectStore.getState().setIsPlaying(false)
}

function beatSec(): number | null {
  const bpm = useLoopStore.getState().bpm
  if (!bpm || bpm <= 0) return null
  return 60 / bpm
}

function rescoreCandidate(c: LoopCandidate): Pick<
  LoopCandidate,
  'seamScore' | 'contextScore' | 'homogeneityScore' | 'qualityScore'
> {
  const buf = getCachedBuffer(useLoopStore.getState().bufferId)
  if (!buf) {
    return {
      seamScore: c.seamScore,
      contextScore: c.contextScore,
      homogeneityScore: c.homogeneityScore,
      qualityScore: c.qualityScore,
    }
  }
  const { channels, sampleRate } = sliceBufferChannels(buf, c.startSec, c.endSec)
  const mono = downmix(channels)
  return scoreLoopWindow(
    mono,
    sampleRate,
    0,
    mono.length / sampleRate,
    c.bpm,
    undefined,
    undefined,
    useLoopStore.getState().vibeWindowSec
  )
}

export function nudgeSelectedByBeats(which: 'start' | 'end', beats: number): void {
  const loop = useLoopStore.getState()
  const step = beatSec()
  if (step == null) return
  const id = loop.previewId ?? loop.selectedIds[0]
  if (!id) return
  const c = loop.candidates.find((x) => x.id === id)
  if (!c) return
  const delta = beats * step
  let start = c.startSec
  let end = c.endSec
  if (which === 'start') start = Math.max(loop.trimStart, Math.min(end - 0.25, start + delta))
  else end = Math.min(loop.trimEnd, Math.max(start + 0.25, end + delta))
  const scored = rescoreCandidate({ ...c, startSec: start, endSec: end })
  loop.patchCandidate(id, { startSec: start, endSec: end, ...scored })
  useProjectStore.getState().setPlayhead(start)
  if (useProjectStore.getState().isPlaying) void startLoopPreview(id)
}

export async function exportSelectedLoops(): Promise<void> {
  const loop = useLoopStore.getState()
  const buf = getCachedBuffer(loop.bufferId)
  if (!buf) return
  const selected = loop.candidates.filter((c) => loop.selectedIds.includes(c.id))
  if (selected.length === 0) return
  await exportLoopCandidates(buf, loop.sourceName, loop.bpm ?? 120, selected, {
    wrapCrossfadeSec: loop.wrapCrossfadeSec,
    normalize: loop.normalizeExport,
  })
}

export function addSelectedLoopsToTimeline(): void {
  const loop = useLoopStore.getState()
  const st = useProjectStore.getState()
  const selected = loop.candidates.filter((c) => loop.selectedIds.includes(c.id))
  if (selected.length === 0) return
  stopPlayback()
  st.pushUndo()
  const maxRow = st.clips.reduce((m, c) => Math.max(m, c.row), -1)
  const ids: string[] = []
  selected.forEach((c, i) => {
    const id = st.addClipOnExistingBuffer({
      bufferId: loop.bufferId,
      label: `${loop.sourceName} loop ${i + 1} (${c.bars} bar)`,
      startTime: 0,
      row: maxRow + 1 + i,
      trimStart: c.startSec,
      trimEnd: c.endSec,
    })
    if (id) ids.push(id)
  })
  if (ids.length) st.setSelection(ids)
  exitLoopMode()
}
