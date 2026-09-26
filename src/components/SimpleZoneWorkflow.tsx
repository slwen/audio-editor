import { useMemo, useState } from 'react'
import { Flag, Play, Square } from 'lucide-react'
import { getCachedBuffer } from '@/audio/bufferCache'
import { auditionConnection, auditionPassage, generateZoneDraft, removeZoneFlag, requestMusic,
  requestBed, reviewTransition, setMusicSettings, setZoneFlag, startAdaptive, stopAdaptive } from '@/adaptive/actions'
import { musicTime } from '@/adaptive/labels'
import { type MusicSlot } from '@/adaptive/model'
import { useAdaptiveStore } from '@/adaptive/store'
import { assessSectionCoverage, chooseFocusedPair, longestExitWait, nextBed, orderedBeds, reachableSections, routesForEachHold, songZones, suggestRoutes,
  type HoldRoutes, type RouteSuggestion,
  type ZoneFeel } from '@/adaptive/zonePlan'
import { useLoopStore } from '@/store/useLoopStore'
import { PassageWave } from './AdaptiveSongMap'

export function SimpleZoneWorkflow() {
  const loop = useLoopStore()
  const setup = useAdaptiveStore()
  const [cursor, setCursor] = useState(loop.trimStart)
  const [startFeel, setStartFeel] = useState<ZoneFeel>('exploration')
  const [selectedKeys, setSelectedKeys] = useState<Partial<Record<ZoneFeel, string>>>({})
  const [dismissedTransitionId, setDismissedTransitionId] = useState<string | null>(null)
  const beds = useMemo(() => ({ exploration: orderedBeds(setup.slots.exploration ?? []),
    combat: orderedBeds(setup.slots.combat ?? []) }), [setup.slots])
  const coverage = useMemo(() => assessSectionCoverage(beds, setup.rules), [beds, setup.rules])
  const switchReady = coverage.filter(section => section.switchPoints > 0).length
  const longestWait = Math.max(0, ...coverage.map(section => section.longestSwitchWaitSec ?? 0))
  const combatWithoutVariety = coverage.filter(section => section.feel === 'combat' && !section.sameFeelRoutes)
  const pair = useMemo(() => chooseFocusedPair(beds.exploration, beds.combat, setup.rules), [beds, setup.rules])
  const playing = !!setup.playback.current
  const current: ZoneFeel | null = setup.playback.current === 'exploration' || setup.playback.current === 'combat'
    ? setup.playback.current : null
  const chosenExploration = beds.exploration.find(slot => slot.key === selectedKeys.exploration)
    ?? pair?.exploration ?? beds.exploration[0]
  const chosenCombat = beds.combat.find(slot => slot.key === selectedKeys.combat)
    ?? pair?.combat ?? beds.combat[0]
  const startSlot = startFeel === 'combat' ? chosenCombat : chosenExploration
  const reachable = useMemo(() => startSlot
    ? reachableSections(beds, setup.rules, { feel: startFeel, slot: startSlot }) : new Set<string>(),
  [beds, setup.rules, startFeel, startSlot])
  const firstTestReady = !!coverage.length && switchReady === coverage.length
    && reachable.size === coverage.length && longestWait <= 15
  const explorationSource = current === 'exploration' ? setup.playback.currentSlot ?? chosenExploration : chosenExploration
  const combatSource = current === 'combat' ? setup.playback.currentSlot ?? chosenCombat : chosenCombat
  const buffer = getCachedBuffer(loop.bufferId)
  const routes = useMemo(() => {
    if (!explorationSource || !combatSource || !buffer) return null
    const into = suggestRoutes(buffer, [explorationSource], beds.combat)
    const back = suggestRoutes(buffer, [combatSource], beds.exploration)
    return {
      exploration: routesForEachHold([explorationSource], beds.combat, into, setup.rules, setup.reviews)[0],
      combat: routesForEachHold([combatSource], beds.exploration, back, setup.rules, setup.reviews)[0],
    }
  }, [explorationSource, combatSource, beds, buffer, setup.rules, setup.reviews])
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
  const next: ZoneFeel = current === 'combat' ? 'exploration' : 'combat'
  const visibleFeel = current ?? startFeel
  const visibleSlot = current ? setup.playback.currentSlot ?? (current === 'combat' ? chosenCombat : chosenExploration)
    : startFeel === 'combat' ? chosenCombat : chosenExploration
  const visibleBeds = beds[visibleFeel]
  const visibleIndex = visibleBeds.findIndex(slot => slot.key === visibleSlot?.key)
  const sectionName = (feel: ZoneFeel, slot: MusicSlot | undefined) => {
    const index = beds[feel].findIndex(section => section.key === slot?.key)
    const label = feel === 'combat' ? 'Combat' : 'Exploration'
    return index < 0 ? `${label} section at ${musicTime(slot?.candidate.startSec ?? 0)}` : `${label} section ${index + 1}`
  }
  const pendingFeel = setup.playback.requested === 'exploration' || setup.playback.requested === 'combat'
    ? setup.playback.requested : null
  const pendingSlot = setup.playback.nextSlot
  const moveBed = (direction: -1 | 1) => {
    if (visibleBeds.length < 2 || !visibleSlot) return
    const target = direction === 1 ? nextBed(visibleBeds, visibleSlot.key)
      : visibleBeds[(visibleIndex - 1 + visibleBeds.length) % visibleBeds.length]
    if (!target) return
    if (playing && current) {
      if (!requestBed(current, target)) return
    }
    setSelectedKeys(keys => ({ ...keys, [visibleFeel]: target.key }))
  }
  const latest = setup.playback.transition
  const focusedTransition = !!(latest && (latest.from === 'exploration' || latest.from === 'combat')
    && (latest.to === 'exploration' || latest.to === 'combat')
    && beds[latest.from].some(slot => slot.key === latest.fromLoop.key)
    && beds[latest.to].some(slot => slot.key === latest.toLoop.key))
  const review = focusedTransition ? setup.reviews.find(r => r.id === latest?.id) : undefined

  const hearLoop = (slot: MusicSlot) => setup.audition?.slot.key === slot.key
    ? stopAdaptive() : void auditionPassage(slot)
  const topRoute = (state: ZoneFeel): RouteSuggestion | undefined => routes?.[state].approved[0] ?? routes?.[state].suggested[0]
  const hearSwitch = (state: ZoneFeel) => {
    const route = routes?.[state].suggested[0] ?? topRoute(state)
    if (!route) return
    const destination = state === 'combat' ? 'exploration' : 'combat'
    setSelectedKeys(keys => ({ ...keys, [state]: route.from.key, [destination]: route.to.key }))
    void auditionConnection(state, route.from, destination, route.to,
      { [state]: route.from.key, [destination]: route.to.key },
      route.exitBar, route.entryBar)
  }
  const startPreview = () => {
    const first = startFeel === 'combat' ? chosenCombat : chosenExploration
    if (!first) return
    void startAdaptive(startFeel, first, 0, undefined, undefined, { ...setup.settings, advance: false })
  }
  const stopPreview = () => {
    if (current) {
      setStartFeel(current)
      const slot = setup.playback.currentSlot
      if (slot) setSelectedKeys(keys => ({ ...keys, [current]: slot.key }))
    }
    stopAdaptive()
  }
  const switchFeel = () => {
    if (!current || !pair) return
    if (!routes?.[current].approved.length) { hearSwitch(current); return }
    requestMusic(next)
    const target = useAdaptiveStore.getState().playback.nextSlot
    if (target) setSelectedKeys(keys => ({ ...keys, [next]: target.key }))
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
        <small>From the section at {musicTime(group?.source.candidate.startSec ?? 0)}</small>
        <small>{count ? `${count} approved jump ${count === 1 ? 'point' : 'points'} · longest wait ${longestWait}s${hasAnother && nextWait < longestWait ? ` · the next option could shorten it to ${nextWait}s` : ''}`
          : 'Needs one listening check'}</small></div>
      <button className="btn" disabled={!topRoute(state) || setup.starting} onClick={() => hearSwitch(state)}>
        {count ? hasAnother ? 'Hear next option' : `Rehear ${destination.toLowerCase()} switch`
          : `Hear ${destination.toLowerCase()} switch`}</button>
    </div>
  }

  return <div className="simple-workflow">
    {pair ? <>
      <div className="simple-intro"><h2>Explore the song’s sections</h2>
        <p>Each colored block is a short part of the original song. The game can repeat that part for as long as needed, then jump to another part.</p></div>
      <div className={`simple-readiness-banner${firstTestReady ? ' is-ready' : ''}`} role="status"><strong>{firstTestReady ? 'Ready for a first level test'
        : switchReady === coverage.length && reachable.size === coverage.length ? 'Check transition timing' : 'Still building transition coverage'}</strong>
        <span>{switchReady}/{coverage.length} sections can change mood · {reachable.size}/{coverage.length} reachable from this start</span>
        <a href="#music-readiness">See what is left</a></div>
      <div className="simple-song-map" aria-label="Sections in the original song">
        <div className="simple-song-map__top"><strong>Where these sections come from</strong><span>Position in the original song</span></div>
        {(['exploration', 'combat'] as const).map(feel => <div className="simple-song-map__row" key={feel}>
          <span className="simple-song-map__label">{feel === 'combat' ? 'Combat' : 'Exploration'}</span>
          <div className="simple-song-map__track">
            {beds[feel].map((slot, index) => {
              const selected = !playing && visibleFeel === feel && visibleSlot?.key === slot.key
              const active = current === feel && setup.playback.currentSlot?.key === slot.key
              const queued = pendingFeel === feel && pendingSlot?.key === slot.key
              return <span key={slot.key} className={`simple-song-map__section simple-song-map__section--${feel}${selected ? ' is-selected' : ''}${active ? ' is-playing' : ''}${queued ? ' is-queued' : ''}`}
                style={{ left: `${(slot.candidate.startSec - loop.trimStart) / span * 100}%`,
                  width: `${(slot.candidate.endSec - slot.candidate.startSec) / span * 100}%` }}
                title={`${feel} section ${index + 1}: ${musicTime(slot.candidate.startSec)}–${musicTime(slot.candidate.endSec)}`}>{index + 1}</span>
            })}
          </div>
        </div>)}
        <div className="simple-song-map__times"><span>{musicTime(loop.trimStart)}</span><span>{musicTime(loop.trimEnd)}</span></div>
        <small>{playing ? 'Bright outline = playing now' : 'Bright outline = selected starting section'}{pendingSlot ? ' · Dashed outline = next section' : ''}. This map shows the original song, not the order of playback.</small>
      </div>
      <section className="simple-navigator" aria-label="Music section controls">
        {!playing && <div className="simple-feel-picker" role="group" aria-label="Starting feel">
          {(['exploration', 'combat'] as const).map(state => <button key={state} className="btn"
            aria-pressed={startFeel === state} onClick={() => setStartFeel(state)}>
            {state === 'exploration' ? 'Exploration' : 'Combat'}</button>)}
        </div>}
        <div className="simple-navigator__heading"><span>{playing ? 'Playing now' : 'Start with'}</span>
          <strong>{sectionName(visibleFeel, visibleSlot)}</strong>
          <span>{musicTime(visibleSlot?.candidate.startSec ?? 0)}–{musicTime(visibleSlot?.candidate.endSec ?? 0)}
            {visibleSlot ? ' of the original song' : ''}</span></div>
        <div className="simple-playback-flow" aria-label="How playback moves">
          <div className="simple-playback-flow__node"><small>{playing ? 'Playing now' : 'Selected start'}</small>
            <strong>{sectionName(visibleFeel, visibleSlot)}</strong><span>↻ repeats</span></div>
          <div className="simple-playback-flow__arrow">→<small>at a musical point</small></div>
          <div className="simple-playback-flow__node"><small>Up next</small><strong>{pendingFeel && pendingSlot
            ? sectionName(pendingFeel, pendingSlot) : 'Your choice'}</strong></div>
        </div>
        <div className="simple-navigator__controls">
          <button className="btn" disabled={visibleBeds.length < 2 || setup.starting || !!setup.playback.requested}
            onClick={() => moveBed(-1)}>Previous section</button>
          <button className="btn" disabled={visibleBeds.length < 2 || setup.starting || !!setup.playback.requested}
            onClick={() => moveBed(1)}>Next section</button>
        </div>
        <div className="simple-navigator__controls">
          <button className="btn btn--primary" disabled={setup.starting} onClick={() => playing ? stopPreview() : startPreview()}>
            {playing ? 'Stop preview' : 'Start preview'}</button>
          {!playing && visibleSlot && <button className="btn" disabled={setup.starting} onClick={() => hearLoop(visibleSlot)}>
            {setup.audition?.slot.key === visibleSlot.key ? 'Stop section' : 'Hear this section'}</button>}
          {playing && current && <button className="btn" disabled={setup.starting || !!setup.playback.requested} onClick={switchFeel}>
            {routes?.[current].approved.length ? `Switch to ${next}` : `Try switch to ${next}`}</button>}
        </div>
        <small>{pendingFeel && pendingSlot
          ? `Jump to ${sectionName(pendingFeel, pendingSlot)} in about ${setup.playback.remaining.toFixed(1)}s`
          : playing ? 'A move waits for a suitable point in the music; the current section keeps playing until then.'
            : 'Previous and Next choose the starting section. During playback, they request a jump.'}</small>
      </section>
      {focusedTransition && latest && latest.id !== dismissedTransitionId && <div className="simple-review" role="group" aria-label="Review the last switch">
        <strong>Did this jump sound good?</strong><span>{sectionName(latest.from as ZoneFeel, latest.fromLoop)} → {sectionName(latest.to as ZoneFeel, latest.toLoop)}</span>
        <p>Your rating applies to this jump only. A Good jump can be used again.</p>
        <div className="adaptive__buttons"><button className="btn" aria-pressed={review?.rating === 'good'} onClick={() => reviewTransition('good')}>Good — use this jump</button>
          <button className="btn" aria-pressed={review?.rating === 'bad'} onClick={() => reviewTransition('bad')}>Bad — skip this jump</button>
          <button className="btn btn--small" onClick={() => setDismissedTransitionId(latest.id)}>Dismiss</button></div>
      </div>}
      <section className="simple-coverage" id="music-readiness" aria-label="Music section readiness">
        <h2>When is it ready to try in a level?</h2>
        <p>Every section you plan to use needs a Good jump to the other mood. Alternative sections need a Good way in. Then test whether the wait for each jump feels right during play.</p>
        <div className="simple-coverage__stats"><strong>{switchReady}/{coverage.length} can change mood</strong>
          <span>{reachable.size}/{coverage.length} reachable from your selected start</span>
          <span>{longestWait ? `Longest gap between Good exit points: ${Math.ceil(longestWait)}s` : 'No approved mood-change exits yet'}</span></div>
        <p className="simple-coverage__next">{switchReady < coverage.length
          ? `Next: check a jump to the other mood from ${coverage.filter(section => !section.switchPoints).map(section => sectionName(section.feel, section.slot)).join(', ')}.`
          : reachable.size < coverage.length ? `Next: find approved jumps into ${coverage.filter(section => !reachable.has(JSON.stringify([section.feel, section.slot.key]))).map(section => sectionName(section.feel, section.slot)).join(', ')} from sections you can already reach.`
          : longestWait > 15 ? 'All sections can change mood. Add another Good exit to sections with long waits, then try the result in your level.'
            : combatWithoutVariety.length ? `Ready for a first level test. For longer fights, check a same-combat jump from ${combatWithoutVariety.map(section => sectionName(section.feel, section.slot)).join(', ')} so combat can keep changing.`
              : 'Ready for a first level test. Try real fight lengths and rate any jump that still feels awkward.'}</p>
        <details><summary>See each section’s coverage</summary>
          <ul>{coverage.map(section => <li key={`${section.feel}:${section.slot.key}`}>
            <strong>{sectionName(section.feel, section.slot)}</strong>
            <span>{section.switchPoints
              ? `${section.switchPoints} Good mood-change ${section.switchPoints === 1 ? 'point' : 'points'} · longest gap ${Math.ceil(section.longestSwitchWaitSec ?? 0)}s`
              : 'No Good jump to the other mood yet'}</span>
            <span>{section.incomingRoutes} Good {section.incomingRoutes === 1 ? 'way' : 'ways'} in · {section.sameFeelRoutes} Good same-mood {section.sameFeelRoutes === 1 ? 'move' : 'moves'}</span>
          </li>)}</ul>
        </details>
      </section>
      <details className="simple-switch-details"><summary>Find better exploration ↔ combat jumps</summary>
        <p>Listen to a suggested jump from the selected or playing section, then rate what you hear. Approved jumps become available during the preview.</p>
        <div className="simple-switches">{routeLine('exploration', routes?.exploration)}{routeLine('combat', routes?.combat)}</div>
        <label className="simple-return-blend">Ease out of combat over
          <select value={setup.settings.combatToExplorationFadeBeats ?? 4} disabled={setup.starting}
            onChange={e => setMusicSettings({ combatToExplorationFadeBeats: Number(e.target.value) })}>
            <option value={1}>1 beat · quick</option>
            <option value={4}>1 bar · gentle</option>
            <option value={8}>2 bars · gradual</option>
          </select>
        </label>
      </details>
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
