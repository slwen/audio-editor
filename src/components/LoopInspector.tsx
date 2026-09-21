import { useEffect, useMemo } from 'react'
import { filterLoopCandidates } from '@/loop/filters'
import {
  addSelectedLoopsToTimeline,
  exportSelectedLoops,
  nudgeSelectedByBeats,
  selectLoopCandidate,
  setVibeWindowAndRerun,
  startLoopPreview,
} from '@/loop/loopModeActions'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'
import { VIBE_WINDOW_MAX_SEC, VIBE_WINDOW_MIN_SEC, type LoopBarFilter, type LoopLengthFilter } from '@/loop/types'

function fmtDur(sec: number): string {
  return `${sec.toFixed(2)}s`
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

export function LoopInspector() {
  const status = useLoopStore((s) => s.status)
  const errorMessage = useLoopStore((s) => s.errorMessage)
  const bpm = useLoopStore((s) => s.bpm)
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
  const setWrap = useLoopStore((s) => s.setWrapCrossfadeSec)
  const setNormalize = useLoopStore((s) => s.setNormalizeExport)
  const setMinQuality = useLoopStore((s) => s.setMinQuality)
  const setMinVibe = useLoopStore((s) => s.setMinVibe)
  const setBarFilter = useLoopStore((s) => s.setBarFilter)
  const setLengthFilter = useLoopStore((s) => s.setLengthFilter)
  const isPlaying = useProjectStore((s) => s.isPlaying)

  const visible = useMemo(
    () => filterLoopCandidates(candidates, { minQuality, minVibe, barFilter, lengthFilter }),
    [candidates, minQuality, minVibe, barFilter, lengthFilter]
  )

  useEffect(() => {
    if (visible.length === 0) return
    if (previewId && visible.some((c) => c.id === previewId)) return
    selectLoopCandidate(visible[0]!.id)
  }, [visible, previewId])

  const selected = useMemo(
    () => visible.filter((c) => selectedIds.includes(c.id)),
    [visible, selectedIds]
  )
  const preview = visible.find((c) => c.id === previewId) ?? selected[0]

  return (
    <aside className="inspector">
      <h2 className="inspector__title">Loops</h2>
      {status === 'analyzing' && <p className="inspector__muted">Finding bar-aligned loops…</p>}
      {status === 'error' && <p className="inspector__muted">{errorMessage ?? 'Analysis failed'}</p>}
      {status === 'ready' && (
        <p className="inspector__meta">
          {visible.length} shown / {candidates.length} found
          {bpm != null ? ` · ~${Math.round(bpm)} BPM` : ''}
        </p>
      )}

      <h2 className="inspector__title">Filters</h2>
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
          {vibeWindowSec.toFixed(2)}s — jump must be as smooth as the rest of the song
          {status === 'analyzing' ? ' · updating…' : ''}
        </span>
      </label>
      <div className="field">
        <span>Bars</span>
        <div className="segmented">
          {(['all', 4, 8, 16] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              className={`btn btn--small btn--segment${barFilter === v ? ' btn--segment-active' : ''}`}
              onClick={() => setBarFilter(v as LoopBarFilter)}
            >
              {v === 'all' ? 'All' : v}
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

      <div className="loop-candidate-list">
        {visible.map((c, i) => {
          const on = selectedIds.includes(c.id)
          const prev = c.id === previewId
          return (
            <button
              key={c.id}
              type="button"
              className={`loop-candidate${on ? ' loop-candidate--selected' : ''}${
                prev ? ' loop-candidate--preview' : ''
              }`}
              onClick={(e) => selectLoopCandidate(c.id, { toggle: e.shiftKey })}
            >
              <span className="loop-candidate__title">
                {i + 1}. {c.bars} bar · {pct(c.qualityScore)}
              </span>
              <span className="loop-candidate__meta">
                {fmtDur(c.endSec - c.startSec)} · vibe {pct(c.contextScore)} · even {pct(c.homogeneityScore)} ·
                seam {pct(c.seamScore)}
              </span>
              <span className="loop-candidate__bar" aria-hidden>
                <span style={{ width: `${Math.round(c.qualityScore * 100)}%` }} />
              </span>
            </button>
          )
        })}
      </div>

      {candidates.length === 0 && status === 'ready' && (
        <p className="inspector__muted">No loop windows found. Try a longer clip with a steady beat.</p>
      )}
      {candidates.length > 0 && visible.length === 0 && (
        <p className="inspector__muted">No loops match these filters. Lower min quality or reset bars/length.</p>
      )}

      {preview && (
        <>
          <h2 className="inspector__title">Selected region</h2>
          <p className="inspector__muted">
            {fmtDur(preview.startSec)} – {fmtDur(preview.endSec)} · nudge by one beat
          </p>
          <div className="inspector__row">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => nudgeSelectedByBeats('start', -1)}
            >
              Start −
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => nudgeSelectedByBeats('start', 1)}
            >
              Start +
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => nudgeSelectedByBeats('end', -1)}
            >
              End −
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => nudgeSelectedByBeats('end', 1)}
            >
              End +
            </button>
          </div>
        </>
      )}

      <label className="field">
        <span>Wrap crossfade (export)</span>
        <input
          type="range"
          min={0}
          max={0.12}
          step={0.005}
          value={wrapCrossfadeSec}
          onChange={(e) => setWrap(Number(e.target.value))}
        />
        <span className="field__hint">{wrapCrossfadeSec.toFixed(3)}s</span>
      </label>
      <label className="field field--check">
        <input
          type="checkbox"
          checked={normalizeExport}
          onChange={(e) => setNormalize(e.target.checked)}
        />
        <span>Peak-normalize exported loops</span>
      </label>

      <div className="inspector__row inspector__row--col">
        <button
          type="button"
          className="btn btn--small btn--primary"
          disabled={!preview}
          onClick={() => void startLoopPreview(preview?.id)}
        >
          {isPlaying ? 'Restart join preview' : 'Preview join'}
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={selected.length === 0}
          onClick={() => void exportSelectedLoops()}
        >
          Export {selected.length || ''} selected
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={selected.length === 0}
          onClick={() => addSelectedLoopsToTimeline()}
        >
          Add to timeline
        </button>
      </div>
      <p className="inspector__muted">
        Preview starts one bar before the wrap so you hear the join first. Space loops. Shift-click
        selects several.
      </p>
    </aside>
  )
}
