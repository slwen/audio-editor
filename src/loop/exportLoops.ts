import { createLoopArchive, type ArchiveEntry } from '@/loop/loopArchive'
import { audioBufferFromChannels, writeWavStereo16 } from '@/audio/wavBytes'
import { downloadBlob } from '@/lib/downloadBlob'
import { renderLoopChannels, type LoopRenderOptions } from '@/loop/wrapLoop'
import { loopRatingKey } from '@/loop/loopRatings'
import { LOOP_ANALYSIS_VERSION, type LoopFeel, type LoopCandidate } from '@/loop/types'

function stem(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_|_$/g, '')
  return safe || 'loop'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function exportLoopCandidates(
  buffer: AudioBuffer,
  sourceName: string,
  bpm: number,
  candidates: LoopCandidate[],
  opts: LoopRenderOptions & { tags?: Record<string, LoopFeel[]>; notes?: Record<string, string>; renderOptionsById?: Record<string, LoopRenderOptions> }
): Promise<void> {
  if (candidates.length === 0) return
  const stemName = stem(sourceName)
  const entries: ArchiveEntry[] = []
  const manifestLoops: {
    file: string
    tags: LoopFeel[]
    note?: string
    closureScore?: number
    sampleRate: number
    sampleCount: number
    startSec: number
    endSec: number
    bars: number
    bpm: number
    scoreVersion: string
    seamScore: number
    contextScore: number
    homogeneityScore: number
    qualityScore: number
    wrapCrossfadeSec: number
    requestedWrapCrossfadeSec: number
    normalize: boolean
  }[] = []

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const render = opts.renderOptionsById?.[c.id] ?? c.savedRender ?? opts
    const { channels, sampleRate, wrapCrossfadeSec } = renderLoopChannels(buffer, c.startSec, c.endSec, render)
    const wavBuf = audioBufferFromChannels(sampleRate, channels)
    const bytes = writeWavStereo16(wavBuf)
    const bpmRound = Math.round(c.bpm)
    const key = loopRatingKey({ sourceName, ...c })
    const tags = opts.tags?.[key] ?? []
    const feel = tags.length ? `_${tags.join('-')}` : ''
    const file = `${stemName}_loop_${String(i + 1).padStart(2, '0')}_${c.bars}bar_${bpmRound}bpm${feel}.wav`
    entries.push({ name: file, bytes: new Uint8Array(bytes) })
    manifestLoops.push({
      file,
      tags,
      note: opts.notes?.[key],
      closureScore: c.closureScore,
      sampleRate,
      sampleCount: wavBuf.length,
      startSec: c.startSec,
      endSec: c.endSec,
      bars: c.bars,
      bpm: c.bpm,
      scoreVersion: c.scoreVersion ?? LOOP_ANALYSIS_VERSION,
      seamScore: Math.round(c.seamScore * 1000) / 1000,
      contextScore: Math.round(c.contextScore * 1000) / 1000,
      homogeneityScore: Math.round(c.homogeneityScore * 1000) / 1000,
      qualityScore: Math.round(c.qualityScore * 1000) / 1000,
      wrapCrossfadeSec,
      requestedWrapCrossfadeSec: render.wrapCrossfadeSec,
      normalize: render.normalize,
    })
    if (i < candidates.length - 1) await sleep(0)
  }

  const json = JSON.stringify(
    { analysisVersion: LOOP_ANALYSIS_VERSION, source: sourceName, bpm: candidates.every(c => Math.abs(c.bpm - bpm) < 1e-6) ? bpm : null, beatsPerBar: 4,
      wrapCrossfadeSec: manifestLoops.every(c => c.wrapCrossfadeSec === manifestLoops[0]!.wrapCrossfadeSec) ? manifestLoops[0]!.wrapCrossfadeSec : null,
      normalize: manifestLoops.every(c => c.normalize === manifestLoops[0]!.normalize) ? manifestLoops[0]!.normalize : null, loops: manifestLoops },
    null,
    2
  )
  entries.push({ name: `${stemName}_loops.json`, bytes: new TextEncoder().encode(json) })
  downloadBlob(createLoopArchive(entries), `${stemName}_loops.zip`)
}
