import { approvedExitPoints, choosePassage, followsSource, nextApprovedMusicExit, nextMusicExit, nextMusicExitAtBar, passagePairKey, releaseDelay, type MusicSettings,
  type MusicSlot, type MusicState, type TransitionReview, type TransitionRules } from './model'

type Voice = { source: AudioBufferSourceNode; repeat?: AudioBufferSourceNode; gain: GainNode; state: MusicState;
  slot: MusicSlot; startedAt: number; duration: number; readyAt: number; audioEnd: number }
type Pending = { voice: Voice; when: number; fadeEnd: number; review: TransitionReview; automatic: boolean }
export type PreparedPassage = { slot: MusicSlot; buffer: AudioBuffer; rawBuffer?: AudioBuffer; tailBuffer?: AudioBuffer }
export type MusicLibrary = Partial<Record<MusicState, PreparedPassage[]>>
export type MusicPlayback = { current: MusicState | null; requested: MusicState | null; currentSlot?: MusicSlot;
  nextSlot?: MusicSlot; automatic?: boolean; remaining: number; bar: number; progress: number; transition: TransitionReview | null }
export const STOPPED_MUSIC: MusicPlayback = {
  current: null, requested: null, remaining: 0, bar: 0, progress: 0, transition: null,
}

/** Sources/envelopes are scheduled ahead on the audio clock, independently of UI frames. */
export class AdaptivePlayer {
  private ctx: AudioContext
  private output: AudioNode
  private current: Voice | null = null
  private pending: Pending | null = null
  private retired: { voice: Voice; until: number }[] = []
  private latest: TransitionReview | null = null
  private library: MusicLibrary = {}
  private settings: MusicSettings = { exitBars: 1, fadeBeats: 1, releaseSec: 3 }
  private rules: TransitionRules = {}
  private history: string[] = []

  constructor(ctx: AudioContext, output: AudioNode) { this.ctx = ctx; this.output = output }

  configure(library: MusicLibrary, settings: MusicSettings, rules: TransitionRules): void {
    this.library = library; this.settings = settings; this.rules = rules
  }

  private voice(state: MusicState, slot: MusicSlot, buffer: AudioBuffer, when: number,
    fade: number, offset = 0, rawBuffer?: AudioBuffer): Voice {
    const source = this.ctx.createBufferSource()
    const tail = slot.kind === 'passage' ? this.library[state]?.find(p => p.slot.key === slot.key)?.tailBuffer : undefined
    source.buffer = tail ?? rawBuffer ?? buffer
    source.loop = !rawBuffer && slot.kind !== 'passage'
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(fade ? 0 : 1, when)
    if (fade) gain.gain.linearRampToValueAtTime(1, when + fade)
    source.connect(gain)
    gain.connect(this.output)
    if (offset) source.start(when, offset)
    else source.start(when)
    // Natural arrival plays untouched source audio once, then uses the approved loop wrap.
    let repeat: AudioBufferSourceNode | undefined
    if (rawBuffer && slot.kind !== 'passage') {
      repeat = this.ctx.createBufferSource()
      repeat.buffer = buffer; repeat.loop = true; repeat.connect(gain)
      repeat.start(when + buffer.duration - offset)
    }
    return { source, repeat, gain, state, slot, startedAt: when - offset, duration: buffer.duration, readyAt: when + fade,
      audioEnd: slot.kind === 'passage' ? when - offset + source.buffer.duration : Infinity }
  }

  start(state: MusicState, slot: MusicSlot, buffer: AudioBuffer, offsetSec = 0): void {
    this.stop()
    this.current = this.voice(state, slot, buffer, this.ctx.currentTime + 0.08, 0.01, offsetSec)
    this.history = [slot.key]
    this.planAutomatic()
  }

  private select(state: MusicState): PreparedPassage | undefined {
    const pool = this.library[state] ?? []
    if (!this.current) return pool[0]
    const from = this.current.slot
    const next = choosePassage(pool.map(p => p.slot), from, this.history, this.rules, this.settings.approvedOnly)
    return next ? pool.find(p => p.slot.key === next.key) : undefined
  }

  private routeTiming(state: MusicState, slot: MusicSlot, settings: MusicSettings):
    { when: number; rule: TransitionRules[string] } {
    const from = this.current!
    const rule = this.rules[passagePairKey(from.slot, slot)] ?? {}
    const now = this.ctx.currentTime
    const earliest = Math.max(from.readyAt, now + releaseDelay(from.state, state, settings.releaseSec))
    const approved = from.slot.kind === 'passage' ? undefined : nextApprovedMusicExit(now, from.startedAt,
      from.duration, from.slot.candidate.bars, approvedExitPoints(rule), earliest)
    let when = approved?.when ?? (rule.exitBar !== undefined
      ? nextMusicExitAtBar(now, from.startedAt, from.duration, from.slot.candidate.bars, rule.exitBar, earliest)
      : nextMusicExit(now, from.startedAt, from.duration, from.slot.candidate.bars,
        rule.exitBars ?? settings.exitBars, earliest))
    if (from.slot.kind === 'passage') when = Math.min(when, Math.max(now + 0.002, from.startedAt + from.duration))
    return { when, rule: approved ? { ...rule, ...approved.exit } : rule }
  }

  private selectSoonest(state: MusicState): PreparedPassage | undefined {
    const from = this.current?.slot
    if (!from) return this.library[state]?.[0]
    return (this.library[state] ?? []).filter(p =>
      choosePassage([p.slot], from, this.history, this.rules, true) !== undefined)
      .sort((a, b) => this.routeTiming(state, a.slot, this.settings).when
        - this.routeTiming(state, b.slot, this.settings).when
        || Number(followsSource(from, b.slot)) - Number(followsSource(from, a.slot))
        || a.slot.candidate.startSec - b.slot.candidate.startSec)[0]
  }

  requestState(state: MusicState): boolean {
    this.snapshot()
    if (this.pending?.voice.state === state && !this.pending.automatic) return true
    if (state === this.current?.state) {
      if (!this.pending?.automatic) { this.cancelPending(); this.planAutomatic() }
      return true
    }
    const from = this.current?.slot
    const shared = from && this.library[state]?.find(p => p.slot.key === from.key)
    if (shared && this.current) {
      this.cancelPending()
      this.current.state = state
      this.planAutomatic()
      return true
    }
    const selected = shared ?? (this.settings.approvedOnly ? this.selectSoonest(state) : this.select(state)) ?? (!this.settings.approvedOnly
      ? (this.library[state] ?? []).find(p => !from || !this.rules[passagePairKey(from, p.slot)]?.blocked)
      : undefined)
    if (!selected) return false
    this.request(state, selected.slot, selected.buffer, this.settings)
    return true
  }

  request(state: MusicState, slot: MusicSlot, buffer: AudioBuffer, settings: MusicSettings): void {
    this.snapshot()
    const from = this.current
    if (!from) { this.start(state, slot, buffer); return }
    if (this.pending?.voice.state === state && this.pending.voice.slot.key === slot.key && !this.pending.automatic) return
    this.cancelPending()
    if (slot.key === from.slot.key && state === from.state) {
      this.planAutomatic(); return
    }
    const { when, rule } = this.routeTiming(state, slot, settings)
    this.schedule(state, slot, buffer, settings, when, false, rule)
  }

  private schedule(state: MusicState, slot: MusicSlot, buffer: AudioBuffer, settings: MusicSettings,
    when: number, automatic: boolean, selectedRule?: TransitionRules[string]): void {
    const from = this.current!
    const rule = selectedRule ?? this.rules[passagePairKey(from.slot, slot)] ?? {}
    const offset = Math.min(Math.max(0, Math.ceil(slot.candidate.bars) - 1), Math.max(0, rule.entryBar ?? 0)) * buffer.duration / slot.candidate.bars
    const cycles = (when - from.startedAt) / from.duration
    const atEnd = cycles >= 1 - 1e-6 && Math.abs(cycles - Math.round(cycles)) < 1e-6
    const prepared = this.library[state]?.find(p => p.slot.key === slot.key)
    const natural = followsSource(from.slot, slot) && atEnd && offset === 0
      && !from.slot.render.normalize && !slot.render.normalize && !!prepared?.rawBuffer
    const beatSec = from.duration / (from.slot.candidate.bars * 4)
    const fadeBeats = from.state === 'combat' && state === 'exploration'
      ? Math.max(rule.fadeBeats ?? settings.fadeBeats, settings.combatToExplorationFadeBeats ?? 4)
      : rule.fadeBeats ?? settings.fadeBeats
    const destinationLimit = slot.kind === 'passage' ? (buffer.duration - offset) / 4 : buffer.duration / 2
    const fade = natural ? 0 : Math.min(Math.max(0.005, fadeBeats * beatSec),
      from.duration / 4, destinationLimit, Math.max(0, from.audioEnd - when))
    const voice = this.voice(state, slot, buffer, when, fade, offset, natural ? prepared?.rawBuffer : undefined)
    from.gain.gain.setValueAtTime(fade === 0 ? 0 : 1, when)
    if (fade) from.gain.gain.linearRampToValueAtTime(0, when + fade)
    this.pending = { voice, when, fadeEnd: when + fade, automatic, review: {
      id: crypto.randomUUID(), at: new Date().toISOString(), from: from.state, to: state,
      fromLoop: from.slot, toLoop: slot, settings: { ...settings, ...rule, fadeBeats }, natural,
      exitOffsetSec: atEnd ? from.duration : ((when - from.startedAt) % from.duration + from.duration) % from.duration,
      entryOffsetSec: offset, fadeSec: fade, note: '',
    } }
  }

  private planAutomatic(): void {
    const from = this.current
    if (!from || this.pending || (!this.settings.advance && from.slot.kind !== 'passage')) return
    const selected = this.select(from.state)
    if (!selected) return // A single approved loop remains a valid bed.
    const earliestEnd = from.startedAt + from.duration * (from.slot.kind === 'passage' ? 1 : this.settings.repeats ?? 1)
    // A one-shot cannot wait for another cycle. Its destination is already decoded,
    // so a short original-song gap can finish at its actual end without the manual-request lead time.
    const when = from.slot.kind === 'passage' ? Math.max(this.ctx.currentTime + 0.002, earliestEnd)
      : nextMusicExit(this.ctx.currentTime, from.startedAt, from.duration,
        from.slot.candidate.bars, 0, Math.max(from.readyAt, earliestEnd))
    this.schedule(from.state, selected.slot, selected.buffer, this.settings, when, true)
  }

  private dispose(voice: Voice): void {
    for (const source of [voice.source, voice.repeat]) {
      if (!source) continue
      try { source.stop() } catch { /* already ended */ }
      source.disconnect()
    }
    voice.gain.disconnect()
  }

  private cancelPending(): void {
    if (!this.pending) return
    this.dispose(this.pending.voice)
    this.current?.gain.gain.cancelScheduledValues(this.pending.when)
    this.pending = null
  }

  snapshot(): MusicPlayback {
    const now = this.ctx.currentTime
    if (this.pending && now >= this.pending.when) {
      if (this.current) this.retired.push({ voice: this.current, until: this.pending.fadeEnd })
      this.current = this.pending.voice
      this.latest = this.pending.review
      this.pending = null
      this.history = [...this.history.slice(-15), this.current.slot.key]
      this.planAutomatic()
    }
    this.retired = this.retired.filter(item => {
      if (now < item.until) return true
      this.dispose(item.voice); return false
    })
    if (this.current?.slot.kind === 'passage' && !this.pending && now >= this.current.startedAt + this.current.duration) {
      this.dispose(this.current); this.current = null
    }
    const current = this.current
    const progress = current ? Math.max(0, now - current.startedAt) % current.duration / current.duration : 0
    return { current: current?.state ?? null, currentSlot: current?.slot, nextSlot: this.pending?.voice.slot,
      requested: this.pending?.voice.state ?? null, automatic: this.pending?.automatic,
      remaining: this.pending ? Math.max(0, this.pending.when - now) : 0,
      bar: current ? Math.floor(progress * current.slot.candidate.bars) + 1 : 0, progress, transition: this.latest }
  }

  stop(): void {
    this.cancelPending()
    if (this.current) this.dispose(this.current)
    this.retired.forEach(item => this.dispose(item.voice))
    this.current = null; this.retired = []; this.latest = null; this.history = []
  }
}
