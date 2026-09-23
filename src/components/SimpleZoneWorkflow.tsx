import { useMemo, useState } from 'react'
import { Flag, Play, Square } from 'lucide-react'
import { getCachedBuffer } from '@/audio/bufferCache'
import { auditionConnection, auditionPassage, generateZoneDraft, removeZoneFlag, requestMusic,
  reviewTransition, setMusicSettings, setZoneFlag, startAdaptive, stopAdaptive } from '@/adaptive/actions'
import { musicTime } from '@/adaptive/labels'
import type { MusicSlot } from '@/adaptive/model'
import { useAdaptiveStore } from '@/adaptive/store'
import { chooseFocusedPair, longestExitWait, routesForEachHold, songZones, suggestRoutes, type HoldRoutes, type RouteSuggestion,
  type ZoneFeel } from '@/adaptive/zonePlan'
import { useLoopStore } from '@/store/useLoopStore'
import { PassageWave } from './AdaptiveSongMap'

export function SimpleZoneWorkflow() {
  const loop = useLoopStore()
  const setup = useAdaptiveStore()
  const [cursor, setCursor] = useState(loop.trimStart)
  const pair = useMemo(() => chooseFocusedPair(setup.slots.exploration ?? [], setup.slots.combat ?? [], setup.rules),
    [setup.slots, setup.rules])
  const buffer = getCachedBuffer(loop.bufferId)
  const routes = useMemo(() => {
    if (!pair || !buffer) return null
    const into = suggestRoutes(buffer, [pair.exploration], [pair.combat])
    const back = suggestRoutes(buffer, [pair.combat], [pair.exploration])
    return {
      exploration: routesForEachHold([pair.exploration], [pair.combat], into, setup.rules, setup.reviews)[0],
      combat: routesForEachHold([pair.combat], [pair.exploration], back, setup.rules, setup.reviews)[0],
    }
  }, [pair, buffer, setup.rules, setup.reviews])
  const zones = useMemo(() => songZones(loop.trimStart, loop.trimEnd, setup.zoneFlags),
    [loop.trimStart, loop.trimEnd, setup.zoneFlags])
  const listening = !!setup.audition
  const playhead = setup.audition?.sourceTime ?? cursor
  const span = Math.max(0.001, loop.trimEnd - loop.trimStart)
  const source: MusicSlot = { key: `listen-from-${cursor.toFixed(2)}`, kind: 'passage',
    render: { wrapCrossfadeSec: 0, normalize: false }, candidate: {
      id: 'listen-source', startSec: cursor, endSec: loop.trimEnd, bpm: loop.bpm ?? 120,
      bars: (loop.trimEnd - cursor) * (loop.bpm ?? 120) / 240,
      seamScore: 0, contextScore: 0, homogeneityScore: 0, qualityScore: 0 } }
  const playing = !!setup.playback.current
  const current: ZoneFeel | null = setup.playback.current === 'exploration' || setup.playback.current === 'combat'
    ? setup.playback.current : null
  const next: ZoneFeel = current === 'combat' ? 'exploration' : 'combat'
  const latest = setup.playback.transition
  const focusedTransition = !!(pair && latest && ((latest.fromLoop.key === pair.exploration.key && latest.toLoop.key === pair.combat.key)
    || (latest.fromLoop.key === pair.combat.key && latest.toLoop.key === pair.exploration.key)))
  const review = focusedTransition ? setup.reviews.find(r => r.id === latest?.id) : undefined

  const hearLoop = (slot: MusicSlot) => setup.audition?.slot.key === slot.key
    ? stopAdaptive() : void auditionPassage(slot)
  const topRoute = (state: ZoneFeel): RouteSuggestion | undefined => routes?.[state].approved[0] ?? routes?.[state].suggested[0]
  const hearSwitch = (state: ZoneFeel) => {
    const route = routes?.[state].suggested[0] ?? topRoute(state)
    if (!route) return
    void auditionConnection(state, route.from, state === 'combat' ? 'exploration' : 'combat', route.to,
      pair ? { exploration: pair.exploration.key, combat: pair.combat.key } : undefined,
      route.exitBar, route.entryBar)
  }
  const startPreview = () => {
    if (!pair) return
    void startAdaptive('exploration', pair.exploration, 0,
      { exploration: pair.exploration.key, combat: pair.combat.key })
  }
  const switchFeel = () => {
    if (!current || !pair) return
    if (routes?.[current].approved.length) requestMusic(next)
    else hearSwitch(current)
  }
  const routeLine = (state: ZoneFeel, group: HoldRoutes | undefined) => {
    const destination = state === 'exploration' ? 'Combat' : 'Exploration'
    const count = group?.approved.length ?? 0
    const hasAnother = !!group?.suggested.length
    const longestWait = group && count ? Math.ceil(longestExitWait(group.source, group.approved)) : 0
    const nextWait = group && count && group.suggested[0]
      ? Math.ceil(longestExitWait(group.source, [...group.approved, group.suggested[0]])) : 0
    return <div className="simple-switch" key={state}>
      <div><strong>{state === 'exploration' ? 'Exploration → Combat' : 'Combat → Exploration'}</strong>
        <small>{count ? `${count} Good exit ${count === 1 ? 'point' : 'points'} · largest gap ${longestWait}s${hasAnother && nextWait < longestWait ? ` · next option could bring it to ${nextWait}s` : ''}`
          : 'Needs one listening check'}</small></div>
      <button className="btn" disabled={!topRoute(state) || setup.starting} onClick={() => hearSwitch(state)}>
        {count ? hasAnother ? 'Hear next option' : `Rehear ${destination.toLowerCase()} switch`
          : `Hear ${destination.toLowerCase()} switch`}</button>
    </div>
  }

  return <div className="simple-workflow">
    {pair ? <>
      <div className="simple-intro"><h2>Your two music beds</h2>
        <p>The game can hold either loop for as long as it needs. Listen to the two switches before using them in a level.</p></div>
      <div className="simple-beds">
        {(['exploration', 'combat'] as const).map(state => {
          const slot = pair[state]
          return <div className={`simple-bed simple-bed--${state}`} key={state}>
            <span>{state === 'combat' ? 'Combat' : 'Exploration'}</span>
            <strong>{musicTime(slot.candidate.startSec)}–{musicTime(slot.candidate.endSec)}</strong>
            <small>{slot.candidate.bars} bars · repeats while needed</small>
            <button className="btn btn--small" onClick={() => hearLoop(slot)}>
              {setup.audition?.slot.key === slot.key ? 'Stop' : 'Hear loop'}</button>
          </div>
        })}
      </div>
      <div className="simple-intro"><h2>Check the two switches</h2>
        <p>Hear a switch and mark it Good if the join sounds right. The game keeps playing until the next Good exit. Hear another option to shorten the gaps.</p></div>
      <div className="simple-switches">{routeLine('exploration', routes?.exploration)}{routeLine('combat', routes?.combat)}</div>
      <label className="simple-return-blend">Ease out of combat over
        <select value={setup.settings.combatToExplorationFadeBeats ?? 4} disabled={setup.starting}
          onChange={e => setMusicSettings({ combatToExplorationFadeBeats: Number(e.target.value) })}>
          <option value={1}>1 beat · quick</option>
          <option value={4}>1 bar · gentle</option>
          <option value={8}>2 bars · gradual</option>
        </select>
      </label>
      {focusedTransition && latest && <div className="simple-review" role="group" aria-label="Review the last switch">
        <strong>How did that switch sound?</strong><span>{latest.from === 'combat' ? 'Combat → Exploration' : 'Exploration → Combat'}</span>
        <div className="adaptive__buttons"><button className="btn" aria-pressed={review?.rating === 'good'} onClick={() => reviewTransition('good')}>Good</button>
          <button className="btn" aria-pressed={review?.rating === 'bad'} onClick={() => reviewTransition('bad')}>Bad</button>
          <button className="btn btn--small" onClick={() => useAdaptiveStore.setState(s => ({
            playback: { ...s.playback, transition: null },
          }))}>Dismiss</button></div>
      </div>}
      <div className="simple-preview"><h2>Try it like a game</h2>
        <div className="adaptive__buttons"><button className="btn btn--primary" disabled={setup.starting} onClick={() => playing ? stopAdaptive() : startPreview()}>
          {playing ? 'Stop preview' : 'Start preview'}</button>
          {playing && current && <button className="btn" disabled={setup.starting} onClick={switchFeel}>
            {routes?.[current].approved.length ? `Switch to ${next}` : `Try switch to ${next}`}</button>}</div>
        <small>{current ? `Playing ${current} at ${musicTime(setup.playback.currentSlot?.candidate.startSec ?? 0)}${setup.playback.requested ? ` · next Good exit in ${setup.playback.remaining.toFixed(1)}s` : ''}`
          : 'Starts in exploration. Switch when you want to test combat.'}</small>
      </div>
    </> : <div className="simple-intro"><h2>Mark the song to begin</h2>
      <p>Listen, mark where exploration and combat happen, then build a first draft.</p></div>}

    <details className="simple-markers" open={!pair ? true : undefined}>
      <summary>{pair ? `Edit song markers (${setup.zoneFlags.length})` : 'Listen and mark the song'}</summary>
      <p>Click the waveform to seek. Add a rough flag whenever the feel changes.</p>
      <div className="zone-timeline">
        <button className="zone-wave" type="button" aria-label="Seek in song" onClick={e => {
          if (listening) stopAdaptive()
          const rect = e.currentTarget.getBoundingClientRect()
          setCursor(Math.min(loop.trimEnd - 0.01, loop.trimStart + (e.clientX - rect.left) / rect.width * span))
        }}><PassageWave bufferId={loop.bufferId} start={loop.trimStart} end={loop.trimEnd} />
          <div className="zone-overlay" aria-hidden="true">{zones.map((z, i) => <span key={i}
            className={`zone-band zone-band--${z.state}`}
            style={{ left: `${(z.startSec - loop.trimStart) / span * 100}%`, width: `${(z.endSec - z.startSec) / span * 100}%` }} />)}
            <span className="zone-playhead" style={{ left: `${(playhead - loop.trimStart) / span * 100}%` }} />
          </div></button>
        <input className="zone-scrub" type="range" min={loop.trimStart} max={Math.max(loop.trimStart, loop.trimEnd - 0.01)} step="0.05"
          value={Math.min(loop.trimEnd - 0.01, playhead)} aria-label="Song position"
          onChange={e => { if (listening) stopAdaptive(); setCursor(Number(e.target.value)) }} />
        <div className="zone-times"><span>{musicTime(loop.trimStart)}</span><strong>{musicTime(playhead)}</strong><span>{musicTime(loop.trimEnd)}</span></div>
        <div className="zone-controls"><button className="btn btn--primary" disabled={setup.starting}
          onClick={() => listening ? stopAdaptive() : void auditionPassage(source, 'song')}>
          {listening ? <Square size={15} /> : <Play size={15} />}{listening ? 'Stop' : 'Play from here'}</button>
          <button className="btn zone-mark zone-mark--exploration" onClick={() => setZoneFlag(Math.min(loop.trimEnd - 0.01, playhead), 'exploration')}>
            <Flag size={15} />Mark exploration here</button>
          <button className="btn zone-mark zone-mark--combat" onClick={() => setZoneFlag(Math.min(loop.trimEnd - 0.01, playhead), 'combat')}>
            <Flag size={15} />Mark combat here</button></div>
        {!!setup.zoneFlags.length && <div className="zone-flags" aria-label="Song flags">{setup.zoneFlags.map(f => <div key={f.id}
          className={`zone-flag zone-flag--${f.state}`}><span>{musicTime(f.timeSec)} · {f.state}</span>
          <button className="btn btn--small" onClick={() => removeZoneFlag(f.id)}>Remove</button></div>)}</div>}
      </div>
      <button className="btn btn--primary simple-regenerate" disabled={!setup.zoneFlags.length || setup.starting} onClick={generateZoneDraft}>
        {pair ? 'Update draft from markers' : 'Find loops and switches'}</button>
    </details>
    {setup.error && <p className="adaptive__error" role="alert">{setup.error}</p>}
  </div>
}
