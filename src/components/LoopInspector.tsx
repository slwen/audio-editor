import { useEffect, useMemo, useState } from 'react'
import { filterLoopCandidates } from '@/loop/filters'
import { getCachedBuffer } from '@/audio/bufferCache'
import { effectiveLoopCrossfadeSec } from '@/loop/wrapLoop'
import {
  addSelectedLoopsToTimeline,
  exportSelectedLoops,
  fitSelectedToBars,
  resizeSelectedLoop,
  rateLoopCandidate,
  selectLoopCandidate,
  setVibeWindowAndRerun,
  shiftSelectedByBeats,
  softenSelectedSeam,
  startLoopPreview,
  stopLoopPreview,
  toggleLoopTag,
  setLoopTempo,
  updateLoopNote,
} from '@/loop/loopModeActions'
import { loadLoopRatings, loopRatingKey } from '@/loop/loopRatings'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'
import { LOOP_FEELS, VIBE_WINDOW_MAX_SEC, VIBE_WINDOW_MIN_SEC, type LoopBarFilter, type LoopLengthFilter, type LoopFeel, type LoopReviewFilter } from '@/loop/types'

function fmtDur(sec: number): string {
  return `${sec.toFixed(2)}s`
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

const REVIEW_REASONS = [
  ['Musical mismatch', 'Musical or background mismatch at the wrap'],
  ['Click at seam', 'Click or clack at the seam'],
  ['Awkward repeat', 'Awkward repeating at the wrap'],
] as const

export function LoopInspector() {
  const status = useLoopStore((s) => s.status)
  const isRescoring = useLoopStore(s => s.isRescoring)
  const errorMessage = useLoopStore((s) => s.errorMessage)
  const bpm = useLoopStore((s) => s.bpm)
  const candidateView = useLoopStore(s => s.candidateView)
  const setCandidateView = useLoopStore(s => s.setCandidateView)
  const candidates = useLoopStore((s) => s.candidates)
  const selectedIds = useLoopStore((s) => s.selectedIds)
  const previewId = useLoopStore((s) => s.previewId)
  const wrapCrossfadeSec = useLoopStore((s) => s.wrapCrossfadeSec)
  const normalizeExport = useLoopStore((s) => s.normalizeExport)
  const minQuality = useLoopStore((s) => s.minQuality)
  const minVibe = useLoopStore((s) => s.minVibe)
  const vibeWindowSec = useLoopStore((s) => s.vibeWindowSec)
  const barFilter = useLoopStore((s) => s.barFilter)
  const lengthFilter = useLoopStore((s) => s.lengthFilter)
  const sourceName = useLoopStore((s) => s.sourceName)
  const bufferId = useLoopStore(s => s.bufferId)
  const ratings = useLoopStore((s) => s.ratings)
  const ratingError = useLoopStore((s) => s.ratingError)
  const tags = useLoopStore((s) => s.tags)
  const manualBpm = useLoopStore((s) => s.manualBpm)
  const notes = useLoopStore((s) => s.notes)
  const setWrap = useLoopStore((s) => s.setWrapCrossfadeSec)
  const setNormalize = useLoopStore((s) => s.setNormalizeExport)
  const setMinQuality = useLoopStore((s) => s.setMinQuality)
  const setMinVibe = useLoopStore((s) => s.setMinVibe)
  const setBarFilter = useLoopStore((s) => s.setBarFilter)
  const setLengthFilter = useLoopStore((s) => s.setLengthFilter)
  const isPlaying = useProjectStore((s) => s.isPlaying)

  const [filtersOpen, setFiltersOpen] = useState(false)
  const feelFilter = useLoopStore(s => s.feelFilter)
  const reviewFilter = useLoopStore(s => s.reviewFilter)
  const setFeelFilter = useLoopStore(s => s.setFeelFilter)
  const setReviewFilter = useLoopStore(s => s.setReviewFilter)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [lastReviewed, setLastReviewed] = useState<{ id: string; sourceName: string } | null>(null)

  const visible = useMemo(
    () => filterLoopCandidates(candidates, { minQuality, minVibe, barFilter, lengthFilter,
      candidateView, sourceName, ratings, tags, feelFilter, reviewFilter }),
    [candidates, candidateView, minQuality, minVibe, barFilter, lengthFilter, sourceName, tags, ratings, feelFilter, reviewFilter]
  )

  useEffect(() => {
    if (visible.length === 0) return
    if (previewId && visible.some((c) => c.id === previewId)) return
    selectLoopCandidate(visible[0]!.id)
  }, [visible, previewId])

  useEffect(() => {
    let cancelled = false
    void loadLoopRatings()
      .then((records) => {
        if (!cancelled) useLoopStore.getState().replaceRatings(records)
      })
      .catch(() => {
        if (!cancelled) useLoopStore.getState().setRatingError('Could not load saved marks.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!filtersOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFiltersOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filtersOpen])

  const selected = useMemo(
    () => visible.filter((c) => selectedIds.includes(c.id)),
    [visible, selectedIds]
  )
  const preview = visible.find((c) => c.id === previewId) ?? selected[0]
  const sourceBuffer = getCachedBuffer(bufferId)
  const effectiveCrossfade = preview && sourceBuffer
    ? effectiveLoopCrossfadeSec(sourceBuffer, preview.startSec, preview.endSec, wrapCrossfadeSec)
    : wrapCrossfadeSec
  // A Bad vote can immediately remove its row from the default filter. Keep
  // that exact cut available for a note while selection advances to the next.
  const reviewed = lastReviewed?.sourceName === sourceName
    ? candidates.find(c => c.id === lastReviewed.id && !visible.some(v => v.id === c.id))
    : undefined
  const reviewedKey = reviewed ? loopRatingKey({ sourceName, ...reviewed }) : ''
  const reviewedRating = ratings[reviewedKey]

  const filterSummary = [
    candidateView === 'saved' ? 'Saved listening decisions' : `Q≥${pct(minQuality)}`,
    candidateView === 'saved' ? null : `V≥${pct(minVibe)}`,
    barFilter === 'all' ? null : barFilter === 'beds' ? '4–16 bar loops' : `${barFilter} bar`,
    lengthFilter === 'all' ? null : lengthFilter,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <aside className="inspector inspector--loop">
      <header className="inspector__header">
        <div className="inspector__header-row">
          <h2 className="inspector__title">Loops</h2>
          <button
            type="button"
            className="btn btn--small btn--flyout"
            aria-expanded={filtersOpen}
            aria-controls="loop-filters-flyout"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters
          </button>
        </div>
        {status === 'analyzing' && <p className="inspector__muted">Finding bar-aligned loops…</p>}
        {status === 'error' && <p className="inspector__muted">{errorMessage ?? 'Analysis failed'}</p>}
        {status === 'ready' && (
          <p className="inspector__meta">
            {visible.length} shown / {candidates.filter(c => (c.origin ?? 'found') === candidateView).length} {candidateView === 'saved' ? 'saved' : 'found'}
            {(candidateView === 'saved' ? preview?.bpm : bpm) != null ? ` · ${(candidateView === 'saved' ? preview!.bpm : bpm!).toFixed(2)} BPM · 4/4` : ''}
          </p>
        )}
        {!filtersOpen && status === 'ready' && (
          <p className="inspector__muted">{filterSummary}</p>
        )}
      </header>

      {filtersOpen && (
        <>
          <button
            type="button"
            className="flyout__backdrop"
            aria-label="Close filters"
            onClick={() => setFiltersOpen(false)}
          />
          <div id="loop-filters-flyout" className="flyout" role="dialog" aria-label="Loop filters">
            <label className="field">
              <span>Min quality</span>
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={minQuality}
                onChange={(e) => setMinQuality(Number(e.target.value))}
              />
              <span className="field__hint">{pct(minQuality)} combined score</span>
            </label>
            <label className="field">
              <span>Min vibe match</span>
              <input
                type="range"
                min={0}
                max={0.95}
                step={0.05}
                value={minVibe}
                onChange={(e) => setMinVibe(Number(e.target.value))}
              />
              <span className="field__hint">{pct(minVibe)} jump smoothness</span>
            </label>
            <label className="field">
              <span>Vibe window</span>
              <input
                type="range"
                min={VIBE_WINDOW_MIN_SEC}
                max={VIBE_WINDOW_MAX_SEC}
                step={0.25}
                value={vibeWindowSec}
                onChange={(e) => setVibeWindowAndRerun(Number(e.target.value))}
              />
              <span className="field__hint">
                {vibeWindowSec.toFixed(2)}s of musical context at both cuts
                {status === 'analyzing' ? ' · updating…' : ''}
              </span>
            </label>
            <div className="field">
              <span>Bars</span>
              <div className="segmented">
                {(['beds', 'all', 1, 2, 4, 8, 16] as const).map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    className={`btn btn--small btn--segment${barFilter === v ? ' btn--segment-active' : ''}`}
                    onClick={() => setBarFilter(v as LoopBarFilter)}
                  >
                    {v === 'all' ? 'All' : v === 'beds' ? 'Long loops' : v}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Length</span>
              <div className="segmented">
                {(
                  [
                    ['all', 'All'],
                    ['short', '<8s'],
                    ['medium', '8–16s'],
                    ['long', '>16s'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={`btn btn--small btn--segment${lengthFilter === v ? ' btn--segment-active' : ''}`}
                    onClick={() => setLengthFilter(v as LoopLengthFilter)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="loop-toolbar">
        <div className="segmented" aria-label="Loop library">
          {(['found', 'saved'] as const).map(view => <button type="button" key={view}
            className={`btn btn--small btn--segment${candidateView === view ? ' btn--segment-active' : ''}`}
            aria-pressed={candidateView === view} onClick={() => { stopLoopPreview(); setCandidateView(view); setReviewFilter(view === 'saved' && candidates.some(c => c.origin === 'saved' && ratings[loopRatingKey({ sourceName, ...c })] === 'good') ? 'good' : view === 'found' ? 'not-bad' : 'all') }}>
            {view === 'found' ? 'New candidates' : `Saved loops (${candidates.filter(c => c.origin === 'saved').length})`}
          </button>)}
        </div>
        <div className="inspector__row">
          <button type="button" className="btn btn--small btn--primary" disabled={!preview || status !== 'ready'} onClick={() => void startLoopPreview(preview?.id)}>Hear seam</button>
          <button type="button" className="btn btn--small" disabled={!preview || status !== 'ready'} onClick={() => void startLoopPreview(preview?.id, 'full')}>Hear full loop</button>
          <button type="button" className="btn btn--small" disabled={!isPlaying} onClick={stopLoopPreview}>Stop</button>
        </div>
        <div className="inspector__row">
          <button type="button" className="btn btn--small" disabled={!selected.length || exporting || status !== 'ready'} onClick={async () => {
            setExporting(true)
            setExportError('')
            try { await exportSelectedLoops(selected.map(c => c.id)) }
            catch { setExportError('Export failed. Please try again.') }
            finally { setExporting(false) }
          }}>{exporting ? 'Exporting…' : `Export loop pack (${selected.length})`}</button>
          <button type="button" className="btn btn--small" disabled={!selected.length || status !== 'ready'} onClick={() => addSelectedLoopsToTimeline(selected.map(c => c.id))}>Copy to timeline</button>
        </div>
        {exportError && <p role="alert">{exportError}</p>}
        <div className="inspector__row">
          <label className="field">Feel
            <select value={feelFilter} onChange={e => setFeelFilter(e.target.value as LoopFeel | 'all')}>
              <option value="all">All feels</option>
              {LOOP_FEELS.map(tag => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
          <label className="field">Review
            <select value={reviewFilter} onChange={e => setReviewFilter(e.target.value as LoopReviewFilter)}>
              {['not-bad', 'all', 'good', 'bad', 'unrated'].map(value => <option key={value} value={value}>{value === 'not-bad' ? 'Not marked Bad' : value}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="inspector__scroll">
        <details className="loop-adjustments">
          <summary>Adjust seam, length & tempo</summary>
        {preview && (
          <fieldset disabled={preview.origin === 'saved' || isRescoring} className="loop-region-tools">
            <h2 className="inspector__title">Selected region</h2>
            <p className="inspector__muted">
              {fmtDur(preview.startSec)} – {fmtDur(preview.endSec)} · {preview.bars} bar
            </p>
            {isRescoring && <p className="inspector__muted" role="status">Scoring the edited region…</p>}
            <div className="inspector__row">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => resizeSelectedLoop('start', -1)}
              >
                Start earlier
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => resizeSelectedLoop('start', 1)}
              >
                Start later
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => resizeSelectedLoop('end', -1)}
              >
                End earlier
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => resizeSelectedLoop('end', 1)}
              >
                End later
              </button>
            </div>
            <div className="inspector__row">
              <button type="button" className="btn btn--small" onClick={() => shiftSelectedByBeats(-1)}>
                Earlier
              </button>
              <button type="button" className="btn btn--small" onClick={() => shiftSelectedByBeats(1)}>
                Later
              </button>
              <button type="button" className="btn btn--small" onClick={() => softenSelectedSeam()}>
                Soften seam
              </button>
              <button type="button" className="btn btn--small" onClick={() => fitSelectedToBars()}>
                Fit to bars
              </button>
            </div>
            <p className="inspector__muted">
              Edges step between whole-bar lengths. Earlier and Later move the whole loop by one beat without changing its length. Soften
              seam slides both edges a few milliseconds to shrink a click. Fit to bars lands the
              length on a whole number of bars.
            </p>
          </fieldset>
        )}
        {preview?.origin === 'saved' && <p className="inspector__muted">Saved cuts keep their original boundaries and tempo. Copy to timeline to edit the audio. Crossfade settings below can be auditioned without changing the saved cut.</p>}

        <label className="field">
          <span>Selected loop blend · preview & export</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.005}
            disabled={!preview}
            value={wrapCrossfadeSec}
            onChange={(e) => { setWrap(Number(e.target.value)); if (isPlaying) void startLoopPreview() }}
          />
          <span className="field__hint">{effectiveCrossfade.toFixed(3)}s{effectiveCrossfade + 0.0001 < wrapCrossfadeSec ? ' · limited by available continuation or loop length' : ''}</span>
        </label>
        <div className="loop-feels" aria-label="Loop blend presets">
          {[
            { label: 'Raw', seconds: 0 }, { label: 'Click repair', seconds: 0.035 },
            { label: '½ beat', seconds: 30 / (preview?.bpm ?? bpm ?? 120) },
            { label: '1 beat', seconds: 60 / (preview?.bpm ?? bpm ?? 120) },
          ].map(({ label, seconds }) => <button key={label} type="button" className="btn btn--small"
            disabled={!preview} aria-pressed={Math.abs(wrapCrossfadeSec - seconds) < 0.001}
            onClick={() => { setWrap(seconds); if (isPlaying) void startLoopPreview() }}>{label}</button>)}
        </div>
        <p className="inspector__muted">Each cut keeps its own settings. Check both the join and rhythm after changing the blend. Loop duration stays unchanged.</p>
        <label className="field field--check">
          <input
            type="checkbox"
            checked={normalizeExport}
            disabled={!preview}
            onChange={(e) => { setNormalize(e.target.checked); if (isPlaying) void startLoopPreview() }}
          />
          <span>Normalize this loop (changes relative intensity)</span>
        </label>

        <details>
          <summary>Tempo correction</summary>
          <p className="inspector__muted">Analysis assumes steady 4/4. If the beat drifts, enter a known tempo and re-detect.</p>
          <form onSubmit={e => {
            e.preventDefault()
            const value = new FormData(e.currentTarget).get('bpm')
            if (value) setLoopTempo(Number(value))
          }}>
            <label className="field">BPM
              <input key={bpm} name="bpm" type="number" min="40" max="240" step="0.01" defaultValue={manualBpm ?? (bpm == null ? '' : bpm.toFixed(2))} required />
            </label>
            <button className="btn btn--small" type="submit">Apply tempo</button>
            <button className="btn btn--small" type="button" onClick={() => setLoopTempo(null)}>Auto tempo</button>
          </form>
        </details>
        </details>
        {reviewed && reviewedRating && (
          <section className="loop-review-feedback" aria-label="Last loop review">
            <div className="inspector__row">
              <strong>Marked {reviewedRating === 'bad' ? 'Bad' : 'Good'}</strong>
              <button type="button" className="btn btn--small" onClick={() => setLastReviewed(null)}>Done</button>
            </div>
            <p className="inspector__muted">{reviewed.bars} bar · {fmtDur(reviewed.startSec)} → {fmtDur(reviewed.endSec)}</p>
            <div className="loop-feels" aria-label="Optional review reasons">
              {REVIEW_REASONS.map(([label, reason]) => (
                <button key={label} type="button" className="btn btn--small"
                  onClick={() => {
                    const note = notes[reviewedKey] ?? ''
                    if (!note.includes(reason)) updateLoopNote(reviewed.id, note ? `${note}; ${reason}` : reason)
                  }}>{label}</button>
              ))}
            </div>
            <input className="loop-candidate__note" type="text" aria-label="Note for last reviewed loop"
              placeholder="Optional note for this cut" value={notes[reviewedKey] ?? ''}
              onKeyDown={e => e.stopPropagation()}
              onChange={e => updateLoopNote(reviewed.id, e.target.value)} />
          </section>
        )}
        <div className="loop-candidate-list">
          {visible.map((c, i) => {
            const on = selectedIds.includes(c.id)
            const prev = c.id === previewId
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className={`loop-candidate${on ? ' loop-candidate--selected' : ''}${
                  prev ? ' loop-candidate--preview' : ''
                }`}
                onClick={(e) => selectLoopCandidate(c.id, { toggle: e.shiftKey })}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                  e.preventDefault()
                  selectLoopCandidate(c.id, { toggle: e.shiftKey })
                }}
              >
                <span className="loop-candidate__title">
                  {i + 1}. {c.bars} bar · {c.origin === 'saved' ? 'saved score' : 'score'} {pct(c.qualityScore)}
                </span>
                <span className="loop-candidate__meta">
                  {fmtDur(c.startSec)} → {fmtDur(c.endSec)} · {fmtDur(c.endSec - c.startSec)} · vibe {pct(c.contextScore)} · even{' '}
                  {pct(c.homogeneityScore)} · seam {pct(c.seamScore)}
                </span>
                {c.origin === 'saved' && <span className="loop-candidate__meta">{c.bpm.toFixed(2)} BPM · {c.savedRender?.wrapCrossfadeSec === 0 ? 'raw seam when saved' : 'crossfade when saved'}</span>}
                <span className="loop-candidate__bar" aria-hidden>
                  <span style={{ width: `${Math.round(c.qualityScore * 100)}%` }} />
                </span>
                <span className="loop-candidate__rate">
                  {(['good', 'bad'] as const).map((mark) => {
                    const pressed = ratings[loopRatingKey({ sourceName, ...c })] === mark
                    return (
                      <button
                        key={mark}
                        type="button"
                        className={`btn btn--small loop-rate loop-rate--${mark}`}
                        aria-pressed={pressed}
                        onClick={(e) => {
                          e.stopPropagation()
                          setLastReviewed({ id: c.id, sourceName })
                          void rateLoopCandidate(c.id, mark)
                        }}
                      >
                        {mark === 'good' ? 'Good' : 'Bad'}
                      </button>
                    )
                  })}
                </span>
                <span className="loop-feels" aria-label={`Feel tags for loop ${i + 1}`}>
                  {LOOP_FEELS.map(tag => <button key={tag} type="button" className="btn btn--small"
                    aria-pressed={(tags[loopRatingKey({ sourceName, ...c })] ?? []).includes(tag)}
                    onClick={e => { e.stopPropagation(); void toggleLoopTag(c.id, tag) }}>{tag}</button>)}
                </span>
                <input
                  type="text"
                  className="loop-candidate__note"
                  value={notes[loopRatingKey({ sourceName, ...c })] ?? ''}
                  placeholder="Note for this loop"
                  aria-label={`Note for loop ${i + 1}`}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => updateLoopNote(c.id, e.target.value)}
                />
              </div>
            )
          })}
        </div>
        {ratingError && <p className="inspector__muted">{ratingError}</p>}
        <p className="inspector__muted">New scores rank candidates; saved scores are historical and do not hide your listening decisions. Audition before marking Good.</p>

        {candidates.length === 0 && status === 'ready' && (
          <p className="inspector__muted">No loop windows found. Try a longer clip with a steady beat.</p>
        )}
        {candidates.length > 0 && visible.length === 0 && (
          <p className="inspector__muted">
            No loops match these filters. Open Filters and lower min quality, or choose All bars, or reset feel/review.
          </p>
        )}

        <p className="inspector__muted">
          Preview starts one bar before the wrap so you hear the join first. Space loops. Shift-click
          selects several.
        </p>
      </div>
    </aside>
  )
}
