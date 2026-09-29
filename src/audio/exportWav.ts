import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import { ensureSoundTouchWorklet } from '@/audio/ensureSoundTouchWorklet'
import { scheduleTimelineGainFade } from '@/audio/scheduleGainFade'
import { getCachedBuffer } from '@/audio/bufferCache'
import {
  clampLinearGain,
  clampPlaybackSpeed,
  clipTimelineEnd,
  getProjectEndTime,
} from '@/lib/clipMath'
import { encodeMp3InWorker, type ExportOptions } from '@/audio/encodeMp3InWorker'
import { writeWavStereo16 } from '@/audio/wavBytes'
import type { Clip } from '@/types'

export type AudioExportFormat = 'mp3' | 'wav'

async function encodeAudioBuffer(rendered: AudioBuffer, format: AudioExportFormat, options: ExportOptions): Promise<Blob> {
  options.signal?.throwIfAborted()
  switch (format) {
    case 'wav':
      return new Blob([writeWavStereo16(rendered)], { type: 'audio/wav' })
    case 'mp3':
      return encodeMp3InWorker(rendered, options)
    default: {
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${_exhaustive}`)
    }
  }
}

export function audioExportFilename(stem: string, format: AudioExportFormat): string {
  switch (format) {
    case 'wav':
      return `${stem}.wav`
    case 'mp3':
      return `${stem}.mp3`
    default: {
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${_exhaustive}`)
    }
  }
}

export async function exportMixedWav(
  clips: Clip[],
  masterLinear: number,
  format: AudioExportFormat = 'mp3',
  options: ExportOptions = {}
): Promise<Blob> {
  options.signal?.throwIfAborted()
  const duration = getProjectEndTime(clips) + 0.25
  const sampleRate = 48000
  const length = Math.ceil(duration * sampleRate)
  const offline = new OfflineAudioContext(2, length, sampleRate)

  await ensureSoundTouchWorklet(offline)

  const master = offline.createGain()
  master.gain.value = clampLinearGain(masterLinear)
  master.connect(offline.destination)

  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime)
  for (const clip of sorted) {
    const buf = getCachedBuffer(clip.bufferId)
    if (!buf) continue
    const clipEnd = clipTimelineEnd(clip)
    const speed = clampPlaybackSpeed(clip.speed)
    const bufferSeconds = clip.trimEnd - clip.trimStart
    if (bufferSeconds <= 0) continue

    const gain = offline.createGain()
    const source = offline.createBufferSource()
    source.buffer = buf
    if (Math.abs(speed - 1) < 1e-6) {
      source.playbackRate.value = 1
      source.connect(gain)
    } else {
      source.playbackRate.value = 1
      const st = new SoundTouchNode(offline)
      st.playbackRate.value = speed
      st.pitch.value = 1
      st.tempo.value = 1
      source.connect(st)
      st.connect(gain)
    }
    gain.connect(master)

    const wallDur = clipEnd - clip.startTime
    scheduleTimelineGainFade(gain.gain, clip, clipEnd, clip.gain, clip.startTime, clip.startTime, wallDur, {
      maxSteps: 256,
      minSteps: 8,
      stepsPerSecond: 40,
    })

    try {
      source.start(clip.startTime, clip.trimStart, bufferSeconds)
    } catch {
      /* invalid */
    }
  }

  const rendered = await offline.startRendering()
  return encodeAudioBuffer(rendered, format, options)
}

/**
 * Export only selected clips, rebased so the earliest selected start renders at t=0.
 * This avoids leading silence from their original timeline position.
 */
export async function exportSelectedWav(
  clips: Clip[],
  masterLinear: number,
  format: AudioExportFormat = 'mp3',
  options: ExportOptions = {}
): Promise<Blob> {
  options.signal?.throwIfAborted()
  if (clips.length === 0) throw new Error('No clips selected')

  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime)
  const minStart = sorted[0]?.startTime ?? 0
  const maxEnd = sorted.reduce((m, c) => Math.max(m, clipTimelineEnd(c)), 0)
  const duration = Math.max(0.25, maxEnd - minStart + 0.25)
  const sampleRate = 48000
  const length = Math.ceil(duration * sampleRate)
  const offline = new OfflineAudioContext(2, length, sampleRate)

  await ensureSoundTouchWorklet(offline)

  const master = offline.createGain()
  master.gain.value = clampLinearGain(masterLinear)
  master.connect(offline.destination)

  for (const clip of sorted) {
    const buf = getCachedBuffer(clip.bufferId)
    if (!buf) continue
    const speed = clampPlaybackSpeed(clip.speed)
    const bufferSeconds = clip.trimEnd - clip.trimStart
    if (bufferSeconds <= 0) continue

    const gain = offline.createGain()
    const source = offline.createBufferSource()
    source.buffer = buf
    if (Math.abs(speed - 1) < 1e-6) {
      source.playbackRate.value = 1
      source.connect(gain)
    } else {
      source.playbackRate.value = 1
      const st = new SoundTouchNode(offline)
      st.playbackRate.value = speed
      st.pitch.value = 1
      st.tempo.value = 1
      source.connect(st)
      st.connect(gain)
    }
    gain.connect(master)

    const clipStartRebased = Math.max(0, clip.startTime - minStart)
    const clipForRender: Clip = { ...clip, startTime: clipStartRebased }
    const clipEndRebased = clipTimelineEnd(clipForRender)
    const wallDur = clipEndRebased - clipStartRebased
    scheduleTimelineGainFade(
      gain.gain,
      clipForRender,
      clipEndRebased,
      clip.gain,
      clipStartRebased,
      clipStartRebased,
      wallDur,
      {
        maxSteps: 256,
        minSteps: 8,
        stepsPerSecond: 40,
      }
    )

    try {
      source.start(clipStartRebased, clip.trimStart, bufferSeconds)
    } catch {
      /* invalid */
    }
  }

  const rendered = await offline.startRendering()
  return encodeAudioBuffer(rendered, format, options)
}
