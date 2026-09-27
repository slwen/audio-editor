import { audioEngine } from '@/audio/AudioEngine'
import { downloadBlob } from '@/lib/downloadBlob'
import { peaksForBuffer } from '@/lib/peaks'
import { createLoopArchive } from '@/loop/loopArchive'
import { getOriginalBytes } from '@/persistence/fileBytes'
import { useProjectStore } from '@/store/useProjectStore'
import { analyzeStems, rerankSuggestions, scoreWrap } from './analysisClient'
import { priorFor, snapToGrid, stepOnGrid, type LoopSuggestion } from './analyze'
import type { ExportRequest, ExportResult, RatingsResponse, SongListing, StemStatus } from './api'
import { GameSongPlayer } from './player'
import type { GameSongRatingRecord, WrapRating } from './ratings'
import { gameSongFiles, songIdFromName, titleFromName } from './songJson'
import { initialSongState, saveCalmLevel, saveFolder, useGameSongStore, type GameSongState } from './store'
import { blendSec, BLEND_CHOICES, type BlendChoice } from './wrap'

const API = '/__game-song'
const AUDIO_FILE = /\.(mp3|wav|flac|ogg|m4a|aac)$/i
/** "Hear wrap" starts this long before the wrap and stops this long after it. */
const HEAR_BEFORE_SEC = 4
const HEAR_AFTER_SEC = 6
/** Game's guitar fade (`ADAPTIVE_MIX_TUNING.topFadeSec`). */
const GUITAR_FADE_SEC = 8
/** "Hear fight → calm" plays this long at full before fading, and this long after. */
const FIGHT_LEAD_SEC = 3
const CALM_TAIL_SEC = 6

let stems: { base: AudioBuffer; top: AudioBuffer } | null = null
let player: GameSongPlayer | null = null
let raf = 0
let autoStop: ReturnType<typeof setTimeout> | null = null
let fadeTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let loadGen = 0
let scoreGen = 0

const set = (patch: Partial<GameSongState>) => useGameSongStore.setState(patch)
const get = () => useGameSongStore.getState()

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  const body = await res.json().catch(() => ({ error: `The dev server answered ${res.status}` })) as T & { error?: string }
  if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

const loopKey = (name: string) => `gameSong.loop.${name}`

function savedLoop(name: string): { startSec: number; endSec: number; blend: BlendChoice } | null {
  try {
    const v = JSON.parse(localStorage.getItem(loopKey(name)) ?? 'null') as { startSec?: unknown; endSec?: unknown; blend?: unknown } | null
    if (!v || typeof v.startSec !== 'number' || typeof v.endSec !== 'number' || v.endSec <= v.startSec) return null
    const blend = BLEND_CHOICES.find(b => b.id === v.blend)?.id ?? 'second'
    return { startSec: v.startSec, endSec: v.endSec, blend }
  } catch {
    return null
  }
}

function rememberLoop(): void {
  const { sourceName, loop, blend } = get()
  if (!sourceName || loop.endSec <= loop.startSec) return
  try { localStorage.setItem(loopKey(sourceName), JSON.stringify({ ...loop, blend })) } catch { /* Not persisted. */ }
}

export function currentFadeSec(): number {
  const { analysis, blend } = get()
  return blendSec(blend, analysis?.bpm ?? 120)
}

// ---- Mode ----

export function enterGameSongMode(): void {
  audioEngine.stop()
  useProjectStore.getState().setIsPlaying(false)
  useProjectStore.getState().setEditorMode('game-song')
  void refreshSongs()
}

export function exitGameSongMode(): void {
  stopGameSong()
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  useProjectStore.getState().setEditorMode('edit')
}

async function refreshSongs(): Promise<void> {
  try { set({ songs: await api<SongListing[]>('/songs') }) } catch { /* The list is a convenience. */ }
}

// ---- Step 1: import ----

async function uploadSong(name: string, bytes: ArrayBuffer): Promise<void> {
  set({ importing: true, importError: null })
  try {
    await api<{ name: string }>(`/import?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes })
    await refreshSongs()
    await selectSong(name)
  } catch (err) {
    set({ importError: err instanceof Error ? err.message : 'Import failed' })
  } finally {
    set({ importing: false })
  }
}

export async function importSongFile(file: File): Promise<void> {
  if (!AUDIO_FILE.test(file.name)) {
    set({ importError: 'Choose an audio file (mp3, wav, flac, ogg, m4a).' })
    return
  }
  await uploadSong(file.name, await file.arrayBuffer())
}

/** The clip selected in the editor (or the only one), if its original file is still in memory. */
export function editorSong(): { name: string; bytes: ArrayBuffer } | null {
  const st = useProjectStore.getState()
  const clip = st.clips.find(c => c.id === st.selection[0]) ?? (st.clips.length === 1 ? st.clips[0] : undefined)
  if (!clip) return null
  const meta = st.bufferMeta.find(b => b.id === clip.bufferId)
  const bytes = getOriginalBytes(clip.bufferId)
  if (!meta || !bytes || !AUDIO_FILE.test(meta.name)) return null
  return { name: meta.name, bytes }
}

export async function importFromEditor(): Promise<void> {
  const song = editorSong()
  if (song) await uploadSong(song.name, song.bytes)
}

export async function selectSong(name: string): Promise<void> {
  stopGameSong()
  stems = null
  loadGen++
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  set({ ...initialSongState(), sourceName: name, id: songIdFromName(name), title: titleFromName(name) })
  await refreshStemStatus()
}

// ---- Step 2: split stems ----

async function refreshStemStatus(): Promise<void> {
  const name = get().sourceName
  if (!name) return
  try {
    const status = await api<StemStatus>(`/status?source=${encodeURIComponent(name)}`)
    if (get().sourceName !== name) return
    set({ stems: status })
    if (status.state === 'running') pollTimer = setTimeout(() => void refreshStemStatus(), 1000)
    else if (status.state === 'ready' && get().loading === 'idle') {
      void refreshSongs()
      await loadStems()
    }
  } catch (err) {
    set({ stems: { state: 'error', progress: 0, message: err instanceof Error ? err.message : 'Dev server unavailable',
      demucsInstalled: true, installCommand: '' } })
  }
}

export async function startSplit(): Promise<void> {
  const name = get().sourceName
  if (!name) return
  try {
    set({ stems: await api<StemStatus>(`/split?source=${encodeURIComponent(name)}`, { method: 'POST' }) })
    await refreshStemStatus()
  } catch (err) {
    set({ stems: { ...(get().stems ?? { demucsInstalled: true, installCommand: '' }), state: 'error', progress: 0,
      message: err instanceof Error ? err.message : 'Could not start' } })
  }
}

// ---- Step 3: pick the loop ----

async function fetchRatings(name: string): Promise<RatingsResponse> {
  try {
    return await api<RatingsResponse>(`/ratings?source=${encodeURIComponent(name)}`)
  } catch {
    return { current: [], all: [] }
  }
}

async function loadStems(): Promise<void> {
  const name = get().sourceName
  if (!name) return
  const gen = ++loadGen
  set({ loading: 'loading', loadError: null })
  try {
    const ctx = await audioEngine.init()
    const decode = async (stem: 'base' | 'top') => {
      const res = await fetch(`${API}/stem?source=${encodeURIComponent(name)}&stem=${stem}`)
      if (!res.ok) throw new Error('Could not load the stems')
      return ctx.decodeAudioData(await res.arrayBuffer())
    }
    const [base, top, ratings] = await Promise.all([decode('base'), decode('top'), fetchRatings(name)])
    if (gen !== loadGen) return
    stems = { base, top }
    set({ loading: 'analyzing', peaks: { base: peaksForBuffer(base, 3000), top: peaksForBuffer(top, 3000) },
      ratings: ratings.all, myRatings: ratings.current })
    const { analysis, suggestions } = await analyzeStems(base, top, ratings.all)
    if (gen !== loadGen) return
    const saved = savedLoop(name)
    const first = suggestions[0]
    const loop = saved ?? (first ? { startSec: first.startSec, endSec: first.endSec }
      : { startSec: analysis.introEndSec, endSec: analysis.durationSec * 0.8 })
    const index = suggestions.findIndex(s => Math.abs(s.startSec - loop.startSec) < 1e-3 && Math.abs(s.endSec - loop.endSec) < 1e-3)
    set({ loading: 'ready', analysis, suggestions, suggestionIndex: index >= 0 ? index : null,
      loop: { startSec: loop.startSec, endSec: loop.endSec }, blend: saved?.blend ?? 'second', playhead: 0 })
    void refreshScore()
  } catch (err) {
    if (gen !== loadGen) return
    set({ loading: 'error', loadError: err instanceof Error ? err.message : 'Could not load the stems' })
  }
}

async function refreshScore(): Promise<void> {
  const gen = ++scoreGen
  const { loop } = get()
  try {
    const pGood = await scoreWrap(loop.endSec, loop.startSec, currentFadeSec())
    if (gen === scoreGen) set({ pGood })
  } catch {
    if (gen === scoreGen) set({ pGood: null })
  }
}

function applyLoop(loop: { startSec: number; endSec: number }, suggestionIndex: number | null): void {
  set({ loop, suggestionIndex, exported: null })
  rememberLoop()
  void refreshScore()
  if (get().playing) restartPlayback()
}

export function setMarker(which: 'start' | 'end', sec: number): void {
  const { analysis, snap, loop } = get()
  if (!analysis) return
  const t = snapToGrid(analysis, Math.max(0, Math.min(analysis.durationSec, sec)), snap)
  const next = which === 'start' ? { ...loop, startSec: t } : { ...loop, endSec: t }
  if (next.endSec - next.startSec < 1) return
  if (next.startSec === loop.startSec && next.endSec === loop.endSec) return
  applyLoop(next, null)
}

export function nudgeMarker(which: 'start' | 'end', steps: number): void {
  const { analysis, snap, loop } = get()
  if (!analysis) return
  const t = stepOnGrid(analysis, which === 'start' ? loop.startSec : loop.endSec, snap, steps)
  setMarker(which, t)
}

export function chooseSuggestion(index: number): void {
  const s: LoopSuggestion | undefined = get().suggestions[index]
  if (s) applyLoop({ startSec: s.startSec, endSec: s.endSec }, index)
}

export function nextSuggestion(): void {
  const { suggestions, suggestionIndex } = get()
  if (suggestions.length === 0) return
  chooseSuggestion(suggestionIndex === null ? 0 : (suggestionIndex + 1) % suggestions.length)
  if (get().playing) void hearWrap()
}

export function setBlend(blend: BlendChoice): void {
  set({ blend, exported: null })
  rememberLoop()
  void refreshScore()
  if (get().playing) restartPlayback()
}

export function setSnap(snap: 'bar' | 'beat'): void {
  set({ snap })
}

/** 'mine' is what was clicked on this screen; 'all' also counts the older tools' logs. */
export function currentRating(which: 'mine' | 'all'): WrapRating | null {
  const { ratings, myRatings, loop } = get()
  return priorFor(which === 'mine' ? myRatings : ratings, loop.endSec, loop.startSec)
}

export async function rateWrap(rating: WrapRating): Promise<void> {
  const { sourceName, loop } = get()
  if (!sourceName) return
  const record: GameSongRatingRecord = {
    version: 1,
    at: new Date().toISOString(),
    sourceName,
    exitSec: loop.endSec,
    entrySec: loop.startSec,
    fadeSec: currentFadeSec(),
    rating: currentRating('mine') === rating ? 'clear' : rating,
  }
  try {
    set({ ratingError: null })
    await api('/ratings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) })
    const ratings = await fetchRatings(sourceName)
    set({ ratings: ratings.all, myRatings: ratings.current })
    const suggestions = await rerankSuggestions(ratings.all)
    const current = get().loop
    const index = suggestions.findIndex(s => Math.abs(s.startSec - current.startSec) < 1e-3 && Math.abs(s.endSec - current.endSec) < 1e-3)
    set({ suggestions, suggestionIndex: index >= 0 ? index : null })
  } catch (err) {
    set({ ratingError: err instanceof Error ? err.message : 'Could not save the rating' })
  }
}

// ---- Listening ----

function tick(): void {
  if (!player?.isPlaying) return
  set({ playhead: player.position() })
  raf = requestAnimationFrame(tick)
}

async function play(fromSec: number, stopAfterSec?: number): Promise<void> {
  if (!stems) return
  const ctx = await audioEngine.init()
  if (ctx.state === 'suspended') await ctx.resume()
  audioEngine.stop()
  player ??= new GameSongPlayer(ctx, ctx.destination)
  player.setTopGain(get().quietTop ? get().calmLevel : 1)
  if (fadeTimer) clearTimeout(fadeTimer)
  fadeTimer = null
  if (autoStop) clearTimeout(autoStop)
  autoStop = null
  const { loop } = get()
  player.start(stems.base, stems.top, { ...loop, fadeSec: currentFadeSec() }, fromSec, () => stopGameSong())
  set({ playing: true, playhead: fromSec })
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(tick)
  if (stopAfterSec !== undefined) autoStop = setTimeout(() => stopGameSong(), stopAfterSec * 1000)
}

function restartPlayback(): void {
  if (!player) return
  const at = player.position()
  const { loop } = get()
  // Positions inside the loop keep playing from the same spot; anything else replays the wrap.
  if (at >= loop.startSec && at < loop.endSec - 2) void play(at)
  else void hearWrap()
}

export async function hearWrap(): Promise<void> {
  const { loop } = get()
  const from = Math.max(0, loop.endSec - HEAR_BEFORE_SEC)
  await play(from, loop.endSec - from + HEAR_AFTER_SEC)
}

export async function hearFromStart(): Promise<void> {
  await play(0)
}

/** Guitars at full, then the game's 8 s fade down to the calm level, from inside the loop. */
export async function hearFightToCalm(): Promise<void> {
  const { loop, playhead } = get()
  const from = playhead >= loop.startSec && playhead < loop.endSec ? playhead : loop.startSec
  set({ quietTop: false })
  await play(from, FIGHT_LEAD_SEC + GUITAR_FADE_SEC + CALM_TAIL_SEC)
  fadeTimer = setTimeout(() => {
    fadeTimer = null
    set({ quietTop: true })
    player?.setTopGain(get().calmLevel, GUITAR_FADE_SEC)
  }, FIGHT_LEAD_SEC * 1000)
}

export function setCalmLevel(level: number): void {
  set({ calmLevel: level })
  saveCalmLevel(level)
  if (get().quietTop && !fadeTimer) player?.setTopGain(level)
}

export function stopGameSong(): void {
  if (fadeTimer) clearTimeout(fadeTimer)
  fadeTimer = null
  if (autoStop) clearTimeout(autoStop)
  autoStop = null
  cancelAnimationFrame(raf)
  if (player?.isPlaying) {
    player.stop()
    set({ playhead: player.position() })
  }
  set({ playing: false })
}

export async function toggleGameSongPlayback(): Promise<void> {
  if (get().playing) { stopGameSong(); return }
  await play(get().playhead)
}

export function seekGameSong(sec: number): void {
  set({ playhead: Math.max(0, sec) })
  if (get().playing) void play(sec)
}

export function setQuietTop(quiet: boolean): void {
  set({ quietTop: quiet })
  player?.setTopGain(quiet ? get().calmLevel : 1)
}

// ---- Step 4: export ----

export function setExportField(patch: Partial<Pick<GameSongState, 'id' | 'title' | 'destDir' | 'monoBase' | 'highQuality' | 'trimEnd'>>): void {
  set({ ...patch, exported: null, exportError: null })
  if (patch.destDir !== undefined) saveFolder(patch.destDir)
}

async function runExport(destDir: string): Promise<ExportResult | null> {
  const { sourceName, id, title, analysis, loop, monoBase, highQuality, trimEnd } = get()
  if (!sourceName || !analysis) return null
  const request: ExportRequest = { sourceName, id: id.trim(), title, bpm: analysis.bpm,
    loop: { ...loop, fadeSec: currentFadeSec() }, monoBase, highQuality, trimEnd, destDir }
  set({ exporting: true, exportError: null, exported: null })
  try {
    const result = await api<ExportResult>('/export', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request) })
    set({ exported: result })
    return result
  } catch (err) {
    set({ exportError: err instanceof Error ? err.message : 'Export failed' })
    return null
  } finally {
    set({ exporting: false })
  }
}

export async function exportToGame(): Promise<void> {
  const dir = get().destDir.trim()
  if (!dir) { set({ exportError: 'Enter the game music folder first, or use Download ZIP.' }); return }
  await runExport(dir)
}

export async function downloadZip(): Promise<void> {
  const result = get().exported ?? await runExport('')
  if (!result) return
  const id = result.song.id
  const names = gameSongFiles(id)
  try {
    const entries = await Promise.all([names.base, names.top, names.json].map(async name => {
      const res = await fetch(`${API}/exported?id=${encodeURIComponent(id)}&file=${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error('Export again, then download')
      return { name, bytes: new Uint8Array(await res.arrayBuffer()) }
    }))
    downloadBlob(createLoopArchive(entries), `${id}.zip`)
  } catch (err) {
    set({ exportError: err instanceof Error ? err.message : 'Download failed' })
  }
}
