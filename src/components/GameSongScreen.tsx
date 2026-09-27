import { useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Download, Play, Scissors, SkipForward, Square, ThumbsDown, ThumbsUp, Upload } from 'lucide-react'
import {
  chooseSuggestion,
  currentFadeSec,
  currentRating,
  downloadZip,
  editorSong,
  exportToGame,
  hearFightToCalm,
  hearFromStart,
  hearWrap,
  importFromEditor,
  importSongFile,
  nextSuggestion,
  nudgeMarker,
  rateWrap,
  selectSong,
  setBlend,
  setCalmLevel,
  setExportField,
  setQuietTop,
  setSnap,
  startSplit,
  stopGameSong,
} from '@/gameSong/actions'
import { loopWarnings } from '@/gameSong/analyze'
import { isSongId } from '@/gameSong/songJson'
import { useGameSongStore } from '@/gameSong/store'
import { BLEND_CHOICES } from '@/gameSong/wrap'
import { formatTime } from '@/lib/formatTime'
import { GameSongWaveform } from './GameSongWaveform'

type StepState = 'done' | 'current' | 'locked'

function smoothness(p: number | null): string {
  if (p === null) return '…'
  if (p >= 0.65) return 'Likely smooth'
  if (p >= 0.45) return 'Worth a listen'
  return 'Likely noticeable'
}

const kb = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`

function StepHeading({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  return (
    <div className="gs-step__heading">
      <span className={`gs-step__number gs-step__number--${state}`}>{state === 'done' ? <Check size={15} strokeWidth={3} /> : n}</span>
      <h2>{title}</h2>
      {children}
    </div>
  )
}

function ImportStep({ state }: { state: StepState }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const songs = useGameSongStore(s => s.songs)
  const sourceName = useGameSongStore(s => s.sourceName)
  const importing = useGameSongStore(s => s.importing)
  const importError = useGameSongStore(s => s.importError)
  const fromEditor = editorSong()
  return (
    <section className="gs-step">
      <StepHeading n={1} title="Import a song" state={state} />
      <div className="gs-step__body">
        <p>Drop an audio file anywhere on this page, or choose one.</p>
        <div className="gs-row">
          <input ref={fileInput} type="file" accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a" hidden onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importSongFile(file)
          }} />
          <button type="button" className="btn" disabled={importing} onClick={() => fileInput.current?.click()}>
            <Upload size={16} /> Choose file…
          </button>
          {fromEditor && (
            <button type="button" className="btn" disabled={importing} onClick={() => void importFromEditor()}>
              Use “{fromEditor.name}” from the editor
            </button>
          )}
          {songs.length > 0 && (
            <label className="gs-inline">
              or a song you used before
              <select value={sourceName ?? ''} onChange={e => { if (e.target.value) void selectSong(e.target.value) }}>
                <option value="">Choose…</option>
                {songs.map(s => <option key={s.name} value={s.name}>{s.name}{s.stems ? ' (stems ready)' : ''}</option>)}
              </select>
            </label>
          )}
        </div>
        {importing && <p className="gs-muted">Importing…</p>}
        {importError && <p className="gs-error">{importError}</p>}
        {sourceName && <p className="gs-current">Song: <strong>{sourceName}</strong></p>}
      </div>
    </section>
  )
}

function SplitStep({ state }: { state: StepState }) {
  const stems = useGameSongStore(s => s.stems)
  const [copied, setCopied] = useState(false)
  return (
    <section className={`gs-step${state === 'locked' ? ' gs-step--locked' : ''}`}>
      <StepHeading n={2} title="Split into two layers" state={state} />
      <div className="gs-step__body">
        <p>The game needs the song as two layers: <strong>drums &amp; bass</strong>, which always play, and
          {' '}<strong>everything else</strong>, which gets louder in fights.</p>
        {state === 'locked' && <p className="gs-muted">Import a song first.</p>}
        {stems?.state === 'ready' && <p className="gs-ok"><Check size={16} /> Layers are ready.</p>}
        {stems?.state === 'missing' && stems.demucsInstalled && (
          <button type="button" className="btn btn--primary" onClick={() => void startSplit()}><Scissors size={16} /> Split stems</button>
        )}
        {stems?.state === 'running' && (
          <div className="gs-progress">
            <progress value={stems.progress} max={1} />
            <span>{stems.message}… {Math.round(stems.progress * 100)}% (this takes a few minutes)</span>
          </div>
        )}
        {stems?.state === 'error' && (
          <>
            <p className="gs-error">{stems.message}</p>
            <button type="button" className="btn" onClick={() => void startSplit()}>Try again</button>
          </>
        )}
        {stems && !stems.demucsInstalled && stems.state !== 'ready' && (
          <div className="gs-install">
            <p>The stem splitter (Demucs) is not installed yet. Run this once in a terminal, then press Split stems:</p>
            <code>{stems.installCommand}</code>
            <button type="button" className="btn btn--small" onClick={() => {
              void navigator.clipboard.writeText(stems.installCommand).then(() => setCopied(true))
            }}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="btn btn--small" onClick={() => void startSplit()}>Split stems</button>
          </div>
        )}
      </div>
    </section>
  )
}

function LoopStep({ state }: { state: StepState }) {
  const s = useGameSongStore()
  if (state === 'locked' || !s.analysis) {
    return (
      <section className="gs-step gs-step--locked">
        <StepHeading n={3} title="Pick the loop" state={state} />
        <div className="gs-step__body">
          {s.loading === 'loading' && <p className="gs-muted">Loading the layers…</p>}
          {s.loading === 'analyzing' && <p className="gs-muted">Finding beats and good places to loop…</p>}
          {s.loading === 'error' && <p className="gs-error">{s.loadError}</p>}
          {s.loading === 'idle' && <p className="gs-muted">Split the layers first.</p>}
        </div>
      </section>
    )
  }
  const { analysis, loop } = s
  const rating = currentRating('mine')
  const olderRating = rating ? null : currentRating('all')
  const warnings = loopWarnings(analysis, loop)
  const fade = currentFadeSec()
  return (
    <section className="gs-step">
      <StepHeading n={3} title="Pick the loop" state={state}>
        <span className="gs-muted">{Math.round(analysis.bpm)} BPM</span>
      </StepHeading>
      <div className="gs-step__body">
        <p>The game plays the song from the start. When it reaches <strong className="gs-end">Wrap at</strong>, it
          blends back to <strong className="gs-start">Loop back to</strong> and keeps going until the level ends.
          Drag the markers, or try a suggestion. Shaded parts have few drums.</p>
        <GameSongWaveform />
        <div className="gs-row gs-markers">
          <div className="gs-marker-field">
            <span className="gs-start">Loop back to</span>
            <button type="button" className="btn btn--small" onClick={() => nudgeMarker('start', -1)} aria-label="Loop back to: earlier">‹</button>
            <strong>{formatTime(loop.startSec)}</strong>
            <button type="button" className="btn btn--small" onClick={() => nudgeMarker('start', 1)} aria-label="Loop back to: later">›</button>
          </div>
          <div className="gs-marker-field">
            <span className="gs-end">Wrap at</span>
            <button type="button" className="btn btn--small" onClick={() => nudgeMarker('end', -1)} aria-label="Wrap at: earlier">‹</button>
            <strong>{formatTime(loop.endSec)}</strong>
            <button type="button" className="btn btn--small" onClick={() => nudgeMarker('end', 1)} aria-label="Wrap at: later">›</button>
          </div>
          <span className="gs-muted">Loop length {formatTime(loop.endSec - loop.startSec)}</span>
          <div className="segmented segmented--compact" role="group" aria-label="Snap markers to">
            <span className="gs-muted">Snap to</span>
            {(['bar', 'beat'] as const).map(mode => (
              <button key={mode} type="button" className={`btn btn--small btn--segment${s.snap === mode ? ' btn--segment-active' : ''}`}
                aria-pressed={s.snap === mode} onClick={() => setSnap(mode)}>{mode === 'bar' ? 'Bars' : 'Beats'}</button>
            ))}
          </div>
        </div>
        <div className="gs-row">
          <span className="gs-muted">Blend</span>
          <div className="segmented" role="group" aria-label="Blend length">
            {BLEND_CHOICES.map(b => (
              <button key={b.id} type="button" className={`btn btn--small btn--segment${s.blend === b.id ? ' btn--segment-active' : ''}`}
                aria-pressed={s.blend === b.id} onClick={() => setBlend(b.id)}>{b.label}</button>
            ))}
          </div>
          <span className="gs-muted">{fade < 0.1 ? `${Math.round(fade * 1000)} ms` : `${fade.toFixed(2)} s`}</span>
        </div>
        <div className="gs-row">
          <button type="button" className="btn btn--primary" onClick={() => void hearWrap()}><Play size={16} /> Hear wrap</button>
          <button type="button" className="btn" onClick={() => void hearFromStart()}><Play size={16} /> Hear from start</button>
          <button type="button" className="btn" disabled={!s.playing} onClick={() => stopGameSong()}><Square size={14} /> Stop</button>
          <span className="gs-muted">Playing {formatTime(s.playhead)}</span>
        </div>
        <div className="gs-row">
          <label className="gs-check">
            <input type="checkbox" checked={s.quietTop} onChange={e => setQuietTop(e.target.checked)} />
            Calm mode (guitars quiet, as outside fights)
          </label>
          <label className="gs-check">
            Calm level
            <input type="range" min={0} max={0.5} step={0.05} value={s.calmLevel}
              onChange={e => setCalmLevel(Number(e.target.value))} />
            <span className="gs-muted">{s.calmLevel === 0 ? 'off' : `${Math.round(s.calmLevel * 100)}%`}</span>
          </label>
          <button type="button" className="btn" onClick={() => void hearFightToCalm()}>
            <Play size={16} /> Hear fight → calm
          </button>
          <span className="gs-muted">Full guitars, then the game's 8 s fade down to the calm level</span>
        </div>
        <div className="gs-row gs-verdict">
          <span>Seam: <strong>{smoothness(s.pGood)}</strong>{s.pGood !== null && <span className="gs-muted"> ({Math.round(s.pGood * 100)}% chance it sounds good)</span>}</span>
          <span className="gs-muted">How did it sound?</span>
          <button type="button" className="btn btn--small loop-rate loop-rate--good" aria-pressed={rating === 'good'} onClick={() => void rateWrap('good')}>
            <ThumbsUp size={14} /> Good
          </button>
          <button type="button" className="btn btn--small loop-rate loop-rate--bad" aria-pressed={rating === 'bad'} onClick={() => void rateWrap('bad')}>
            <ThumbsDown size={14} /> Bad
          </button>
          {olderRating && <span className="gs-muted">Rated {olderRating} in the old tools</span>}
          {s.ratingError && <span className="gs-error">{s.ratingError}</span>}
        </div>
        {warnings.length > 0 && (
          <ul className="gs-warnings">
            {warnings.map(w => <li key={w.id}><AlertTriangle size={14} /> {w.text}</li>)}
          </ul>
        )}
        <div className="gs-suggestions">
          <div className="gs-row">
            <h3>Suggestions</h3>
            <button type="button" className="btn btn--small" disabled={s.suggestions.length === 0} onClick={() => nextSuggestion()}>
              <SkipForward size={14} /> Try next suggestion
            </button>
          </div>
          {s.suggestions.length === 0 && <p className="gs-muted">No good loop of a minute or more was found. Place the markers by hand.</p>}
          <ol>
            {s.suggestions.map((sug, i) => (
              <li key={`${sug.startSec}-${sug.endSec}`}>
                <button type="button" className={`gs-suggestion${s.suggestionIndex === i ? ' gs-suggestion--active' : ''}`}
                  onClick={() => { chooseSuggestion(i); void hearWrap() }}>
                  <span className="gs-suggestion__rank">{i + 1}</span>
                  <span>Wrap at <strong>{formatTime(sug.endSec)}</strong> back to <strong>{formatTime(sug.startSec)}</strong></span>
                  <span className="gs-muted">loop {formatTime(sug.endSec - sug.startSec)} · {smoothness(sug.pGood).toLowerCase()}</span>
                  {sug.prior === 'good' && <span className="gs-tag">rated Good before</span>}
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function ExportStep({ state }: { state: StepState }) {
  const s = useGameSongStore()
  const [copied, setCopied] = useState(false)
  const idOk = isSongId(s.id.trim())
  const nextStep = `add adaptive song ${s.exported?.song.id ?? s.id}`
  return (
    <section className={`gs-step${state === 'locked' ? ' gs-step--locked' : ''}`}>
      <StepHeading n={4} title="Export to the game" state={state} />
      <div className="gs-step__body">
        {state === 'locked' ? <p className="gs-muted">Pick the loop first.</p> : (
          <>
            <div className="gs-form">
              <label>Song id
                <input value={s.id} onChange={e => setExportField({ id: e.target.value })} spellCheck={false} />
                {!idOk && <small className="gs-error">Lowercase letters, numbers and dashes only, like cathedral-of-iron.</small>}
              </label>
              <label>Title
                <input value={s.title} onChange={e => setExportField({ title: e.target.value })} />
              </label>
              <label className="gs-form__wide">Game music folder
                <input value={s.destDir} onChange={e => setExportField({ destDir: e.target.value })} spellCheck={false} />
              </label>
            </div>
            <div className="gs-row">
              <label className="gs-check">
                <input type="checkbox" checked={s.trimEnd} onChange={e => setExportField({ trimEnd: e.target.checked })} />
                Cut the silence after the song ends
              </label>
              <label className="gs-check">
                <input type="checkbox" checked={s.monoBase} onChange={e => setExportField({ monoBase: e.target.checked })} />
                Mono drums &amp; bass (smaller file)
              </label>
              <label className="gs-check">
                <input type="checkbox" checked={s.highQuality} onChange={e => setExportField({ highQuality: e.target.checked })} />
                Higher quality: 128 kbps (bigger files; the game plays music at 32 kHz, so it rarely helps)
              </label>
            </div>
            <div className="gs-row">
              <button type="button" className="btn btn--primary" disabled={!idOk || s.exporting} onClick={() => void exportToGame()}>
                <Upload size={16} /> Export to game
              </button>
              <button type="button" className="btn" disabled={!idOk || s.exporting} onClick={() => void downloadZip()}>
                <Download size={16} /> Download ZIP
              </button>
              {s.exporting && <span className="gs-muted">Exporting… (matching loudness and encoding, about 10 s)</span>}
            </div>
            {s.exportError && <p className="gs-error">{s.exportError}</p>}
            {s.exported && (
              <div className="gs-done">
                <h3><Check size={18} /> Exported “{s.exported.song.title}” as <code>{s.exported.song.id}</code></h3>
                <p>{s.exported.copiedTo ? <>Written to <code>{s.exported.copiedTo}</code>:</> : 'Ready to download:'}</p>
                <ul>
                  {s.exported.files.map(f => <li key={f.name}><code>{f.name}</code> <span className="gs-muted">{kb(f.bytes)}</span></li>)}
                </ul>
                <p className="gs-muted">
                  Loop {formatTime(s.exported.song.loop.startSec)} to {formatTime(s.exported.song.loop.endSec)},
                  blend {s.exported.song.loop.fadeSec} s · length {formatTime(s.exported.song.durationSec)} ·
                  loudness {s.exported.song.loudness.integratedLufs} LUFS ({s.exported.song.loudness.gainDb > 0 ? '+' : ''}{s.exported.song.loudness.gainDb} dB)
                </p>
                {s.exported.notes.map(n => <p key={n} className="gs-muted">{n}</p>)}
                <p><strong>Next step:</strong> in the crypt-raiders project, ask an agent:</p>
                <div className="gs-next">
                  <code>{nextStep}</code>
                  <button type="button" className="btn btn--small" onClick={() => {
                    void navigator.clipboard.writeText(nextStep).then(() => setCopied(true))
                  }}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export function GameSongScreen() {
  const sourceName = useGameSongStore(s => s.sourceName)
  const stems = useGameSongStore(s => s.stems)
  const loading = useGameSongStore(s => s.loading)
  const exported = useGameSongStore(s => s.exported)
  const imported = !!sourceName
  const split = stems?.state === 'ready'
  const picked = split && loading === 'ready'
  const states: StepState[] = [
    imported ? 'done' : 'current',
    split ? 'done' : imported ? 'current' : 'locked',
    picked ? (exported ? 'done' : 'current') : 'locked',
    picked ? (exported ? 'done' : 'current') : 'locked',
  ]
  const labels = ['Import', 'Split stems', 'Pick the loop', 'Export']
  return (
    <div className="gs">
      <div className="gs__inner">
        <h1>Game song</h1>
        <p className="gs-muted">Turn a song into a looping two-layer track for your game.</p>
        <ol className="gs-stepper">
          {labels.map((label, i) => (
            <li key={label} className={`gs-stepper__item gs-stepper__item--${states[i]}`}>
              <span className={`gs-step__number gs-step__number--small gs-step__number--${states[i]}`}>{states[i] === 'done' ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <ImportStep state={states[0]!} />
        <SplitStep state={states[1]!} />
        <LoopStep state={states[2]!} />
        <ExportStep state={states[3]!} />
      </div>
    </div>
  )
}
