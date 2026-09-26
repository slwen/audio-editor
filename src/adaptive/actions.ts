import { audioEngine } from '@/audio/AudioEngine'
import { getCachedBuffer } from '@/audio/bufferCache'
import { audioBufferFromChannels, writeWavStereo16 } from '@/audio/wavBytes'
import { downloadBlob } from '@/lib/downloadBlob'
import { createLoopArchive, type ArchiveEntry } from '@/loop/loopArchive'
import { logLoopRating, type LoopRatingRecord, loopRatingKey } from '@/loop/loopRatings'
import { loopRenderOptions } from '@/loop/renderSettings'
import { effectiveLoopCrossfadeSec, renderLoopChannels, sliceBufferChannels } from '@/loop/wrapLoop'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'
import { AdaptivePlayer, STOPPED_MUSIC } from './AdaptivePlayer'
import { activeMusicSlots, approvedExitPoints, DEFAULT_MUSIC_SETTINGS, MUSIC_STATES, sourcePassage,
  type ApprovedExit, type MusicSettings, type MusicSlot, type MusicSlots, type MusicState, type TransitionRules,
  type TransitionRule, passagePairKey } from './model'
import { saveAdaptive, useAdaptiveStore } from './store'
import { mergeTransitionReviews, syncTransitionRecords } from './transitionRatings'
import { draftZoneLoops, songZones, type ZoneFlag } from './zonePlan'
import { saveSongZones } from '@/pack/songZones'

let syncQueue = Promise.resolve()
export function syncTransitionFeedback(): Promise<void> {
  useAdaptiveStore.setState({ ratingSync: 'saving' })
  syncQueue = syncQueue.then(async () => {
    try {
      const records = await syncTransitionRecords(localStorage)
      const s = useAdaptiveStore.getState()
      useAdaptiveStore.setState({ reviews: mergeTransitionReviews(
        records.filter(r => r.sourceKey === s.storageKey).map(r => r.review), s.reviews), ratingSync: 'saved' })
      if (s.storageKey) saveAdaptive()
    } catch { useAdaptiveStore.setState({ ratingSync: 'error' }) }
  })
  return syncQueue
}

let player: AdaptivePlayer | null = null
let output: GainNode | null = null
let timer: ReturnType<typeof setInterval> | null = null
let generation = 0
const buffers = new Map<string, AudioBuffer>()
const bufferKey = (slot: MusicSlot) => JSON.stringify([slot.key, slot.kind, slot.render])

export function stopAdaptive(): void {
  const audition = useAdaptiveStore.getState().audition
  useAdaptiveStore.setState({ audition: null })
  if (audition) {
    audioEngine.stop()
    useProjectStore.getState().setIsPlaying(false)
  }
  generation++
  if (timer) clearInterval(timer)
  timer = null
  player?.stop()
  player = null
  output?.disconnect()
  output = null
  buffers.clear()
  if (useAdaptiveStore.getState().playback.current || useAdaptiveStore.getState().starting) {
    useProjectStore.getState().setIsPlaying(false)
  }
  useAdaptiveStore.setState(s => ({ playback: { ...STOPPED_MUSIC, transition: s.playback.transition }, starting: false }))
}
const unsubscribeStop = audioEngine.onStop(stopAdaptive)
if (import.meta.hot) import.meta.hot.dispose(() => { stopAdaptive(); unsubscribeStop() })

export function openAdaptive(): void {
  audioEngine.stop()
  useProjectStore.getState().setIsPlaying(false)
  const loop = useLoopStore.getState()
  const buffer = getCachedBuffer(loop.bufferId)
  const storageKey = `adaptive-music-v1:${loop.sourceName}:${buffer?.length}:${buffer?.sampleRate}`
  let slots: MusicSlots = {}
  let settings = { ...DEFAULT_MUSIC_SETTINGS }
  let reviews = useAdaptiveStore.getState().reviews.slice(0, 0)
  let initialState: MusicState = 'exploration'
  const rules: TransitionRules = {}
  let zoneFlags: ZoneFlag[] = []
  let zoneDraft = false
  let error = ''
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (saved) {
      for (const state of MUSIC_STATES) {
        const old = saved.slots?.[state]
        const pool = Array.isArray(old) ? old : old ? [old] : []
        slots[state] = pool.filter((slot: MusicSlot) => {
          const c = slot?.candidate
          return c && Number.isFinite(c.startSec) && Number.isFinite(c.endSec)
            && c.startSec >= 0 && c.endSec > c.startSec && c.endSec <= (buffer?.duration ?? 0)
            && (slot.kind === 'passage' ? Number.isFinite(c.bars) && c.bars > 0 : [4, 6, 8, 12, 16].includes(c.bars))
            && Number.isFinite(c.bpm) && c.bpm > 0
            && Number.isFinite(slot.render?.wrapCrossfadeSec) && slot.render.wrapCrossfadeSec >= 0
            && slot.render.wrapCrossfadeSec <= 1.5 && typeof slot.render.normalize === 'boolean'
        })
      }
      for (const [key, value] of Object.entries(saved.rules ?? {})) {
        const r = value as TransitionRule
        if (r && (r.exitBars === undefined || [0, 1, 2, 4].includes(r.exitBars))
          && (r.exitBar === undefined || Number.isInteger(r.exitBar) && r.exitBar >= 0 && r.exitBar < 16)
          && (r.fadeBeats === undefined || [0, 0.25, 1, 2, 4, 8].includes(r.fadeBeats))
          && (r.entryBar === undefined || Number.isInteger(r.entryBar) && r.entryBar >= 0 && r.entryBar < 16)) {
          const exits = Array.isArray(r.approvedExits) ? r.approvedExits.filter((exit: ApprovedExit) =>
            Number.isInteger(exit?.exitBar) && exit.exitBar >= 0 && exit.exitBar < 16
            && (exit.entryBar === undefined || Number.isInteger(exit.entryBar) && exit.entryBar >= 0 && exit.entryBar < 16)
            && (exit.fadeBeats === undefined || [0, 0.25, 1, 2, 4, 8].includes(exit.fadeBeats))) : undefined
          rules[key] = { ...r, ...(exits ? { approvedExits: exits } : {}) }
        }
      }
      const s = saved.settings
      if (s && [0, 1, 2, 4].includes(s.exitBars) && [0, 0.25, 1, 2, 4, 8].includes(s.fadeBeats)
        && [0, 3, 6].includes(s.releaseSec)) settings = { ...DEFAULT_MUSIC_SETTINGS, ...s,
          combatToExplorationFadeBeats: [1, 4, 8].includes(s.combatToExplorationFadeBeats)
            ? s.combatToExplorationFadeBeats : 4,
          repeats: [1, 2, 4].includes(s.repeats) ? s.repeats : 1,
          approvedOnly: typeof s.approvedOnly === 'boolean' ? s.approvedOnly : false }
      if (Array.isArray(saved.reviews)) reviews = saved.reviews.filter((r: { id?: string }) => typeof r?.id === 'string')
      if (MUSIC_STATES.includes(saved.initialState)) initialState = saved.initialState
      if (Array.isArray(saved.zoneFlags)) zoneFlags = saved.zoneFlags.filter((f: ZoneFlag) =>
        typeof f?.id === 'string' && Number.isFinite(f.timeSec)
        && f.timeSec >= loop.trimStart && f.timeSec < loop.trimEnd
        && (f.state === 'exploration' || f.state === 'combat'))
      zoneDraft = saved.zoneDraft === true
    } else {
      slots = suggestedSlots()
    }
  } catch { error = 'Saved setup could not be loaded. Choose loops to make a new setup.' }
  if (!slots[initialState]?.length) initialState = MUSIC_STATES.find(state => slots[state]?.length) ?? 'exploration'
  useAdaptiveStore.setState({ open: true, storageKey, slots, settings, reviews, initialState, rules, zoneFlags, zoneDraft,
    error, playback: STOPPED_MUSIC })
  void syncTransitionFeedback()
  if (zoneFlags.length) persistZoneFlags()
}

/** Offline pack tools read markers from song-zones.json; the browser copy stays the working state. */
function persistZoneFlags(): void {
  const loop = useLoopStore.getState()
  const { zoneFlags } = useAdaptiveStore.getState()
  saveSongZones({ sourceName: loop.sourceName, trimStartSec: loop.trimStart, trimEndSec: loop.trimEnd, flags: zoneFlags })
    .catch(() => useAdaptiveStore.setState({ error: 'Song markers are saved in this browser but not on disk. Is the dev server running?' }))
}

export function setZoneFlag(timeSec: number, state: 'exploration' | 'combat'): void {
  const loop = useLoopStore.getState()
  if (!Number.isFinite(timeSec) || timeSec < loop.trimStart || timeSec >= loop.trimEnd) return
  const setup = useAdaptiveStore.getState()
  const near = setup.zoneFlags.find(f => Math.abs(f.timeSec - timeSec) < 1)
  const next = near ? setup.zoneFlags.map(f => f.id === near.id ? { ...f, timeSec, state } : f)
    : [...setup.zoneFlags, { id: crypto.randomUUID(), timeSec, state }]
  useAdaptiveStore.setState({ zoneFlags: next.sort((a, b) => a.timeSec - b.timeSec), zoneDraft: false, error: '' })
  saveAdaptive()
  persistZoneFlags()
}

export function removeZoneFlag(id: string): void {
  useAdaptiveStore.setState(s => ({ zoneFlags: s.zoneFlags.filter(f => f.id !== id), zoneDraft: false, error: '' }))
  saveAdaptive()
  persistZoneFlags()
}

export function generateZoneDraft(): void {
  stopAdaptive()
  const loop = useLoopStore.getState()
  const setup = useAdaptiveStore.getState()
  const zones = songZones(loop.trimStart, loop.trimEnd, setup.zoneFlags)
  const { slots, missing } = draftZoneLoops(loop, zones)
  if (!slots.exploration?.length || !slots.combat?.length) {
    useAdaptiveStore.setState({ error: 'Mark both exploration and combat areas that contain loop candidates, then generate again.' })
    return
  }
  useAdaptiveStore.setState({ slots: { ...setup.slots, exploration: slots.exploration, combat: slots.combat },
    initialState: 'exploration', zoneDraft: true,
    settings: { ...setup.settings, approvedOnly: true, advance: false, exitBars: 4, releaseSec: 0 },
    error: missing.length ? `${missing.length} marked area${missing.length === 1 ? '' : 's'} had no usable loop. Try moving its flag or reviewing more loops.` : '' })
  saveAdaptive()
}

export function closeAdaptive(): void {
  stopAdaptive()
  useAdaptiveStore.setState({ open: false })
}

/** Local listening never changes the setup or starts the game simulation. */
export async function auditionPassage(slot: MusicSlot, mode: 'loop' | 'song' = 'loop'): Promise<void> {
  audioEngine.stop()
  const gen = generation
  const loop = useLoopStore.getState()
  useAdaptiveStore.setState({ starting: true, error: '' })
  try {
    const ctx = await audioEngine.init()
    await ctx.resume()
    if (gen !== generation || !useAdaptiveStore.getState().open) return
    const project = useProjectStore.getState()
    const gain = project.clips.find(c => c.id === loop.sourceClipId)?.gain ?? 1
    const { startSec, endSec } = slot.candidate
    const tick = (sourceTime: number) => useAdaptiveStore.setState(s =>
      s.audition ? { audition: { ...s.audition, sourceTime } } : {})
    audioEngine.setMasterGain(project.masterGain)
    if (mode === 'loop' && slot.kind !== 'passage') {
      audioEngine.playLoopingRegion(loop.bufferId, startSec, endSec, gain, tick, startSec, slot.render)
    } else {
      audioEngine.play(startSec, [{ id: 'passage-audition', bufferId: loop.bufferId,
        startTime: startSec, trimStart: startSec, trimEnd: mode === 'song' ? loop.trimEnd : endSec,
        row: 0, layerIndex: 0, gain, speed: 1, fadeInSec: 0.005, fadeOutSec: 0.005 }], project.masterGain,
        () => useProjectStore.getState().setIsPlaying(false), tick)
    }
    useAdaptiveStore.setState({ audition: { slot, mode, sourceTime: startSec }, starting: false })
    useProjectStore.getState().setIsPlaying(true)
  } catch (error) {
    if (gen !== generation) return
    stopAdaptive()
    useAdaptiveStore.setState({ error: error instanceof Error ? error.message : 'Could not audition this passage.' })
  }
}

export function fillTaggedPassages(): void {
  stopAdaptive()
  const old = useAdaptiveStore.getState().slots
  const suggested = suggestedSlots()
  // Filling suggestions must not remove deliberately included song sections.
  storePools(Object.fromEntries(MUSIC_STATES.map(state => [state,
    [...new Map([...(old[state] ?? []), ...(suggested[state] ?? [])].map(slot => [slot.key, slot])).values()]])))
}

export function includeSourceBetween(state: MusicState, from: MusicSlot, to: MusicSlot): void {
  stopAdaptive()
  const loop = useLoopStore.getState()
  const pool = useAdaptiveStore.getState().slots[state] ?? []
  if (!pool.some(p => p.key === from.key) || !pool.some(p => p.key === to.key)) return
  const gap = sourcePassage(loop.sourceName, from, Math.min(loop.trimEnd, to.candidate.startSec))
  if (!gap || pool.some(p => p.key === gap.key)) return
  storePools({ ...useAdaptiveStore.getState().slots, [state]: [...pool, gap] })
}

export function suggestedSlots(): MusicSlots {
  const loop = useLoopStore.getState()
  const slots: MusicSlots = {}
  for (const state of MUSIC_STATES) {
    const choices = [...new Map(loop.candidates.filter(c => {
      const key = loopRatingKey({ sourceName: loop.sourceName, ...c })
      return c.bars >= 4 && loop.ratings[key] === 'good' && loop.tags[key]?.includes(state)
    }).map(c => [loopRatingKey({ sourceName: loop.sourceName, ...c }), c])).values()]
      .sort((a, b) => a.startSec - b.startSec || b.bars - a.bars)
    slots[state] = choices.map(candidate => ({ key: loopRatingKey({ sourceName: loop.sourceName, ...candidate }),
      candidate: { ...candidate }, render: { ...loopRenderOptions(loop, candidate) } }))
  }
  return slots
}

/** Seed a combat-first study from listening-approved cuts without discarding existing setup work. */
export function prepareTwoStateTrial(): { combat: MusicSlot; exploration: MusicSlot } | null {
  stopAdaptive()
  const suggested = suggestedSlots()
  const combat = [...(suggested.combat ?? [])].sort((a, b) =>
    b.candidate.bars - a.candidate.bars || b.candidate.qualityScore - a.candidate.qualityScore)[0]
  const explorations = (suggested.exploration ?? []).filter(p => p.key !== combat?.key &&
    (!combat || p.candidate.endSec <= combat.candidate.startSec))
  const exploration = combat && [...explorations].sort((a, b) =>
    b.candidate.endSec - a.candidate.endSec || b.candidate.bars - a.candidate.bars)[0]
  if (!combat || !exploration) {
    useAdaptiveStore.setState({ error: 'This study needs a Good combat loop and a separate Good exploration loop before it.' })
    return null
  }
  const setup = useAdaptiveStore.getState()
  const front = (state: MusicState, first: MusicSlot) => [first, ...(setup.slots[state] ?? []).filter(p => p.key !== first.key)]
  useAdaptiveStore.setState({
    slots: { ...setup.slots, combat: front('combat', combat), exploration: front('exploration', exploration) },
    initialState: 'combat', settings: { ...setup.settings, exitBars: 4, approvedOnly: true, advance: true }, error: '',
    playback: STOPPED_MUSIC,
  })
  saveAdaptive()
  return { combat, exploration }
}

export function assignMusic(state: MusicState, key: string): void {
  stopAdaptive()
  const loop = useLoopStore.getState()
  const candidate = loop.candidates.find(c => loopRatingKey({ sourceName: loop.sourceName, ...c }) === key)
  if (!candidate) return
  const slots = { ...useAdaptiveStore.getState().slots }
  const pool = slots[state] ?? []
  if (!pool.some(p => p.key === key)) slots[state] = [...pool,
    { key, candidate: { ...candidate }, render: { ...loopRenderOptions(loop, candidate) } }]
  storePools(slots)
}

function storePools(slots: MusicSlots): void {
  const initialState = slots[useAdaptiveStore.getState().initialState]?.length
    ? useAdaptiveStore.getState().initialState : MUSIC_STATES.find(s => slots[s]?.length) ?? 'exploration'
  useAdaptiveStore.setState({ slots, initialState, error: '' })
  saveAdaptive()
}

/** Toggle one feel without removing any other assignments. */
export async function setPassageFeel(key: string, feel: MusicState, enabled: boolean): Promise<boolean> {
  const setup = useAdaptiveStore.getState()
  const slot = MUSIC_STATES.flatMap(state => setup.slots[state] ?? []).find(p => p.key === key)
  if (!slot || setup.starting) return false
  // The running simulator has a prepared library; stop it before changing that library.
  // Inline audition can keep playing the same audio through a tag correction.
  if (setup.playback.current) stopAdaptive()
  const loop = useLoopStore.getState()
  try {
    if (slot.kind !== 'passage') {
      const c = slot.candidate
      const record: LoopRatingRecord = {
        at: new Date().toISOString(), sourceName: loop.sourceName,
        startSec: c.startSec, endSec: c.endSec, bars: c.bars as LoopRatingRecord['bars'],
        bpm: c.bpm, seamScore: c.seamScore, contextScore: c.contextScore,
        homogeneityScore: c.homogeneityScore, qualityScore: c.qualityScore,
        closureScore: c.closureScore, analysisVersion: c.scoreVersion,
        vibeWindowSec: c.scoreVibeWindowSec ?? loop.vibeWindowSec, ...slot.render,
        tags: [...new Set([
          ...(loop.tags[key] ?? []).filter(tag => tag !== feel),
          ...MUSIC_STATES.filter(state => state !== feel && setup.slots[state]?.some(p => p.key === key)),
          ...(enabled ? [feel] : []),
        ])],
      }
      await logLoopRating(record)
      // Do not apply an old song's response to a newly opened source.
      if (useAdaptiveStore.getState().storageKey !== setup.storageKey) return false
      useLoopStore.getState().applyRating(record)
    }
    const current = useAdaptiveStore.getState()
    if (current.storageKey !== setup.storageKey) return false
    const target = current.slots[feel] ?? []
    storePools({ ...current.slots,
      [feel]: enabled ? target.some(p => p.key === key) ? target : [...target, slot]
        : target.filter(p => p.key !== key) })
    return true
  } catch {
    useAdaptiveStore.setState({ error: 'Could not save the new feel. Please try again.' })
    return false
  }
}

export function removePassage(state: MusicState, key: string): void {
  stopAdaptive()
  storePools({ ...useAdaptiveStore.getState().slots,
    [state]: useAdaptiveStore.getState().slots[state]?.filter(s => s.key !== key) })
}

export function addSourceContinuation(state: MusicState, key: string): void {
  stopAdaptive()
  const pool = useAdaptiveStore.getState().slots[state] ?? []
  const from = pool.find(s => s.key === key)
  if (!from) return
  const loop = useLoopStore.getState()
  const beat = 60 / from.candidate.bpm
  const availableBars = Math.floor((loop.trimEnd - from.candidate.endSec + 1e-6) / (beat * 4))
  const bars = [16, 12, 8, 6, 4].find(b => b <= from.candidate.bars && b <= availableBars) as MusicSlot['candidate']['bars'] | undefined
  if (!bars) { useAdaptiveStore.setState({ error: 'Less than four bars remain after this passage.' }); return }
  const candidate = { ...from.candidate, startSec: from.candidate.endSec,
    endSec: from.candidate.endSec + bars * beat * 4, bars, id: crypto.randomUUID(),
    scoreVersion: 'unscored-source-passage', seamScore: 0, contextScore: 0, qualityScore: 0,
    homogeneityScore: 0, closureScore: undefined }
  const next: MusicSlot = { candidate, key: loopRatingKey({ sourceName: loop.sourceName, ...candidate }),
    render: { wrapCrossfadeSec: 0, normalize: false }, kind: 'passage' }
  if (!pool.some(s => s.key === next.key)) storePools({ ...useAdaptiveStore.getState().slots, [state]: [...pool, next] })
}

export function setPairRule(from: MusicSlot, to: MusicSlot, patch: TransitionRule): void {
  stopAdaptive()
  const rules = useAdaptiveStore.getState().rules
  const key = passagePairKey(from, to)
  const changedTiming = (['exitBars', 'exitBar', 'entryBar', 'fadeBeats'] as const)
    .some(field => field in patch && rules[key]?.[field] !== patch[field])
  useAdaptiveStore.setState({ rules: { ...rules, [key]: { ...rules[key], ...patch,
    ...(changedTiming || patch.blocked ? { approved: false, approvedExits: [] } : {}) } },
    ...(changedTiming || patch.blocked ? { playback: STOPPED_MUSIC } : {}) })
  saveAdaptive()
}

export function setMusicSettings(patch: Partial<MusicSettings>): void {
  stopAdaptive()
  useAdaptiveStore.setState(s => ({ settings: { ...s.settings, ...patch } }))
  saveAdaptive()
}

function bake(slot: MusicSlot): AudioBuffer {
  const source = getCachedBuffer(useLoopStore.getState().bufferId)
  if (!source) throw new Error('Source audio is not loaded.')
  const rendered = slot.kind === 'passage' ? sliceBufferChannels(source, slot.candidate.startSec, slot.candidate.endSec)
    : renderLoopChannels(source, slot.candidate.startSec, slot.candidate.endSec, slot.render)
  return audioBufferFromChannels(rendered.sampleRate, rendered.channels)
}

export async function startAdaptive(state = useAdaptiveStore.getState().initialState, firstSlot?: MusicSlot,
  startOffsetSec = 0, focus?: Partial<Record<MusicState, string>>, previewRules?: TransitionRules,
  playbackSettings?: MusicSettings): Promise<void> {
  audioEngine.stop()
  useProjectStore.getState().setIsPlaying(false)
  const gen = generation
  const setup = useAdaptiveStore.getState()
  if (!setup.slots[state]?.length) {
    useAdaptiveStore.setState({ error: `Assign a loop to ${state} first.` })
    return
  }
  useAdaptiveStore.setState({ starting: true, error: '' })
  try {
    const ctx = await audioEngine.init()
    await ctx.resume()
    if (gen !== generation || !useAdaptiveStore.getState().open) return
    const source = getCachedBuffer(useLoopStore.getState().bufferId)!
    const library = Object.fromEntries(MUSIC_STATES.map(s => [s, activeMusicSlots(setup.slots, s, focus).map(slot => {
      if (!buffers.has(bufferKey(slot))) buffers.set(bufferKey(slot), bake(slot))
      const raw = sliceBufferChannels(source, slot.candidate.startSec, slot.candidate.endSec)
      const tail = slot.kind === 'passage' ? sliceBufferChannels(source, slot.candidate.startSec,
        Math.min(source.duration, slot.candidate.endSec + (slot.candidate.endSec - slot.candidate.startSec) / 4)) : undefined
      return { slot, buffer: buffers.get(bufferKey(slot))!, rawBuffer: audioBufferFromChannels(raw.sampleRate, raw.channels),
        tailBuffer: tail ? audioBufferFromChannels(tail.sampleRate, tail.channels) : undefined }
    })]))
    output = ctx.createGain()
    const project = useProjectStore.getState()
    const clip = project.clips.find(c => c.id === useLoopStore.getState().sourceClipId)
    output.gain.value = project.masterGain * (clip?.gain ?? 1)
    output.connect(ctx.destination)
    player = new AdaptivePlayer(ctx, output)
    player.configure(library, playbackSettings ?? setup.settings, { ...setup.rules, ...previewRules })
    const first = firstSlot ? setup.slots[state]!.find(slot => slot.key === firstSlot.key) : setup.slots[state]![0]
    if (!first) throw new Error('The starting section is no longer in this feel.')
    player.start(state, first, buffers.get(bufferKey(first))!, startOffsetSec)
    const tick = () => {
      if (!player) return
      const playback = player.snapshot()
      useAdaptiveStore.setState({ playback })
      if (!playback.current) useProjectStore.getState().setIsPlaying(false)
    }
    tick()
    timer = setInterval(tick, 50)
    useAdaptiveStore.setState({ starting: false })
    useProjectStore.getState().setIsPlaying(true)
  } catch (error) {
    if (gen !== generation) return
    stopAdaptive()
    useAdaptiveStore.setState({ error: error instanceof Error ? error.message : 'Could not start adaptive playback.' })
  }
}

/** A deliberate same-feel move, scheduled on the playing loop's bar grid. */
export function requestBed(state: MusicState, slot: MusicSlot): boolean {
  const setup = useAdaptiveStore.getState()
  if (!setup.slots[state]?.some(available => available.key === slot.key)) return false
  if (!player) { void startAdaptive(state, slot, 0, undefined, undefined, { ...setup.settings, advance: false }); return true }
  const playback = player.snapshot()
  if (playback.current !== state || !playback.currentSlot) return false
  if (setup.rules[passagePairKey(playback.currentSlot, slot)]?.blocked) {
    useAdaptiveStore.setState({ error: 'This section change is blocked. Choose another section.' })
    return false
  }
  const buffer = buffers.get(bufferKey(slot))
  if (!buffer) { useAdaptiveStore.setState({ error: 'This section is not ready. Restart the preview.' }); return false }
  player.request(state, slot, buffer, { ...setup.settings, exitBars: 4, fadeBeats: 4 })
  useAdaptiveStore.setState({ playback: player.snapshot(), error: '' })
  return true
}

/** Audition one directed route without making it available to automatic playback. */
export async function auditionConnection(fromState: MusicState, from: MusicSlot,
  toState: MusicState, to: MusicSlot, focus?: Partial<Record<MusicState, string>>,
  previewExitBar?: number, previewEntryBar?: number): Promise<void> {
  const key = passagePairKey(from, to)
  const rule = useAdaptiveStore.getState().rules[key]
  const barSec = (from.candidate.endSec - from.candidate.startSec) / from.candidate.bars
  const exitBar = previewExitBar ?? approvedExitPoints(rule)[0]?.exitBar ?? rule?.exitBar ?? 0
  const reviewedExit = approvedExitPoints(rule).find(exit => exit.exitBar === exitBar)
  const preroll = from.kind === 'passage' ? 0 : (exitBar === 0 ? from.candidate.bars - 1 : exitBar - 1) * barSec
  useAdaptiveStore.setState(s => ({ playback: { ...s.playback, transition: null } }))
  await startAdaptive(fromState, from, preroll, focus, { [key]: {
    ...rule, approved: false, approvedExits: [], exitBar,
    ...(previewExitBar !== undefined ? { entryBar: previewEntryBar ?? reviewedExit?.entryBar ?? 0,
      fadeBeats: reviewedExit?.fadeBeats ?? 1 } : {}),
  } })
  const setup = useAdaptiveStore.getState()
  const destination = setup.slots[toState]?.find(slot => slot.key === to.key)
  if (!player || !destination) return
  player.request(toState, destination, buffers.get(bufferKey(destination))!, setup.settings)
  useAdaptiveStore.setState({ playback: player.snapshot() })
}

export function requestMusic(state: MusicState): void {
  const s = useAdaptiveStore.getState()
  const slot = s.slots[state]
  if (!slot?.length) return
  if (!player) { void startAdaptive(state); return }
  if (!player.requestState(state)) useAdaptiveStore.setState({ error: 'No reviewed route to this feel. Audition and approve a connection first.' })
  else useAdaptiveStore.setState({ error: '' })
  useAdaptiveStore.setState({ playback: player.snapshot() })
}

export function reviewTransition(rating: 'good' | 'bad' | undefined, note?: string): void {
  const s = useAdaptiveStore.getState()
  const transition = s.playback.transition
  if (!transition) return
  const previous = s.reviews.find(r => r.id === transition.id) ?? transition
  const review = { ...previous, updatedAt: new Date().toISOString(), ...(rating ? { rating } : {}), ...(note !== undefined ? { note } : {}) }
  let rules = s.rules
  if (rating) {
    const key = passagePairKey(review.fromLoop, review.toLoop)
    const sourceBars = review.fromLoop.candidate.bars
    const sourceDuration = review.fromLoop.candidate.endSec - review.fromLoop.candidate.startSec
    const destinationBars = review.toLoop.candidate.bars
    const destinationDuration = review.toLoop.candidate.endSec - review.toLoop.candidate.startSec
    if (review.fromLoop.kind === 'passage') {
      rules = { ...rules, [key]: { ...rules[key], approved: rating === 'good', blocked: rating === 'good' ? false : rules[key]?.blocked } }
    } else {
      const exitBar = Math.round(review.exitOffsetSec / sourceDuration * sourceBars) % sourceBars
      const entryBar = Math.round((review.entryOffsetSec ?? 0) / destinationDuration * destinationBars)
      const previousExits = approvedExitPoints(rules[key])
      const remaining = previousExits.filter(exit => exit.exitBar !== exitBar
        || (rating === 'bad' && (exit.entryBar ?? 0) !== entryBar))
      const approvedExits = rating === 'good'
        ? [...remaining, { exitBar, entryBar, fadeBeats: review.settings.fadeBeats }].sort((a, b) => a.exitBar - b.exitBar)
        : remaining
      rules = { ...rules, [key]: { ...rules[key], approved: approvedExits.length > 0,
        blocked: rating === 'good' ? false : rules[key]?.blocked,
        approvedExits, exitBars: undefined, exitBar: approvedExits[0]?.exitBar,
        entryBar: approvedExits[0]?.entryBar, fadeBeats: approvedExits[0]?.fadeBeats,
      } }
    }
  }
  useAdaptiveStore.setState({ reviews: [...s.reviews.filter(r => r.id !== review.id), review], rules })
  saveAdaptive()
  void syncTransitionFeedback()
}

export async function exportAdaptive(): Promise<void> {
  const setup = useAdaptiveStore.getState()
  const loop = useLoopStore.getState()
  const entries: ArchiveEntry[] = []
  const states: Record<string, unknown> = {}
  for (const state of MUSIC_STATES) {
    states[state] = (setup.slots[state] ?? []).map((slot, i) => {
      const rendered = bake(slot)
      const file = `${state}-${i + 1}.wav`
      entries.push({ name: file, bytes: new Uint8Array(writeWavStereo16(rendered)) })
      const rawFile = `${state}-${i + 1}-entry.wav`
      const raw = sliceBufferChannels(getCachedBuffer(loop.bufferId)!, slot.candidate.startSec, slot.candidate.endSec)
      entries.push({ name: rawFile, bytes: new Uint8Array(writeWavStereo16(audioBufferFromChannels(raw.sampleRate, raw.channels))) })
      const tailFile = slot.kind === 'passage' ? `${state}-${i + 1}-tail.wav` : undefined
      if (tailFile) {
        const source = getCachedBuffer(loop.bufferId)!
        const tail = sliceBufferChannels(source, slot.candidate.startSec,
          Math.min(source.duration, slot.candidate.endSec + (slot.candidate.endSec - slot.candidate.startSec) / 4))
        entries.push({ name: tailFile, bytes: new Uint8Array(writeWavStereo16(audioBufferFromChannels(tail.sampleRate, tail.channels))) })
      }
      return { file, rawEntryFile: rawFile, tailFile, ...slot, sampleRate: rendered.sampleRate,
        effectiveWrapCrossfadeSec: slot.kind === 'passage' ? 0 : effectiveLoopCrossfadeSec(getCachedBuffer(loop.bufferId)!,
          slot.candidate.startSec, slot.candidate.endSec, slot.render.wrapCrossfadeSec),
        sampleCount: rendered.length, loopStartSample: 0, loopEndSample: rendered.length,
        barDurationSec: rendered.duration / slot.candidate.bars }
    })
  }
  if (!entries.length) return
  entries.push({ name: 'adaptive-music.json', bytes: new TextEncoder().encode(JSON.stringify({
    version: 5, source: loop.sourceName, beatsPerBar: 4, initialState: setup.initialState,
    states, settings: setup.settings, pairRules: setup.rules,
    playbackRules: { requestPolicy: 'latest-request-wins-before-exit', destinationEntrySample: 0,
      exits: 'loop-relative bars, including loop wrap; reviewed routes may have several approvedExits and use the next eligible point',
      routing: setup.settings.approvedOnly ? 'approved directed pairs or exact source continuations only; otherwise hold the current loop'
        : 'any unblocked pair may be selected',
      release: 'delay only on decreasing state rank',
      stateRank: MUSIC_STATES, fade: 'linear complementary gains; combat to exploration uses at least combatToExplorationFadeBeats; minimum 5ms; maximum quarter of source and half of destination loop (quarter of one-shot remainder); natural continuation uses raw entry at source boundary',
      tempo: 'native per loop; no time stretching', schedulingLeadSec: 0.08 },
    transitionReviews: setup.reviews,
  }, null, 2)) })
  downloadBlob(createLoopArchive(entries), `${loop.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_')}_adaptive.zip`)
}
