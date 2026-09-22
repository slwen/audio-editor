import { useEffect, useState } from 'react'
import { assignMusic, closeAdaptive, exportAdaptive, requestMusic, reviewTransition,
  setMusicSettings, startAdaptive, stopAdaptive, suggestedSlots, syncTransitionFeedback } from '@/adaptive/actions'
import { MUSIC_STATES } from '@/adaptive/model'
import { saveAdaptive, useAdaptiveStore } from '@/adaptive/store'
import { loadLoopRatings, loopRatingKey } from '@/loop/loopRatings'
import { useLoopStore } from '@/store/useLoopStore'

const LABELS = { exploration: 'Exploration', tension: 'Tension', combat: 'Combat', intensity: 'High intensity' }

export function AdaptiveMusicPreview() {
  const setup = useAdaptiveStore()
  const loop = useLoopStore()
  const [includeUnrated, setIncludeUnrated] = useState(false)
  const [exporting, setExporting] = useState(false)
  const { playback, slots, settings } = setup
  const playing = !!playback.current
  const locked = playing || setup.starting
  const transition = playback.transition
  const review = setup.reviews.find(r => r.id === transition?.id)
  const options = [...new Map(loop.candidates.filter(c => {
    const rating = loop.ratings[loopRatingKey({ sourceName: loop.sourceName, ...c })]
    return c.bars >= 4 && (rating === 'good' || (includeUnrated && rating !== 'bad'))
  }).map(c => [loopRatingKey({ sourceName: loop.sourceName, ...c }), c])).entries()]
    .sort((a, b) => a[1].startSec - b[1].startSec || b[1].bars - a[1].bars)

  useEffect(() => {
    let cancelled = false
    void loadLoopRatings().then(records => {
      if (!cancelled) useLoopStore.getState().replaceRatings(records)
    }).catch(() => { if (!cancelled) useAdaptiveStore.setState({ error: 'Could not load loop ratings.' }) })
    return () => { cancelled = true; stopAdaptive() }
  }, [])

  return <section className="adaptive" aria-label="Adaptive music preview">
    <div className="adaptive__heading">
      <div><h1>Adaptive music preview</h1><p>{loop.sourceName} · React to the dungeon as it changes.</p></div>
      <button className="btn" onClick={closeAdaptive}>Back to loops</button>
    </div>
    <div className="adaptive__layout">
      <div className="adaptive__game">
        <h2>Game moment</h2>
        <p>Request any state, in any order. A newer request replaces a queued change. Request the playing state to cancel it.</p>
        <div className="adaptive__states">
          {MUSIC_STATES.map(state => <button key={state}
            className={`btn adaptive__state${playback.current === state ? ' adaptive__state--active' : ''}`}
            disabled={!slots[state] || setup.starting} aria-pressed={playback.current === state}
            onClick={() => requestMusic(state)}>
            <strong>{LABELS[state]}</strong>
            <span>{!slots[state] ? 'Assign a loop below' : playback.requested === state ? 'Queued' : playback.current === state ? 'Playing' : 'Request state'}</span>
          </button>)}
        </div>
        <div className="adaptive__now" aria-live="polite">
          {playing ? <><strong>{LABELS[playback.current!]} is looping</strong>
            <span>{playback.requested ? `${LABELS[playback.requested]} queued for a musical boundary` : 'Holding until the next game event'}</span></>
            : <><strong>{setup.starting ? 'Preparing audio…' : 'Ready when you are'}</strong><span>Choose a game moment to start, or use Play.</span></>}
        </div>
        {playing && <div className="adaptive__position">
          <span>Bar {playback.bar} of {slots[playback.current!]?.candidate.bars}</span>
          <span>{playback.requested ? `Switch in ${playback.remaining.toFixed(1)}s` : 'Repeating'}</span>
          <progress value={playback.progress} max={1} aria-label="Position in current loop" />
        </div>}
        <div className="adaptive__buttons">
          <button className="btn btn--primary" disabled={setup.starting || (!playing && !slots[setup.initialState])}
            onClick={() => playing ? stopAdaptive() : void startAdaptive()}>{playing ? 'Stop preview' : 'Play preview'}</button>
          <button className="btn" disabled={locked || exporting || !Object.keys(slots).length || !slots[setup.initialState]}
            onClick={async () => {
              setExporting(true)
              try { await exportAdaptive() } catch (error) {
                useAdaptiveStore.setState({ error: error instanceof Error ? error.message : 'Export failed.' })
              } finally { setExporting(false) }
            }}>{exporting ? 'Exporting…' : 'Export adaptive pack'}</button>
        </div>
        {setup.error && <p role="alert" className="adaptive__error">{setup.error}</p>}
        <div className="adaptive__review">
          <h2>Last transition</h2>
          {transition ? <>
            <p><strong>{LABELS[transition.from]} → {LABELS[transition.to]}</strong><br />
              Exit at {(transition.exitOffsetSec).toFixed(2)}s into the outgoing loop · {Math.round(transition.fadeSec * 1000)}ms blend</p>
            <div className="adaptive__buttons">
              <button className="btn" aria-pressed={review?.rating === 'good'} onClick={() => reviewTransition('good')}>Good transition</button>
              <button className="btn" aria-pressed={review?.rating === 'bad'} onClick={() => reviewTransition('bad')}>Bad transition</button>
            </div>
            <label>Transition note<textarea value={review?.note ?? ''} placeholder="Chord clash, abrupt change, drums overlap…"
              onChange={event => reviewTransition(undefined, event.target.value)} /></label>
          </> : <p>Switch between two states to review their join. These marks are separate from loop ratings.</p>}
          <small>{setup.reviews.length} reviewed transitions · {setup.ratingSync === 'saved' ? 'Saved to project log' : setup.ratingSync === 'saving' ? 'Saving to project…' : 'Kept in this browser'}</small>
          {setup.ratingSync === 'error' && <p role="alert">Project log unavailable. Feedback is kept in this browser.
            <button className="btn btn--small" onClick={() => void syncTransitionFeedback()}>Retry save</button></p>}
        </div>
      </div>
      <div className="adaptive__setup">
        <h2>Loops for this dungeon</h2>
        <p>Choose a bed for each mood you need. Unassigned states stay disabled. Stop playback to change the setup.</p>
        <fieldset disabled={locked}>
          <div className="adaptive__buttons">
            <button className="btn btn--small" onClick={() => {
              const next = { ...slots, ...suggestedSlots() }
              useAdaptiveStore.setState({ slots: next, initialState: next[setup.initialState]
                ? setup.initialState : MUSIC_STATES.find(s => next[s]) ?? 'exploration' }); saveAdaptive()
            }}>Fill from Good feel tags</button>
            <label className="adaptive__check"><input type="checkbox" checked={includeUnrated}
              onChange={e => setIncludeUnrated(e.target.checked)} />Include unrated beds</label>
          </div>
          {options.length === 0 && <p>No Good beds yet. Mark a 4–16 bar loop Good, or include unrated beds to experiment.</p>}
          {MUSIC_STATES.map(state => {
            const assigned = slots[state]
            const missing = assigned && !options.some(([key]) => key === assigned.key)
            return <label key={state}>{LABELS[state]}
              <select value={assigned?.key ?? ''} onChange={event => assignMusic(state, event.target.value)}>
                <option value="">No loop assigned</option>
                {missing && <option value={assigned.key}>Saved assignment · {assigned.candidate.startSec.toFixed(2)}s · {assigned.candidate.bars} bars</option>}
                {options.map(([key, c]) => <option key={key} value={key}>
                  {c.startSec.toFixed(2)}s · {c.bars} bars · {c.bpm.toFixed(1)} BPM{loop.tags[key]?.length ? ` · ${loop.tags[key].join(', ')}` : ''}
                </option>)}
              </select>
              {assigned && <small>{assigned.candidate.startSec.toFixed(2)}–{assigned.candidate.endSec.toFixed(2)}s · saved loop sound settings
                {loop.ratings[assigned.key] === 'bad' ? ' · Currently rated Bad—consider replacing' : ''}</small>}
              {assigned && MUSIC_STATES.some(s => s !== state && slots[s]?.key === assigned.key)
                && <small>This loop is also assigned to another state; it will restart when switching between them.</small>}
            </label>
          })}
          <label>Starting state<select value={setup.initialState} onChange={e => {
            useAdaptiveStore.setState({ initialState: e.target.value as typeof setup.initialState }); saveAdaptive()
          }}>{MUSIC_STATES.map(state => <option key={state} value={state} disabled={!slots[state]}>{LABELS[state]}</option>)}</select></label>
          <h2>How changes happen</h2>
          <label>Switch at<select value={settings.exitBars} onChange={e => setMusicSettings({ exitBars: Number(e.target.value) })}>
            <option value={1}>Next bar · responsive</option><option value={2}>Next 2-bar boundary</option>
            <option value={4}>Next 4-bar boundary</option><option value={0}>End of loop · full phrase</option>
          </select></label>
          <label>Transition blend<select value={settings.fadeBeats} onChange={e => setMusicSettings({ fadeBeats: Number(e.target.value) })}>
            <option value={0}>Direct · 5ms click repair</option><option value={0.25}>¼ beat · short blend</option><option value={1}>1 beat · longer blend</option>
          </select></label>
          <label>Wait before lowering intensity<select value={settings.releaseSec} onChange={e => setMusicSettings({ releaseSec: Number(e.target.value) })}>
            <option value={0}>No extra delay</option><option value={3}>3 seconds of calm</option><option value={6}>6 seconds of calm</option>
          </select></label>
        </fieldset>
        <p className="adaptive__hint">Rising intensity queues immediately. Falling intensity waits for calm, then a boundary. Each arrival starts at the beginning of its loop.</p>
        <p className="adaptive__hint">A bar boundary is a timing option, not a verified musical join. Audition both directions; different chords or tempos may need a different loop pair.</p>
      </div>
    </div>
  </section>
}
