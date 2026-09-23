import { useRef } from 'react'
import { Pause, Play, SkipBack } from 'lucide-react'
import { closeAdaptive, openAdaptive } from '@/adaptive/actions'
import { useAdaptiveStore } from '@/adaptive/store'
import { getProjectEndTime } from '@/lib/clipMath'
import { ingestAudioFiles } from '@/lib/ingestFiles'
import { enterLoopModeFromSelection, exitLoopMode } from '@/loop/loopModeActions'
import { skipToStart, togglePlayback } from '@/playback/playbackActions'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'

export function TransportBar() {
  const fileInput = useRef<HTMLInputElement>(null)
  const adaptiveOpen = useAdaptiveStore(s => s.open)
  const adaptiveCurrent = useAdaptiveStore(s => s.playback.current)
  const audition = useAdaptiveStore(s => s.audition)
  const playhead = useProjectStore((s) => s.playhead)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const clips = useProjectStore((s) => s.clips)
  const selection = useProjectStore((s) => s.selection)
  const editorMode = useProjectStore((s) => s.editorMode)
  const bpm = useLoopStore((s) => s.bpm)
  const previewId = useLoopStore((s) => s.previewId)
  const candidates = useLoopStore((s) => s.candidates)
  const trimEnd = useLoopStore((s) => s.trimEnd)

  const fmt = (t: number) => {
    const m = Math.floor(t / 60)
    const s = (t % 60).toFixed(2).padStart(5, '0')
    return `${m}:${s}`
  }

  const looping = editorMode === 'loop'
  const cand = candidates.find((c) => c.id === previewId)
  const end = looping ? (cand?.endSec ?? trimEnd) : getProjectEndTime(clips)
  const canFindLoops = !looping && selection.length === 1

  return (
    <header className="transport">
      <div className="transport__brand">Audio edit</div>
      <span className={`loop-mode-badge${looping ? ' loop-mode-badge--on' : ''}`}>
        {adaptiveOpen && looping ? 'Adaptive' : looping ? 'Loop' : 'Edit'}
      </span>
      <div className="transport__controls">
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => skipToStart()}
          aria-label="Skip to start"
        >
          <SkipBack size={20} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="btn btn--icon btn--primary"
          onClick={() => void togglePlayback()}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={22} fill="currentColor" strokeWidth={2} /> : <Play size={22} fill="currentColor" strokeWidth={2} />}
        </button>
      </div>
      {looping ? (
        <button type="button" className="btn btn--small" onClick={() => { closeAdaptive(); exitLoopMode() }}>
          Exit loop
        </button>
      ) : (<>
        <input ref={fileInput} type="file" accept="audio/*,.mp3,.wav" hidden onChange={e => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          void ingestAudioFiles(files, clips.length > 0)
        }} />
        <button type="button" className="btn btn--small" onClick={() => fileInput.current?.click()}>Open audio</button>
        <button
          type="button"
          className="btn btn--small"
          disabled={!canFindLoops}
          onClick={() => enterLoopModeFromSelection()}
        >
          Find loops
        </button>
      </>)}
      {looping && <button className="btn btn--small" disabled={!candidates.length}
        onClick={() => adaptiveOpen ? closeAdaptive() : openAdaptive()}>{adaptiveOpen ? 'Loop editor' : 'Adaptive preview'}</button>}
      {adaptiveOpen && looping ? <div className="transport__time">{audition ? `Listening · ${fmt(audition.sourceTime)}` : adaptiveCurrent ?? 'Adaptive preview stopped'}</div> : <div className="transport__time" aria-live="polite">
        <span>{fmt(playhead)}</span>
        <span className="transport__muted"> / {fmt(end)}</span>
        {looping && bpm != null && (
          <span className="transport__muted"> · ~{Math.round(cand?.bpm ?? bpm)} BPM{isPlaying ? ' · looping' : ''}</span>
        )}
      </div>}
    </header>
  )
}
