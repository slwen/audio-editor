import { useMemo } from 'react'
import { getCachedBuffer } from '@/audio/bufferCache'
import { MUSIC_STATES, type MusicSlots, type MusicState } from '@/adaptive/model'

import { FEEL_LABELS, musicTime } from '@/adaptive/labels'

export function PassageWave({ bufferId, start, end }: { bufferId: string; start: number; end: number }) {
  const path = useMemo(() => {
    const buffer = getCachedBuffer(bufferId)
    if (!buffer) return ''
    const data = buffer.getChannelData(0)
    const a = Math.round(start * buffer.sampleRate), b = Math.min(data.length, Math.round(end * buffer.sampleRate))
    return Array.from({ length: 180 }, (_, i) => {
      const left = a + Math.floor((b - a) * i / 180), right = a + Math.floor((b - a) * (i + 1) / 180)
      let peak = 0
      const step = Math.max(1, Math.floor((right - left) / 80))
      for (let j = left; j < right; j += step) peak = Math.max(peak, Math.abs(data[j] ?? 0))
      const height = Math.max(0.7, Math.min(14, peak * 20))
      return `M${i} ${16 - height}V${16 + height}`
    }).join(' ')
  }, [bufferId, start, end])
  return <svg className="music-wave" viewBox="0 0 180 32" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
}

export function AdaptiveSongMap({ bufferId, start, end, slots, position, selected, onSelect }: {
  bufferId: string; start: number; end: number; slots: MusicSlots; position?: number; selected: string
  onSelect: (state: MusicState, key: string) => void
}) {
  const duration = Math.max(0.001, end - start)
  return <div className="song-map" aria-label="Selected sections in the original song">
    <div className="song-map__wave"><PassageWave bufferId={bufferId} start={start} end={end} /></div>
    <div className="song-map__ruler"><span>{musicTime(start)}</span><span>{musicTime(start + duration / 2)}</span><span>{musicTime(end)}</span></div>
    {MUSIC_STATES.map(state => {
      const ends: number[] = []
      const segments = [...(slots[state] ?? [])].sort((a, b) => a.candidate.startSec - b.candidate.startSec).map(p => {
        let lane = ends.findIndex(t => t <= p.candidate.startSec)
        if (lane === -1) lane = ends.length
        ends[lane] = p.candidate.endSec
        return { p, lane }
      })
      return <div key={state} className={`song-map__row feel-${state}`}>
        <span>{FEEL_LABELS[state]}</span>
        <div className="song-map__track" style={{ height: Math.max(1, ends.length) * 24 }}>
          {segments.map(({ p, lane }) => <button key={p.key} type="button"
            className={`song-map__segment${p.kind === 'passage' ? ' song-map__segment--song' : ''}`}
            style={{ left: `${(p.candidate.startSec - start) / duration * 100}%`, width: `${(p.candidate.endSec - p.candidate.startSec) / duration * 100}%`, top: lane * 24 }}
            aria-pressed={selected === p.key} aria-label={`${FEEL_LABELS[state]} ${p.kind === 'passage' ? 'song passage' : 'loop'} at ${musicTime(p.candidate.startSec)}`}
            onClick={() => onSelect(state, p.key)}>{p.kind === 'passage' ? '→' : '↻'}</button>)}
          {position !== undefined && <div className="song-map__cursor" style={{ left: `${Math.max(0, Math.min(100, (position - start) / duration * 100))}%` }} />}
        </div>
      </div>
    })}
    <div className="song-map__legend"><span>↻ Loop: somewhere to hold</span><span>→ Song passage: plays through</span><span>Dark gaps: not included yet</span></div>
  </div>
}
