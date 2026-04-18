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
import type { Clip } from '@/types'

function writeWavStereo16(floatBuffer: AudioBuffer): ArrayBuffer {
  const numCh = Math.min(2, floatBuffer.numberOfChannels)
  const n = floatBuffer.length
  const blockAlign = numCh * 2
  const byteRate = floatBuffer.sampleRate * blockAlign
  const dataSize = n * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)!)
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, numCh, true)
  v.setUint32(24, floatBuffer.sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, 16, true)
  writeStr(36, 'data')
  v.setUint32(40, dataSize, true)
  const ch0 = floatBuffer.getChannelData(0)
  const ch1 = numCh > 1 ? floatBuffer.getChannelData(1) : ch0
  let o = 44
  for (let i = 0; i < n; i++) {
    for (const ch of [ch0, ch1]) {
      const s = Math.max(-1, Math.min(1, ch[i] ?? 0))
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true)
      o += 2
    }
  }
  return buffer
}

export async function exportMixedWav(clips: Clip[], masterLinear: number): Promise<Blob> {
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
  const wav = writeWavStereo16(rendered)
  return new Blob([wav], { type: 'audio/wav' })
}

/**
 * Export only selected clips, rebased so the earliest selected start renders at t=0.
 * This avoids leading silence from their original timeline position.
 */
export async function exportSelectedWav(clips: Clip[], masterLinear: number): Promise<Blob> {
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
  const wav = writeWavStereo16(rendered)
  return new Blob([wav], { type: 'audio/wav' })
}
