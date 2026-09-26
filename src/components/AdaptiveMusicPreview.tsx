import { useEffect, useState } from 'react'
import { Play, Square, Plus, ArrowRight, Headphones, Music2, Repeat2 } from 'lucide-react'
import { assignMusic, auditionConnection, auditionPassage, closeAdaptive, exportAdaptive, requestMusic, reviewTransition,
  setPassageFeel, removePassage, addSourceContinuation, includeSourceBetween, fillTaggedPassages,
  prepareTwoStateTrial, setMusicSettings, startAdaptive, stopAdaptive, syncTransitionFeedback } from '@/adaptive/actions'
import { CORE_MUSIC_STATES, MUSIC_STATES, followsSource, passagePairKey, sourceGaps, sourcePassage, type MusicSlot, type MusicState } from '@/adaptive/model'
import { saveAdaptive, useAdaptiveStore } from '@/adaptive/store'
import { loadLoopRatings, loopRatingKey } from '@/loop/loopRatings'
import { loopRenderOptions } from '@/loop/renderSettings'
import { useLoopStore } from '@/store/useLoopStore'
import { AdaptiveSongMap, PassageWave } from './AdaptiveSongMap'
import { FEEL_LABELS, musicTime } from '@/adaptive/labels'
import { AdaptiveConnectionEditor } from './AdaptiveConnectionEditor'
import { SimpleZoneWorkflow } from './SimpleZoneWorkflow'
import { PackSimulator } from './PackSimulator'

export function AdaptiveMusicPreview() {
  const setup = useAdaptiveStore()
  const loop = useLoopStore()
  const [feel, setFeel] = useState<MusicState>(setup.slots.combat?.length ? 'combat' : setup.initialState)
  const [showOtherFeels, setShowOtherFeels] = useState(false)
  const [routeFrom, setRouteFrom] = useState('')
  const [routeTo, setRouteTo] = useState('')
  const [selected, setSelected] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [includeUnrated, setIncludeUnrated] = useState(false)
  const [allFeels, setAllFeels] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [changingFeel, setChangingFeel] = useState(false)
  const [connection, setConnection] = useState<{ from: MusicSlot; to: MusicSlot } | null>(null)
  const { playback, slots, settings, audition } = setup
  const playing = !!playback.current
  const locked = playing || setup.starting
  const pool = [...(slots[feel] ?? [])].sort((a, b) => a.candidate.startSec - b.candidate.startSec)
  const gaps = sourceGaps(pool)
  const transition = playback.transition
  const review = setup.reviews.find(r => r.id === transition?.id)
  const position = audition?.sourceTime ?? (playback.currentSlot
    ? playback.currentSlot.candidate.startSec + playback.progress * (playback.currentSlot.candidate.endSec - playback.currentSlot.candidate.startSec) : undefined)
  const options = [...new Map(loop.candidates.filter(c => {
    const key = loopRatingKey({ sourceName: loop.sourceName, ...c })
    const rating = loop.ratings[key]
    return c.bars >= 4 && (rating === 'good' || (includeUnrated && rating !== 'bad'))
      && (allFeels || !loop.tags[key]?.length || loop.tags[key]?.includes(feel))
  }).map(c => [loopRatingKey({ sourceName: loop.sourceName, ...c }), c])).entries()]
    .sort((a, b) => a[1].startSec - b[1].startSec || b[1].bars - a[1].bars)
  const visibleStates = showOtherFeels ? MUSIC_STATES : CORE_MUSIC_STATES
  const routeOptions = CORE_MUSIC_STATES.flatMap(state => (slots[state] ?? [])
    .filter(slot => slot.kind !== 'passage').map(slot => ({ id: `${state}|${slot.key}`, state, slot })))
  const fromRoute = routeOptions.find(p => p.id === routeFrom)
    ?? [...routeOptions].filter(p => p.state === 'combat').sort((a, b) => b.slot.candidate.bars - a.slot.candidate.bars)[0]
    ?? routeOptions[0]
  const toRoute = routeOptions.find(p => p.id === routeTo && p.id !== fromRoute?.id)
    ?? routeOptions.find(p => p.state !== fromRoute?.state)
  const routeRule = fromRoute && toRoute ? setup.rules[passagePairKey(fromRoute.slot, toRoute.slot)] : undefined

  useEffect(() => {
    let cancelled = false
    void loadLoopRatings().then(records => {
      if (!cancelled) useLoopStore.getState().replaceRatings(records)
    }).catch(() => { if (!cancelled) useAdaptiveStore.setState({ error: 'Could not load loop ratings.' }) })
    return () => { cancelled = true; stopAdaptive() }
  }, [])

  const hear = (slot: MusicSlot, mode: 'loop' | 'song' = 'loop') => {
    setSelected(slot.key)
    if (audition?.slot.key === slot.key && audition.mode === mode) stopAdaptive()
    else void auditionPassage(slot, mode)
  }
  const listening = (p: MusicSlot, mode: 'loop' | 'song' = 'loop') => audition?.slot.key === p.key && audition.mode === mode
  const selectOnMap = (state: MusicState, key: string) => {
    setFeel(state); setSelected(key); setLibraryOpen(false)
    requestAnimationFrame(() => document.getElementById(`music-card-${encodeURIComponent(key)}`)?.scrollIntoView({ block: 'nearest' }))
  }
  const editConnection = (from: MusicSlot, to: MusicSlot) => {
    stopAdaptive(); setConnection({ from, to })
    document.querySelector('.adaptive')?.scrollTo({ top: 0 })
  }
  const wholeSong: MusicSlot = { key: 'whole-source', kind: 'passage', render: { wrapCrossfadeSec: 0, normalize: false },
    candidate: { id: 'whole-source', startSec: loop.trimStart, endSec: loop.trimEnd,
      bars: (loop.trimEnd - loop.trimStart) * (loop.bpm ?? 120) / 240, bpm: loop.bpm ?? 120,
      seamScore: 0, contextScore: 0, qualityScore: 0, homogeneityScore: 0 } }

  return <section className="adaptive adaptive--studio" aria-label="Adaptive music preview">
    <div className="adaptive__heading">
      <div><h1>Build an adaptive soundtrack</h1><p>{loop.sourceName}</p></div>
      <button className="btn" onClick={closeAdaptive}>Back to loops</button>
    </div>
    <PackSimulator />
    <SimpleZoneWorkflow />
    <details className="zone-advanced"><summary>More loop choices, timing and export</summary>
    <div className="music-studio">
      <div className="music-workspace">
        {connection && <AdaptiveConnectionEditor from={connection.from} to={connection.to} onClose={() => setConnection(null)} />}
        <section className="music-source">
          <div className="music-section-heading"><h2>1. Find your way around the song</h2>
            <button className="btn btn--small" disabled={setup.starting} onClick={() => hear(wholeSong, 'song')}>
              {listening(wholeSong, 'song') ? <Square size={14} /> : <Headphones size={14} />}{listening(wholeSong, 'song') ? 'Stop listening' : 'Hear whole song'}</button></div>
          <AdaptiveSongMap bufferId={loop.bufferId} start={loop.trimStart} end={loop.trimEnd}
            slots={slots} position={position} selected={selected} onSelect={selectOnMap} />
        </section>
        <section className={`music-arrangement feel-${feel}`}>
          <div className="music-section-heading"><h2>2. Arrange a feel</h2>
            <button className="btn btn--small" disabled={locked} onClick={fillTaggedPassages}>Add Good tagged loops</button></div>
          <div className="music-feels" role="group" aria-label="Arrange passages by feel">
            {visibleStates.map(state => <button key={state} className={`feel-${state}`} aria-pressed={feel === state}
              onClick={() => { setFeel(state); setSelected(''); setLibraryOpen(false) }}>{FEEL_LABELS[state]} <span>{slots[state]?.length ?? 0}</span></button>)}
            <button className="btn btn--small" aria-pressed={showOtherFeels} onClick={() => setShowOtherFeels(!showOtherFeels)}>{showOtherFeels ? 'Focus on exploration + combat' : 'Show other feels'}</button>
          </div>
          <div className="music-section-heading"><p>Loops can hold. Song passages carry you forward. Listen before deciding.</p>
            <button className="btn btn--primary" disabled={setup.starting} onClick={() => setLibraryOpen(!libraryOpen)}><Plus size={16} />{libraryOpen ? 'Close browser' : 'Browse loops'}</button></div>
          {libraryOpen && <section className="music-library" aria-label={`Browse loops for ${FEEL_LABELS[feel]}`}>
            <div className="music-section-heading"><h3>Listen, then add to {FEEL_LABELS[feel]}</h3></div>
            <div className="adaptive__buttons">
              <label className="adaptive__check"><input type="checkbox" checked={allFeels} onChange={e => setAllFeels(e.target.checked)} />All feels</label>
              <label className="adaptive__check"><input type="checkbox" checked={includeUnrated} onChange={e => setIncludeUnrated(e.target.checked)} />Include unrated</label>
            </div>
            {!options.length && <p>No matching loops. Try All feels or include unrated candidates.</p>}
            <div className="music-library__list">{options.map(([key, c]) => {
              const p: MusicSlot = { key, candidate: c, render: loopRenderOptions(loop, c) }
              const added = pool.some(s => s.key === key)
              return <div key={key} className={`music-library__item${listening(p) ? ' is-listening' : ''}`}>
                <button className="btn btn--icon" aria-label={`${listening(p) ? 'Stop' : 'Hear'} loop at ${musicTime(c.startSec)}`} onClick={() => hear(p)}>
                  {listening(p) ? <Square size={16} /> : <Play size={16} />}</button>
                <div><strong>{musicTime(c.startSec)}–{musicTime(c.endSec)}</strong><small>{c.bars} bars · {loop.ratings[key] === 'good' ? 'Good' : 'Unrated'}{loop.tags[key]?.length ? ` · ${loop.tags[key].join(', ')}` : ''}</small></div>
                <PassageWave bufferId={loop.bufferId} start={c.startSec} end={c.endSec} />
                <button className="btn btn--small" disabled={locked || added} onClick={() => { assignMusic(feel, key); setSelected(key) }}>{added ? 'Added' : 'Add'}</button>
              </div>
            })}</div>
          </section>}
          {!pool.length && <div className="music-empty"><Music2 size={28} /><h3>No {FEEL_LABELS[feel].toLowerCase()} sections yet</h3>
            <p>Browse and listen to your loops, then add one here. You can build variety gradually.</p>
            <button className="btn" onClick={() => setLibraryOpen(true)}>Browse loops</button></div>}
          <div className="music-passages">{pool.map((p, index) => {
            const gap = gaps.find(g => g.from.key === p.key)
            const gapSlot = gap ? sourcePassage(loop.sourceName, p, gap.to.candidate.startSec) : null
            const next = pool[index + 1]
            return <div key={p.key}>
              <article id={`music-card-${encodeURIComponent(p.key)}`} className={`music-passage${selected === p.key ? ' is-selected' : ''}${audition?.slot.key === p.key ? ' is-listening' : ''}`}>
                <div className="music-passage__heading"><span className="music-passage__type">{p.kind === 'passage' ? <ArrowRight size={16} /> : <Repeat2 size={16} />}{p.kind === 'passage' ? 'Original song passage' : 'Loop / hold point'}</span>
                  <button className="btn btn--small" disabled={locked} aria-label={`Remove section at ${musicTime(p.candidate.startSec)}`} onClick={() => removePassage(feel, p.key)}>Remove</button></div>
                <div className="music-passage__body"><div><h3>{musicTime(p.candidate.startSec)}–{musicTime(p.candidate.endSec)}</h3>
                  <small>{p.kind === 'passage' ? `${(p.candidate.endSec - p.candidate.startSec).toFixed(1)}s · plays once · mood unreviewed` : `${p.candidate.bars} bars · ${loop.ratings[p.key] === 'bad' ? 'Marked Bad' : 'Can repeat'}`}</small></div>
                  <PassageWave bufferId={loop.bufferId} start={p.candidate.startSec} end={p.candidate.endSec} /></div>
                <div className="adaptive__buttons">
                  <fieldset className="music-passage-feels" disabled={setup.starting || changingFeel}>
                    <legend>Feels · choose any</legend>
                    {MUSIC_STATES.map(state => <label key={state} className={`adaptive__check feel-${state}`}>
                      <input type="checkbox"
                        aria-label={`${FEEL_LABELS[state]} for section at ${musicTime(p.candidate.startSec)}`}
                        checked={!!slots[state]?.some(slot => slot.key === p.key)}
                        onChange={async e => {
                          const enabled = e.target.checked
                          setChangingFeel(true)
                          try {
                            if (await setPassageFeel(p.key, state, enabled)) setConnection(null)
                          } finally { setChangingFeel(false) }
                        }} />
                      {FEEL_LABELS[state]}
                    </label>)}
                  </fieldset>
                  <button className="btn" disabled={setup.starting} onClick={() => hear(p)}>{listening(p) ? <Square size={15} /> : <Play size={15} />}{listening(p) ? 'Stop' : p.kind === 'passage' ? 'Hear passage' : 'Hear loop'}</button>
                  <button className="btn btn--small" disabled={setup.starting} onClick={() => hear(p, 'song')}>{listening(p, 'song') ? 'Stop song' : 'Hear song from here'}</button>
                  {!gap && !next && <button className="btn btn--small" disabled={locked} onClick={() => addSourceContinuation(feel, p.key)}>Include following bars</button>}
                </div>
              </article>
              {gap && gapSlot && <div className="music-gap">
                <div><strong>{(gap.to.candidate.startSec - p.candidate.endSec).toFixed(1)}s of the song between these sections</strong>
                  <p>{musicTime(p.candidate.endSec)} → {musicTime(gap.to.candidate.startSec)} · Currently skipped for {FEEL_LABELS[feel].toLowerCase()}. The mood may change here.</p></div>
                <div className="adaptive__buttons"><button className="btn btn--small" disabled={setup.starting} onClick={() => hear(gapSlot)}>{listening(gapSlot) ? 'Stop gap' : 'Hear gap'}</button>
                  <button className="btn btn--small" disabled={locked} onClick={() => includeSourceBetween(feel, p, gap.to)}>Include this part of the song</button>
                  <button className="btn btn--small" onClick={() => editConnection(p, gap.to)}>Tune the jump instead</button></div>
              </div>}
              {!gap && next && followsSource(p, next) && <div className="music-flow"><ArrowRight size={14} />Original song continues into the next section</div>}
            </div>
          })}</div>
          <p className="adaptive__hint">These are options for {FEEL_LABELS[feel].toLowerCase()}. With reviewed routes on, a loop holds until a source continuation or approved connection is available.</p>
        </section>
      </div>
      <aside className="music-simulator" aria-label="Game simulator">
        <h2>3. Build and test the route</h2><p>Combat can repeat for an entire fight. Hear each exit back to exploration before the game uses it.</p>
        <section className="route-lab" aria-label="Audition a connection">
          <h3>Combat-first study</h3>
          <p>Use your longest Good combat loop and the nearest earlier Good exploration loop. Existing passages stay available.</p>
          <button className="btn" disabled={setup.starting} onClick={() => {
            const pair = prepareTwoStateTrial()
            if (!pair) return
            setFeel('combat'); setRouteFrom(`combat|${pair.combat.key}`); setRouteTo(`exploration|${pair.exploration.key}`)
          }}>Prepare two-state study</button>
          <h3>Try one connection</h3>
          <label>From<select aria-label="Route from" value={fromRoute?.id ?? ''} onChange={e => { setRouteFrom(e.target.value); setRouteTo('') }}>
            {routeOptions.map(p => <option key={p.id} value={p.id}>{FEEL_LABELS[p.state]} · {musicTime(p.slot.candidate.startSec)}–{musicTime(p.slot.candidate.endSec)} · {p.slot.candidate.bars} bars</option>)}
          </select></label>
          <label>To<select aria-label="Route to" value={toRoute?.id ?? ''} onChange={e => setRouteTo(e.target.value)}>
            {routeOptions.filter(p => p.id !== fromRoute?.id).map(p => <option key={p.id} value={p.id}>{FEEL_LABELS[p.state]} · {musicTime(p.slot.candidate.startSec)}–{musicTime(p.slot.candidate.endSec)}</option>)}
          </select></label>
          <p>{routeRule?.approved ? 'Approved for normal playback' : 'Needs a Good review before normal playback'}{routeRule?.blocked ? ' · currently avoided' : ''}</p>
          <div className="adaptive__buttons">
            <button className="btn btn--primary" disabled={setup.starting || !fromRoute || !toRoute} onClick={() => {
              if (fromRoute && toRoute) void auditionConnection(fromRoute.state, fromRoute.slot, toRoute.state, toRoute.slot)
            }}>Hear this join</button>
            <button className="btn" disabled={!fromRoute || !toRoute} onClick={() => {
              if (fromRoute && toRoute) editConnection(fromRoute.slot, toRoute.slot)
            }}>Set exit and blend</button>
          </div>
        </section>
        <div className="adaptive__states">{visibleStates.map(state => <button key={state}
          className={`btn adaptive__state feel-${state}${playback.current === state ? ' adaptive__state--active' : ''}`}
          disabled={!slots[state]?.length || setup.starting} aria-pressed={playback.current === state} onClick={() => requestMusic(state)}>
          <strong>{FEEL_LABELS[state]}</strong><span>{!slots[state]?.length ? 'Add a section first' : playback.requested === state && !playback.automatic ? 'Requested' : playback.current === state ? 'Playing' : 'Request'}</span>
        </button>)}</div>
        <div className="music-listening" aria-live="polite">
          {audition ? <><Headphones size={18} /><strong>Listening only</strong><span>{audition.mode === 'song' ? 'Original song from' : 'Section at'} {musicTime(audition.slot.candidate.startSec)} · {musicTime(audition.sourceTime)}</span>
            <button className="btn btn--small" onClick={stopAdaptive}>Stop listening</button></>
            : playing ? <><strong>{FEEL_LABELS[playback.current!]} · {playback.currentSlot?.kind === 'passage' ? 'playing through' : 'repeating section'}</strong>
              <span>Now: {musicTime(playback.currentSlot!.candidate.startSec)}–{musicTime(playback.currentSlot!.candidate.endSec)}</span>
              <span>{playback.nextSlot ? `Next: ${musicTime(playback.nextSlot.candidate.startSec)} · ${playback.automatic ? followsSource(playback.currentSlot!, playback.nextSlot) ? 'song continues' : 'another section' : FEEL_LABELS[playback.requested!]}` : 'Holding this loop'}</span></>
              : <><strong>{setup.starting ? 'Preparing audio…' : 'Game preview stopped'}</strong><span>Listening to a card is separate from testing game changes.</span></>}
        </div>
        {playing && <div className="adaptive__position"><span>{playback.requested ? `Change in ${playback.remaining.toFixed(1)}s` : 'Repeating'}</span>
          <progress value={playback.progress} max={1} aria-label="Section progress" /></div>}
        <div className="adaptive__buttons"><button className="btn btn--primary" disabled={setup.starting || (!playing && !audition && !slots[setup.initialState]?.length)}
          onClick={() => playing || audition ? stopAdaptive() : void startAdaptive()}>{playing || audition ? 'Stop audio' : 'Start game preview'}</button>
          <button className="btn" disabled={locked || exporting || !slots[setup.initialState]?.length} onClick={async () => {
            setExporting(true)
            try { await exportAdaptive() } catch (error) { useAdaptiveStore.setState({ error: error instanceof Error ? error.message : 'Export failed.' }) }
            finally { setExporting(false) }
          }}>{exporting ? 'Exporting…' : 'Export pack'}</button></div>
        {setup.error && <p role="alert" className="adaptive__error">{setup.error}</p>}
        <details className="music-settings"><summary>Playback behaviour</summary><fieldset disabled={locked}>
          <label>Starting feel<select value={setup.initialState} onChange={e => { useAdaptiveStore.setState({ initialState: e.target.value as MusicState }); saveAdaptive() }}>
            {MUSIC_STATES.map(state => <option key={state} value={state} disabled={!slots[state]?.length}>{FEEL_LABELS[state]}</option>)}</select></label>
          <label className="adaptive__check"><input type="checkbox" checked={settings.advance !== false} onChange={e => setMusicSettings({ advance: e.target.checked })} />Let the music move through sections</label>
          <label className="adaptive__check"><input type="checkbox" checked={settings.approvedOnly !== false} onChange={e => setMusicSettings({ approvedOnly: e.target.checked })} />Only use reviewed jumps</label>
          <label>Repeat a loop before moving on<select value={settings.repeats ?? 1} onChange={e => setMusicSettings({ repeats: Number(e.target.value) })}>
            <option value={1}>Play once</option><option value={2}>Play twice</option><option value={4}>Play four times</option></select></label>
          <label>Respond at<select value={settings.exitBars} onChange={e => setMusicSettings({ exitBars: Number(e.target.value) })}>
            <option value={1}>Next bar</option><option value={2}>Next 2-bar boundary</option><option value={4}>Next 4-bar boundary</option><option value={0}>Section end</option></select></label>
          <label>Blend jumps over<select value={settings.fadeBeats} onChange={e => setMusicSettings({ fadeBeats: Number(e.target.value) })}>
            {[0, 0.25, 1, 2, 4, 8].map(n => <option key={n} value={n}>{n === 0 ? '5ms click repair' : `${n} beats`}</option>)}</select></label>
          <label>Wait before lowering intensity<select value={settings.releaseSec} onChange={e => setMusicSettings({ releaseSec: Number(e.target.value) })}>
            {[0, 3, 6].map(n => <option key={n} value={n}>{n} seconds</option>)}</select></label>
          <p className="adaptive__hint">New requests replace queued game changes. Exact source continuations are always allowed. With reviewed jumps on, other connections need a Good rating. A loop with no allowed exit keeps repeating.</p>
        </fieldset></details>
        <section className="adaptive__review"><h3>How did that transition sound?</h3>
          {transition ? <><p>{FEEL_LABELS[transition.from]} {musicTime(transition.fromLoop.candidate.startSec)} → {FEEL_LABELS[transition.to]} {musicTime(transition.toLoop.candidate.startSec)}<br />
            {transition.natural ? 'Original song continued' : `${Math.round(transition.fadeSec * 1000)}ms blend`}</p>
            <div className="adaptive__buttons"><button className="btn" aria-pressed={review?.rating === 'good'} onClick={() => reviewTransition('good')}>Good</button>
              <button className="btn" aria-pressed={review?.rating === 'bad'} onClick={() => reviewTransition('bad')}>Bad</button>
              <button className="btn btn--small" onClick={() => editConnection(transition.fromLoop, transition.toLoop)}>Tune this connection</button></div>
            <label>Note<textarea value={review?.note ?? ''} placeholder="Abrupt, chord clash, works well…" onChange={e => reviewTransition(undefined, e.target.value)} /></label>
          </> : <p>Use “Hear this join” above, then rate the result Good or Bad here. A Good rating approves that exact exit bar for normal playback.</p>}
          <small>{setup.reviews.length} reviewed · {setup.ratingSync === 'saved' ? 'Saved to project' : setup.ratingSync === 'saving' ? 'Saving…' : 'Kept in browser'}</small>
          {setup.ratingSync === 'error' && <button className="btn btn--small" onClick={() => void syncTransitionFeedback()}>Retry saving feedback</button>}
        </section>
      </aside>
    </div></details>
  </section>
}
