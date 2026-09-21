import { audioBufferFromChannels, writeWavStereo16 } from '@/audio/wavBytes'
import { downloadBlob } from '@/lib/downloadBlob'
import { bakeWrapEqualPower, peakNormalize, sliceBufferChannels } from '@/loop/wrapLoop'
import type { LoopCandidate } from '@/loop/types'

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
  opts: { wrapCrossfadeSec: number; normalize: boolean }
): Promise<void> {
  if (candidates.length === 0) return
  const stemName = stem(sourceName)
  const manifestLoops: {
    file: string
    startSec: number
    endSec: number
    bars: number
    seamScore: number
    contextScore: number
    homogeneityScore: number
    qualityScore: number
  }[] = []

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const { channels, sampleRate } = sliceBufferChannels(buffer, c.startSec, c.endSec)
    const fade = Math.floor(opts.wrapCrossfadeSec * sampleRate)
    if (fade >= 2) {
      for (const ch of channels) bakeWrapEqualPower(ch, fade)
    }
    if (opts.normalize) peakNormalize(channels)
    const wavBuf = audioBufferFromChannels(sampleRate, channels)
    const bytes = writeWavStereo16(wavBuf)
    const bpmRound = Math.round(bpm)
    const file = `${stemName}_loop_${String(i + 1).padStart(2, '0')}_${c.bars}bar_${bpmRound}bpm.wav`
    downloadBlob(new Blob([bytes], { type: 'audio/wav' }), file)
    manifestLoops.push({
      file,
      startSec: c.startSec,
      endSec: c.endSec,
      bars: c.bars,
      seamScore: Math.round(c.seamScore * 1000) / 1000,
      contextScore: Math.round(c.contextScore * 1000) / 1000,
      homogeneityScore: Math.round(c.homogeneityScore * 1000) / 1000,
      qualityScore: Math.round(c.qualityScore * 1000) / 1000,
    })
    if (i < candidates.length - 1) await sleep(180)
  }

  const json = JSON.stringify(
    { source: sourceName, bpm, loops: manifestLoops },
    null,
    2
  )
  await sleep(180)
  downloadBlob(new Blob([json], { type: 'application/json' }), `${stemName}_loops.json`)
}
