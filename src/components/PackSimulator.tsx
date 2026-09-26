import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Shuffle, Square, Zap } from 'lucide-react'
import { audioEngine } from '@/audio/AudioEngine'
import { getCachedBuffer } from '@/audio/bufferCache'
import { stopAdaptive } from '@/adaptive/actions'
import { musicTime } from '@/adaptive/labels'
import type { ZoneFeel } from '@/adaptive/zonePlan'
import { DEFAULT_PACK_MIX, PackLivePlayer, type HeardJoin, type LiveSnapshot } from '@/pack/livePlayer'
import { PACK_VERSION, type Pack } from '@/pack/pack'
import { savePackRating } from '@/pack/packRatings'
import { packReadiness } from '@/pack/simulate'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'

const FEEL_NAME: Record<ZoneFeel, string> = { exploration: 'Exploration', combat: 'Combat' }
const KIND_NAME: Record<HeardJoin['kind'], string> = {
  'natural-switch': 'song continues', switch: 'feel change', hold: 'hold (jump back)', fallback: 'fallback',
  'lead-in': "lead-in (the song's own build)", 'hit-cut': 'hit cut to combat',
}

function describe(join: HeardJoin): string {
  const blend = join.fadeSec >= 0.3 ? `${join.fadeSec.toFixed(1)} s blend` : 'cut'
  const origin = join.source === 'listener' ? 'you approved this before'
    : join.kind === 'hit-cut' ? 'not yet rated' : `P(Good) ${join.p.toFixed(2)}`
  return join.kind === 'natural-switch' ? `${musicTime(join.exitSec)} · the song itself moves on`
    : `${musicTime(join.exitSec)} → ${musicTime(join.entrySec)} · ${blend} · ${origin}`
}

/** `error` is 'none' when the song has no pack yet, 'stale' when its pack predates this runtime. */
async function fetchPack(sourceName: string): Promise<{ pack: Pack | null; error: string }> {
  try {
    const response = await fetch(`/__packs?source=${encodeURIComponent(sourceName)}`, { cache: 'no-store' })
    if (response.status === 404) return { pack: null, error: 'none' }
    if (!response.ok) throw new Error()
    const pack = await response.json() as Pack
    if (pack.version !== PACK_VERSION) return { pack: null, error: 'stale' }
    return { pack, error: '' }
  } catch { return { pack: null, error: 'The pack could not be loaded. Is the dev server running?' } }
}

export function PackSimulator() {
  const loop = useLoopStore()
  const [pack, setPack] = useState<Pack | null>(null)
  const [loadError, setLoadError] = useState('')
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [ratings, setRatings] = useState<Record<number, 'good' | 'bad'>>({})
  const [saveError, setSaveError] = useState('')
  const [chaos, setChaos] = useState(false)
  const [gameMix, setGameMix] = useState(true)
  const player = useRef<PackLivePlayer | null>(null)
  const output = useRef<GainNode | null>(null)

  const load = useCallback(async () => {
    const result = await fetchPack(loop.sourceName)
    setPack(result.pack)
    setLoadError(result.error)
  }, [loop.sourceName])

  const stop = useCallback(() => {
    player.current?.stop()
    player.current = null
    output.current?.disconnect()
    output.current = null
    setSnapshot(null)
    setChaos(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchPack(loop.sourceName).then(result => {
      if (cancelled) return
      setPack(result.pack)
      setLoadError(result.error)
    })
    return () => { cancelled = true }
  }, [loop.sourceName])
  useEffect(() => stop, [stop])
  useEffect(() => {
    if (!snapshot?.playing) return
    const timer = setInterval(() => { if (player.current) setSnapshot(player.current.snapshot()) }, 100)
    return () => clearInterval(timer)
  }, [snapshot?.playing])

  const start = async (feel: ZoneFeel) => {
    const buffer = getCachedBuffer(loop.bufferId)
    if (!pack || !buffer) return
    stopAdaptive()
    audioEngine.stop()
    useProjectStore.getState().setIsPlaying(false)
    stop()
    const ctx = await audioEngine.init()
    await ctx.resume()
    const gain = ctx.createGain()
    const project = useProjectStore.getState()
    gain.gain.value = project.masterGain * (project.clips.find(c => c.id === loop.sourceClipId)?.gain ?? 1)
    gain.connect(ctx.destination)
    output.current = gain
    player.current = new PackLivePlayer(ctx, gain, buffer, pack, gameMix ? { mix: DEFAULT_PACK_MIX } : {})
    player.current.start(feel)
    setSnapshot(player.current.snapshot())
  }

  const request = (feel: ZoneFeel, urgent = false) => {
    if (!player.current) { void start(feel); return }
    player.current.request(feel, urgent)
    setSnapshot(player.current.snapshot())
  }

  const rate = useCallback((join: HeardJoin, rating: 'good' | 'bad') => {
    if (!pack || join.kind === 'natural-switch') return
    setRatings(r => ({ ...r, [join.id]: rating }))
    savePackRating({ version: 1, sourceName: pack.sourceName, packVersion: pack.version, jumpModel: pack.jumpModel,
      at: new Date().toISOString(), rating, note: '',
      join: { kind: join.kind, exitSec: join.exitSec, entrySec: join.entrySec, fadeSec: join.fadeSec, p: join.p,
        from: join.from, to: join.to, source: join.source } })
      .then(() => setSaveError(''))
      .catch(() => setSaveError('Rating not saved to disk. Is the dev server running?'))
  }, [pack])

  const latestRatable = snapshot?.joins.find(j => j.kind !== 'natural-switch')

  useEffect(() => {
    if (!snapshot?.playing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      if (key === 'e') request('exploration')
      else if (key === 'c') request('combat')
      else if (key === 'x') request('combat', true)
      else if (key === 'g' && latestRatable) rate(latestRatable, 'good')
      else if (key === 'b' && latestRatable) rate(latestRatable, 'bad')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!chaos || !snapshot?.playing) return
    const timer = setTimeout(() => {
      const next = snapshot.desired === 'combat' ? 'exploration' : 'combat'
      player.current?.request(next)
    }, (10 + Math.random() * 30) * 1000)
    return () => clearTimeout(timer)
  }, [chaos, snapshot?.playing, snapshot?.desired])

  const readiness = useMemo(() => pack ? packReadiness(pack) : [], [pack])
  const problems = readiness.filter(r => r.holdAfterSec === null || r.longestSwitchWaitSec === null || r.longestSwitchWaitSec > 10)

  if (!pack) {
    const build = <code> npm run build-pack -- "sample_songs/{loop.sourceName}"</code>
    return <section className="pack-sim" aria-label="Pack simulator">
      <div className="pack-sim__heading"><h2>Test the finished pack</h2>
        <button className="btn btn--small" onClick={() => void load()}>Check again</button></div>
      <p>{loadError === 'stale' ? <>This song's pack was built by an older version. Rebuild it with{build}.</>
        : loadError && loadError !== 'none' ? loadError
        : <>No pack has been built for this song yet. Mark the song below, then build it with{build}.</>}</p>
    </section>
  }

  const span = pack.durationSec
  const playing = !!snapshot?.playing
  return <section className="pack-sim" aria-label="Pack simulator">
    <div className="pack-sim__heading"><h2>Test the finished pack</h2>
      <button className="btn btn--small" disabled={playing} onClick={() => void load()}>Reload pack</button></div>
    <p className="pack-sim__meta">{`${pack.zones.length} zones ${pack.zoneSource === 'inferred' ? 'guessed from loudness' : 'from your markers'}`
      + ` · ${pack.jumps.filter(j => j.source === 'listener').length} joins you approved`
      + ` · ${pack.jumps.filter(j => j.source === 'model').length} suggested (P(Good) ≥ ${pack.policy.minP} to play)`
      + (pack.blockedJumps ? ` · ${pack.blockedJumps} you rated Bad removed` : '')}</p>
    {pack.zoneSource === 'inferred' && <p className="adaptive__error">These zones are a guess. Mark exploration and combat below, then rebuild the pack.</p>}
    <div className="pack-sim__strip" aria-hidden="true">
      {pack.zones.map((zone, i) => <div key={i} className={`pack-sim__zone feel-${zone.feel}`}
        style={{ left: `${zone.startSec / span * 100}%`, width: `${(zone.endSec - zone.startSec) / span * 100}%` }} />)}
      {snapshot && <div className="pack-sim__playhead" style={{ left: `${snapshot.sourceSec / span * 100}%` }} />}
    </div>
    <div className="pack-sim__times"><span>0:00</span><span>{musicTime(span)}</span></div>
    <div className="adaptive__states">{(['exploration', 'combat'] as const).map(feel =>
      <button key={feel} className={`btn adaptive__state feel-${feel}${snapshot?.audibleFeel === feel ? ' adaptive__state--active' : ''}`}
        aria-pressed={snapshot?.desired === feel} onClick={() => request(feel)}>
        <strong>{FEEL_NAME[feel]} <kbd>{feel === 'combat' ? 'C' : 'E'}</kbd></strong>
        <span>{!playing ? 'Start here' : snapshot.audibleFeel === feel ? snapshot.desired === feel ? 'Playing' : 'Leaving…'
          : snapshot.desired === feel ? snapshot.releaseLeftSec > 0 ? `Release in ${snapshot.releaseLeftSec.toFixed(1)} s` : 'Switching…' : 'Request'}</span>
      </button>)}</div>
    <div className="adaptive__buttons">
      {playing ? <button className="btn" onClick={stop}><Square size={15} />Stop</button>
        : <button className="btn btn--primary" onClick={() => void start('exploration')}><Play size={15} />Start in exploration</button>}
      <button className="btn feel-combat" disabled={!playing} onClick={() => request('combat', true)}>
        <Zap size={15} />Combat now <kbd>X</kbd></button>
      <label className="adaptive__check" title="Exploration quieter and muffled, combat opens up, holds dip slightly. Applies on the next start.">
        <input type="checkbox" checked={gameMix} disabled={playing} onChange={e => setGameMix(e.target.checked)} />Game mix</label>
      <label className="adaptive__check"><input type="checkbox" checked={chaos} disabled={!playing}
        onChange={e => setChaos(e.target.checked)} /><Shuffle size={14} />Random switches every 10–40 s</label>
      {playing && <span className="pack-sim__now">{snapshot.audibleFeel ? FEEL_NAME[snapshot.audibleFeel] : 'Outside zones'} · {musicTime(snapshot.sourceSec)} in the song</span>}
    </div>
    <section className="pack-sim__joins" aria-label="Transitions you heard" aria-live="polite">
      <h3>Transitions you heard <small>G = Good, B = Bad for the latest</small></h3>
      {!snapshot?.joins.length && <p>Joins appear here as you hear them.</p>}
      {snapshot?.joins.slice(0, 8).map(join => <div key={join.id} className={`pack-sim__join feel-${join.to}`}>
        <div><strong>{join.from ? FEEL_NAME[join.from] : '—'} → {FEEL_NAME[join.to]} · {KIND_NAME[join.kind]}</strong>
          <small>{describe(join)}{join.waitedSec ? ` · waited ${join.waitedSec.toFixed(1)} s` : ''}</small></div>
        {join.kind !== 'natural-switch' && <div className="adaptive__buttons">
          <button className="btn btn--small" aria-pressed={ratings[join.id] === 'good'} onClick={() => rate(join, 'good')}>Good</button>
          <button className="btn btn--small" aria-pressed={ratings[join.id] === 'bad'} onClick={() => rate(join, 'bad')}>Bad</button>
        </div>}
      </div>)}
      {saveError && <p role="alert" className="adaptive__error">{saveError}</p>}
    </section>
    {!!problems.length && <details className="pack-sim__readiness"><summary>{problems.length} zone{problems.length === 1 ? '' : 's'} to check</summary>
      <ul>{problems.map(r => <li key={r.zone}>{FEEL_NAME[r.feel]} {musicTime(r.startSec)}–{musicTime(r.endSec)}:
        {r.holdAfterSec === null ? ' no good hold, so it may drift into the next zone' : ''}
        {r.longestSwitchWaitSec === null ? ' no good switch out' : r.longestSwitchWaitSec > 10 ? ` switching out can take up to ${r.longestSwitchWaitSec.toFixed(0)} s` : ''}</li>)}</ul>
    </details>}
  </section>
}
