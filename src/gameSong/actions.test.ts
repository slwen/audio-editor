import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initialSongState, useGameSongStore } from './store'
import { exitGameSongMode, moveMarkerToBoundary, selectSong } from './actions'
import { analyzeStems, cancelStemAnalysis } from './analysisClient'

const mocks = vi.hoisted(() => {
  const data = new Float32Array(256)
  const buffer = { length: 256, numberOfChannels: 1, sampleRate: 256, duration: 10, getChannelData: () => data }
  return { buffer, decode: vi.fn(async () => buffer), init: vi.fn(), version: 'v1' }
})
vi.mock('@/audio/AudioEngine', () => ({ audioEngine: { init: mocks.init, stop: vi.fn() } }))
vi.mock('./analysisClient', () => ({ analyzeStems: vi.fn(), cancelStemAnalysis: vi.fn(), scoreWrap: vi.fn(async () => 0.5), rerankSuggestions: vi.fn() }))
const analysis = { durationSec: 10, introEndSec: 0, bpm: 120, bars: [{ startSec: 0 }, { startSec: 2 }, { startSec: 4 }, { startSec: 6 }, { startSec: 8 }], beatsSec: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }
let fetchStub: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  useGameSongStore.setState(initialSongState())
  mocks.init.mockResolvedValue({ decodeAudioData: mocks.decode })
  vi.mocked(analyzeStems).mockResolvedValue({ analysis, suggestions: [] } as unknown as Awaited<ReturnType<typeof analyzeStems>>)
  fetchStub = vi.fn(async (url: string) => {
    if (url.includes('/status')) return { ok: true, json: async () => ({ state: 'ready', version: mocks.version }) }
    if (url.includes('/stem?')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
    return { ok: true, json: async () => url.includes('/ratings') ? { current: [], all: [] } : [] }
  })
  vi.stubGlobal('fetch', fetchStub)
})
afterEach(() => { exitGameSongMode(); vi.unstubAllGlobals() })

it('reuses one decoded pair for an unchanged version and reloads changed stems', async () => {
  mocks.version = 'v1'
  await selectSong('cached.wav')
  expect(mocks.decode).toHaveBeenCalledTimes(2)
  await selectSong('cached.wav')
  expect(mocks.decode).toHaveBeenCalledTimes(2)
  expect(fetchStub.mock.calls.filter(([url]) => url.includes('/stem?'))).toHaveLength(2)
  mocks.version = 'v2'
  await selectSong('cached.wav')
  expect(mocks.decode).toHaveBeenCalledTimes(4)
})

it('does not fetch or analyse obsolete stems after asynchronous context initialization', async () => {
  let finish!: (context: unknown) => void
  mocks.init.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = selectSong('cancelled.wav')
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled())
  exitGameSongMode()
  finish({ decodeAudioData: mocks.decode })
  await pending
  expect(fetchStub.mock.calls.filter(([url]) => url.includes('/stem?'))).toHaveLength(0)
  expect(analyzeStems).not.toHaveBeenCalled()
  expect(cancelStemAnalysis).toHaveBeenCalled()
  expect(useGameSongStore.getState().loading).toBe('idle')
})

it('keeps Home/End marker movement on valid grid points with a nonempty loop', () => {
  useGameSongStore.setState({ analysis: analysis as never, snap: 'beat', loop: { startSec: 3, endSec: 7 } })
  moveMarkerToBoundary('start', true)
  expect(useGameSongStore.getState().loop).toEqual({ startSec: 6, endSec: 7 })
  moveMarkerToBoundary('start', false)
  moveMarkerToBoundary('end', false)
  expect(useGameSongStore.getState().loop).toEqual({ startSec: 0, endSec: 1 })
  moveMarkerToBoundary('end', true)
  expect(useGameSongStore.getState().loop.endSec).toBe(9)
})
