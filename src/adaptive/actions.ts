import { audioEngine } from '@/audio/AudioEngine'
import { getCachedBuffer } from '@/audio/bufferCache'
import { audioBufferFromChannels, writeWavStereo16 } from '@/audio/wavBytes'
import { downloadBlob } from '@/lib/downloadBlob'
import { createLoopArchive, type ArchiveEntry } from '@/loop/loopArchive'
import { loopRatingKey } from '@/loop/loopRatings'
import { loopRenderOptions } from '@/loop/renderSettings'
import { effectiveLoopCrossfadeSec, renderLoopChannels } from '@/loop/wrapLoop'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'
import { AdaptivePlayer, STOPPED_MUSIC } from './AdaptivePlayer'
import { DEFAULT_MUSIC_SETTINGS, MUSIC_STATES, type MusicSettings, type MusicSlot, type MusicSlots, type MusicState } from './model'
import { saveAdaptive, useAdaptiveStore } from './store'
import { mergeTransitionReviews, syncTransitionRecords } from './transitionRatings'

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
const buffers = new Map<MusicState, AudioBuffer>()

export function stopAdaptive(): void {
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
  let error = ''
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (saved) {
      for (const state of MUSIC_STATES) {
        const slot = saved.slots?.[state] as MusicSlot | undefined
        const c = slot?.candidate
        if (slot && c && Number.isFinite(c.startSec) && Number.isFinite(c.endSec)
          && c.startSec >= 0 && c.endSec > c.startSec && c.endSec <= (buffer?.duration ?? 0)
          && [4, 6, 8, 12, 16].includes(c.bars) && Number.isFinite(c.bpm) && c.bpm > 0
          && Number.isFinite(slot.render?.wrapCrossfadeSec) && slot.render.wrapCrossfadeSec >= 0
          && slot.render.wrapCrossfadeSec <= 1.5 && typeof slot.render.normalize === 'boolean') slots[state] = slot
      }
      const s = saved.settings
      if (s && [0, 1, 2, 4].includes(s.exitBars) && [0, 0.25, 1].includes(s.fadeBeats)
        && [0, 3, 6].includes(s.releaseSec)) settings = s
      if (Array.isArray(saved.reviews)) reviews = saved.reviews.filter((r: { id?: string }) => typeof r?.id === 'string')
      if (MUSIC_STATES.includes(saved.initialState)) initialState = saved.initialState
    } else {
      slots = suggestedSlots()
    }
  } catch { error = 'Saved setup could not be loaded. Choose loops to make a new setup.' }
  if (!slots[initialState]) initialState = MUSIC_STATES.find(state => slots[state]) ?? 'exploration'
  useAdaptiveStore.setState({ open: true, storageKey, slots, settings, reviews, initialState,
    error, playback: STOPPED_MUSIC })
  void syncTransitionFeedback()
}

export function closeAdaptive(): void {
  stopAdaptive()
  useAdaptiveStore.setState({ open: false })
}

export function suggestedSlots(): MusicSlots {
  const loop = useLoopStore.getState()
  const slots: MusicSlots = {}
  const used = new Set<string>()
  for (const state of MUSIC_STATES) {
    const candidate = [...loop.candidates].filter(c => {
      const key = loopRatingKey({ sourceName: loop.sourceName, ...c })
      return c.bars >= 4 && loop.ratings[key] === 'good' && loop.tags[key]?.includes(state)
    }).sort((a, b) => Number(used.has(loopRatingKey({ sourceName: loop.sourceName, ...a })))
      - Number(used.has(loopRatingKey({ sourceName: loop.sourceName, ...b })))
      || b.bars - a.bars || b.qualityScore - a.qualityScore)[0]
    if (candidate) slots[state] = { key: loopRatingKey({ sourceName: loop.sourceName, ...candidate }),
      candidate: { ...candidate }, render: { ...loopRenderOptions(loop, candidate) } }
    if (slots[state]) used.add(slots[state]!.key)
  }
  return slots
}

export function assignMusic(state: MusicState, key: string): void {
  stopAdaptive()
  const loop = useLoopStore.getState()
  const candidate = loop.candidates.find(c => loopRatingKey({ sourceName: loop.sourceName, ...c }) === key)
  const slots = { ...useAdaptiveStore.getState().slots }
  if (candidate) slots[state] = { key, candidate: { ...candidate }, render: { ...loopRenderOptions(loop, candidate) } }
  else delete slots[state]
  const initialState = slots[useAdaptiveStore.getState().initialState]
    ? useAdaptiveStore.getState().initialState : MUSIC_STATES.find(s => slots[s]) ?? 'exploration'
  useAdaptiveStore.setState({ slots, initialState, error: '' })
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
  const rendered = renderLoopChannels(source, slot.candidate.startSec, slot.candidate.endSec, slot.render)
  return audioBufferFromChannels(rendered.sampleRate, rendered.channels)
}

export async function startAdaptive(state = useAdaptiveStore.getState().initialState): Promise<void> {
  audioEngine.stop()
  useProjectStore.getState().setIsPlaying(false)
  const gen = generation
  const setup = useAdaptiveStore.getState()
  if (!setup.slots[state]) {
    useAdaptiveStore.setState({ error: `Assign a loop to ${state} first.` })
    return
  }
  useAdaptiveStore.setState({ starting: true, error: '' })
  try {
    const ctx = await audioEngine.init()
    await ctx.resume()
    if (gen !== generation || !useAdaptiveStore.getState().open) return
    for (const s of MUSIC_STATES) if (setup.slots[s]) buffers.set(s, bake(setup.slots[s]!))
    output = ctx.createGain()
    const project = useProjectStore.getState()
    const clip = project.clips.find(c => c.id === useLoopStore.getState().sourceClipId)
    output.gain.value = project.masterGain * (clip?.gain ?? 1)
    output.connect(ctx.destination)
    player = new AdaptivePlayer(ctx, output)
    player.start(state, setup.slots[state]!, buffers.get(state)!)
    const tick = () => {
      if (!player) return
      const playback = player.snapshot()
      useAdaptiveStore.setState({ playback })
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

export function requestMusic(state: MusicState): void {
  const s = useAdaptiveStore.getState()
  const slot = s.slots[state]
  if (!slot) return
  if (!player) { void startAdaptive(state); return }
  player.request(state, slot, buffers.get(state)!, s.settings)
  useAdaptiveStore.setState({ playback: player.snapshot() })
}

export function reviewTransition(rating: 'good' | 'bad' | undefined, note?: string): void {
  const s = useAdaptiveStore.getState()
  const transition = s.playback.transition
  if (!transition) return
  const previous = s.reviews.find(r => r.id === transition.id) ?? transition
  const review = { ...previous, updatedAt: new Date().toISOString(), ...(rating ? { rating } : {}), ...(note !== undefined ? { note } : {}) }
  useAdaptiveStore.setState({ reviews: [...s.reviews.filter(r => r.id !== review.id), review] })
  saveAdaptive()
  void syncTransitionFeedback()
}

export async function exportAdaptive(): Promise<void> {
  const setup = useAdaptiveStore.getState()
  const loop = useLoopStore.getState()
  const entries: ArchiveEntry[] = []
  const states: Record<string, unknown> = {}
  for (const state of MUSIC_STATES) {
    const slot = setup.slots[state]
    if (!slot) continue
    const rendered = bake(slot)
    entries.push({ name: `${state}.wav`, bytes: new Uint8Array(writeWavStereo16(rendered)) })
    states[state] = { file: `${state}.wav`, ...slot, sampleRate: rendered.sampleRate,
      effectiveWrapCrossfadeSec: effectiveLoopCrossfadeSec(getCachedBuffer(loop.bufferId)!,
        slot.candidate.startSec, slot.candidate.endSec, slot.render.wrapCrossfadeSec),
      sampleCount: rendered.length, loopStartSample: 0, loopEndSample: rendered.length,
      barDurationSec: rendered.duration / slot.candidate.bars }
  }
  if (!entries.length) return
  entries.push({ name: 'adaptive-music.json', bytes: new TextEncoder().encode(JSON.stringify({
    version: 1, source: loop.sourceName, beatsPerBar: 4, initialState: setup.initialState,
    states, settings: setup.settings,
    playbackRules: { requestPolicy: 'latest-request-wins-before-exit', destinationEntrySample: 0,
      exits: 'loop-relative bars, including loop wrap', release: 'delay only on decreasing state rank',
      stateRank: MUSIC_STATES, fade: 'linear complementary gains; minimum 5ms; maximum one outgoing beat or quarter destination loop',
      tempo: 'native per loop; no time stretching', schedulingLeadSec: 0.08 },
    transitionReviews: setup.reviews,
  }, null, 2)) })
  downloadBlob(createLoopArchive(entries), `${loop.sourceName.replace(/[^a-zA-Z0-9_-]/g, '_')}_adaptive.zip`)
}
