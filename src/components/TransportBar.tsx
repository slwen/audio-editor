import { useRef } from 'react'
import { Pause, Play, SkipBack } from 'lucide-react'
import { enterGameSongMode, exitGameSongMode } from '@/gameSong/actions'
import { useGameSongStore } from '@/gameSong/store'
import { getProjectEndTime } from '@/lib/clipMath'
import { ingestAudioFiles } from '@/lib/ingestFiles'
import { enterLoopModeFromSelection, exitLoopMode } from '@/loop/loopModeActions'
import { skipToStart, togglePlayback } from '@/playback/playbackActions'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'

export function TransportBar() {
  const fileInput = useRef<HTMLInputElement>(null)
  const gameSongPlaying = useGameSongStore(s => s.playing)
  const gameSongPlayhead = useGameSongStore(s => s.playhead)
  const gameSongDuration = useGameSongStore(s => s.analysis?.durationSec ?? 0)
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
  const gameSong = editorMode === 'game-song'
  const playing = gameSong ? gameSongPlaying : isPlaying
  const cand = candidates.find((c) => c.id === previewId)
  const end = looping ? (cand?.endSec ?? trimEnd) : getProjectEndTime(clips)
  const canFindLoops = !looping && selection.length === 1

  return (
    <header className="transport">
      <div className="transport__brand">Audio edit</div>
      <span className={`loop-mode-badge${looping ? ' loop-mode-badge--on' : ''}`}>
        {gameSong ? 'Game song' : looping ? 'Loop' : 'Edit'}
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
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={22} fill="currentColor" strokeWidth={2} /> : <Play size={22} fill="currentColor" strokeWidth={2} />}
        </button>
      </div>
      {gameSong ? (
        <button type="button" className="btn btn--small" onClick={() => exitGameSongMode()}>
          Back to editor
        </button>
      ) : looping ? (
        <button type="button" className="btn btn--small" onClick={() => exitLoopMode()}>
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
        <button type="button" className="btn btn--small btn--primary" onClick={() => enterGameSongMode()}>
          Game song
        </button>
      </>)}
      {gameSong ? <div className="transport__time">
        <span>{fmt(gameSongPlayhead)}</span>
        <span className="transport__muted"> / {fmt(gameSongDuration)}</span>
      </div> : <div className="transport__time" aria-live="polite">
        <span>{fmt(playhead)}</span>
        <span className="transport__muted"> / {fmt(end)}</span>
        {looping && bpm != null && (
          <span className="transport__muted"> · ~{Math.round(cand?.bpm ?? bpm)} BPM{isPlaying ? ' · looping' : ''}</span>
        )}
      </div>}
    </header>
  )
}
