import { create } from 'zustand'
import type { ExportResult, SongListing, StemStatus } from './api'
import type { GameSongAnalysis, LoopSuggestion } from './analyze'
import type { RatedJoin } from './ratings'
import type { BlendChoice } from './wrap'

const DEFAULT_GAME_FOLDER = '/Users/samenoka/projects/crypt-raiders/client/sfx/music/adaptive'
const FOLDER_KEY = 'gameSong.destDir'
const CALM_LEVEL_KEY = 'gameSong.calmLevel'
/** Top-layer level in calm moments; the game fades it between this and 1 (`topLayerOff`). */
const DEFAULT_CALM_LEVEL = 0.1

export type GameSongState = {
  songs: SongListing[]
  sourceName: string | null
  importing: boolean
  importError: string | null
  stems: StemStatus | null
  /** Loading and analysing the stems for step 3. */
  loading: 'idle' | 'loading' | 'analyzing' | 'ready' | 'error'
  loadError: string | null
  peaks: { base: Float32Array; top: Float32Array } | null
  analysis: GameSongAnalysis | null
  suggestions: LoopSuggestion[]
  /** Index into `suggestions` of the one on screen, or null after dragging a marker. */
  suggestionIndex: number | null
  loop: { startSec: number; endSec: number }
  blend: BlendChoice
  snap: 'bar' | 'beat'
  /** Model estimate for the current wrap and blend. */
  pGood: number | null
  ratings: RatedJoin[]
  myRatings: RatedJoin[]
  ratingError: string | null
  quietTop: boolean
  calmLevel: number
  playing: boolean
  playhead: number
  id: string
  title: string
  destDir: string
  monoBase: boolean
  highQuality: boolean
  trimEnd: boolean
  exporting: boolean
  exportError: string | null
  exported: ExportResult | null
}

function savedFolder(): string {
  try { return localStorage.getItem(FOLDER_KEY) ?? DEFAULT_GAME_FOLDER } catch { return DEFAULT_GAME_FOLDER }
}

export function saveFolder(dir: string): void {
  try { localStorage.setItem(FOLDER_KEY, dir) } catch { /* Private mode: keep it for this session only. */ }
}

function savedCalmLevel(): number {
  try {
    const v = Number(localStorage.getItem(CALM_LEVEL_KEY))
    return localStorage.getItem(CALM_LEVEL_KEY) !== null && v >= 0 && v <= 1 ? v : DEFAULT_CALM_LEVEL
  } catch { return DEFAULT_CALM_LEVEL }
}

export function saveCalmLevel(level: number): void {
  try { localStorage.setItem(CALM_LEVEL_KEY, String(level)) } catch { /* Private mode: keep it for this session only. */ }
}

export const initialSongState = (): Omit<GameSongState, 'songs' | 'destDir' | 'monoBase' | 'highQuality' | 'trimEnd' | 'calmLevel'> => ({
  sourceName: null,
  importing: false,
  importError: null,
  stems: null,
  loading: 'idle',
  loadError: null,
  peaks: null,
  analysis: null,
  suggestions: [],
  suggestionIndex: null,
  loop: { startSec: 0, endSec: 0 },
  blend: 'second',
  snap: 'bar',
  pGood: null,
  ratings: [],
  myRatings: [],
  ratingError: null,
  quietTop: false,
  playing: false,
  playhead: 0,
  id: '',
  title: '',
  exporting: false,
  exportError: null,
  exported: null,
})

export const useGameSongStore = create<GameSongState>(() => ({
  ...initialSongState(),
  songs: [],
  destDir: savedFolder(),
  monoBase: false,
  highQuality: false,
  trimEnd: true,
  calmLevel: savedCalmLevel(),
}))
