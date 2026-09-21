import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import { ensureSoundTouchWorklet } from '@/audio/ensureSoundTouchWorklet'
import { scheduleTimelineGainFade } from '@/audio/scheduleGainFade'
import { getCachedBuffer } from '@/audio/bufferCache'
import {
  clampLinearGain,
  clampPlaybackSpeed,
  clipTimelineEnd,
  fadeMultiplier,
  getProjectEndTime,
  sourceTimeAtTimelineTime,
} from '@/lib/clipMath'
import type { Clip } from '@/types'

type ActiveChain = {
  clipId: string
  source: AudioBufferSourceNode
  st: SoundTouchNode | null
  gain: GainNode
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private active: ActiveChain[] = []
  private playheadAtStart = 0
  private startCtxTime = 0
  private raf = 0
  private onTick?: (timelineT: number) => void
  private sessionPlaying = false
  private projectEndTime = 0
  private loopStart = 0
  private loopLen = 0

  getContext(): AudioContext | null {
    return this.ctx
  }

  getCurrentTimelineTime(): number {
    if (!this.ctx) return this.playheadAtStart
    const raw = this.playheadAtStart + (this.ctx.currentTime - this.startCtxTime)
    if (this.loopLen > 1e-6) {
      const elapsed = raw - this.loopStart
      const wrapped = ((elapsed % this.loopLen) + this.loopLen) % this.loopLen
      return this.loopStart + wrapped
    }
    return raw
  }

  async init(): Promise<AudioContext> {
    if (this.ctx) return this.ctx
    const ctx = new AudioContext()
    await ensureSoundTouchWorklet(ctx)
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
    this.ctx = ctx
    return ctx
  }

  setMasterGain(linear: number): void {
    if (this.master) this.master.gain.value = clampLinearGain(linear)
  }

  stop(): void {
    this.sessionPlaying = false
    this.loopLen = 0
    this.loopStart = 0
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const chain of this.active) {
      try {
        chain.source.onended = null
        chain.source.stop()
      } catch {
        /* already stopped */
      }
      chain.source.disconnect()
      chain.st?.disconnect()
      chain.gain.disconnect()
    }
    this.active = []
  }

  isPlaying(): boolean {
    return this.sessionPlaying
  }

  play(
    playhead: number,
    clips: Clip[],
    masterLinear: number,
    onEnded?: () => void,
    onTick?: (timelineT: number) => void
  ): void {
    this.stop()
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return

    this.playheadAtStart = playhead
    this.startCtxTime = ctx.currentTime
    this.onTick = onTick
    this.loopLen = 0
    this.loopStart = 0
    this.projectEndTime = clips.length > 0 ? getProjectEndTime(clips) : playhead
    this.sessionPlaying = true

    master.gain.value = clampLinearGain(masterLinear)

    const sorted = [...clips].sort((a, b) => a.startTime - b.startTime)
    const now = ctx.currentTime

    const fadeOpts = { maxSteps: 128, minSteps: 8, stepsPerSecond: 30 }

    for (const clip of sorted) {
      const buf = getCachedBuffer(clip.bufferId)
      if (!buf) continue

      const clipEnd = clipTimelineEnd(clip)
      if (clipEnd <= playhead + 1e-6) continue

      const speed = clampPlaybackSpeed(clip.speed)

      const source = ctx.createBufferSource()
      source.buffer = buf
      const gain = ctx.createGain()
      const useSoundTouch = Math.abs(speed - 1) > 1e-6
      let st: SoundTouchNode | null = null
      if (useSoundTouch) {
        source.playbackRate.value = speed
        st = new SoundTouchNode(ctx)
        st.playbackRate.value = speed
        st.pitch.value = 1
        st.tempo.value = 1
        source.connect(st)
        st.connect(gain)
      } else {
        source.playbackRate.value = 1
        source.connect(gain)
      }
      gain.connect(master)

      if (playhead < clip.startTime - 1e-6) {
        const delay = clip.startTime - playhead
        const when = now + delay
        const offset = clip.trimStart
        const bufferDur = clip.trimEnd - clip.trimStart
        if (bufferDur <= 1e-6) continue
        scheduleTimelineGainFade(
          gain.gain,
          clip,
          clipEnd,
          clip.gain,
          when,
          clip.startTime,
          clipEnd - clip.startTime,
          fadeOpts
        )
        source.start(when, offset, bufferDur)
      } else {
        const srcOffset = sourceTimeAtTimelineTime(clip, playhead)
        if (srcOffset >= clip.trimEnd - 1e-6) continue
        const bufferSecondsRemaining = clip.trimEnd - srcOffset
        if (bufferSecondsRemaining <= 0) continue
        const wallDur = clipEnd - playhead
        scheduleTimelineGainFade(gain.gain, clip, clipEnd, clip.gain, now, playhead, wallDur, fadeOpts)
        source.start(now, srcOffset, bufferSecondsRemaining)
      }

      source.onended = null
      this.active.push({ clipId: clip.id, source, st, gain })
    }

    if (playhead >= this.projectEndTime - 1e-6) {
      this.stop()
      onEnded?.()
      return
    }

    const tick = () => {
      if (!this.sessionPlaying) return
      const t = this.getCurrentTimelineTime()
      this.onTick?.(t)
      if (t >= this.projectEndTime - 1e-6) {
        this.stop()
        onEnded?.()
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  playLoopingRegion(
    bufferId: string,
    startSec: number,
    endSec: number,
    gainLinear: number,
    onTick?: (sourceT: number) => void,
    playFromSec?: number
  ): void {
    this.stop()
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const buf = getCachedBuffer(bufferId)
    if (!buf) return

    const start = Math.max(0, Math.min(buf.duration, startSec))
    const end = Math.max(start + 1e-3, Math.min(buf.duration, endSec))
    const dur = end - start
    const from = Math.max(start, Math.min(end - 1e-3, playFromSec ?? start))

    this.playheadAtStart = from
    this.startCtxTime = ctx.currentTime
    this.onTick = onTick
    this.loopStart = start
    this.loopLen = dur
    this.sessionPlaying = true
    this.projectEndTime = Number.POSITIVE_INFINITY

    const source = ctx.createBufferSource()
    source.buffer = buf
    source.loop = true
    source.loopStart = start
    source.loopEnd = end
    const gain = ctx.createGain()
    gain.gain.value = clampLinearGain(gainLinear)
    source.connect(gain)
    gain.connect(master)
    source.start(ctx.currentTime, from)
    this.active.push({ clipId: 'loop-preview', source, st: null, gain })

    const tick = () => {
      if (!this.sessionPlaying) return
      this.onTick?.(this.getCurrentTimelineTime())
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  updateClipGainLive(clipId: string, clips: Clip[], linear: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const chain = this.active.find((c) => c.clipId === clipId)
    if (!chain) return
    const clip = clips.find((c) => c.id === clipId)
    if (!clip) return
    const clipEnd = clipTimelineEnd(clip)
    const now = ctx.currentTime
    const tline = this.getCurrentTimelineTime()
    const mul = fadeMultiplier(clip, tline, clipEnd)
    chain.gain.gain.cancelScheduledValues(now)
    chain.gain.gain.setValueAtTime(clampLinearGain(linear) * mul, now)
  }
}

export const audioEngine = new AudioEngine()
