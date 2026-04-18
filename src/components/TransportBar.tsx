import { Pause, Play, SkipBack } from 'lucide-react'
import { getProjectEndTime } from '@/lib/clipMath'
import { skipToStart, togglePlayback } from '@/playback/playbackActions'
import { useProjectStore } from '@/store/useProjectStore'

export function TransportBar() {
  const playhead = useProjectStore((s) => s.playhead)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const clips = useProjectStore((s) => s.clips)

  const fmt = (t: number) => {
    const m = Math.floor(t / 60)
    const s = (t % 60).toFixed(2).padStart(5, '0')
    return `${m}:${s}`
  }

  const end = getProjectEndTime(clips)

  return (
    <header className="transport">
      <div className="transport__brand">Audio edit</div>
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
      <div className="transport__time" aria-live="polite">
        <span>{fmt(playhead)}</span>
        <span className="transport__muted"> / {fmt(end)}</span>
      </div>
    </header>
  )
}
