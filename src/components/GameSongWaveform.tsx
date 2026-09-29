import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { moveMarkerToBoundary, nudgeMarker, seekGameSong, setMarker } from '@/gameSong/actions'
import { useGameSongStore } from '@/gameSong/store'
import { formatTime } from '@/lib/formatTime'
import { readCssColor } from '@/lib/themeCanvas'

const LANE_HEIGHT = 64
const RULER_HEIGHT = 18
const HEIGHT = LANE_HEIGHT * 2 + RULER_HEIGHT

function drawLane(g: CanvasRenderingContext2D, peaks: Float32Array, top: number, width: number, color: string) {
  const buckets = peaks.length / 2
  const mid = top + LANE_HEIGHT / 2
  const scale = LANE_HEIGHT / 2 - 3
  g.fillStyle = color
  for (let x = 0; x < width; x++) {
    const a = Math.floor((x / width) * buckets)
    const b = Math.max(a + 1, Math.floor(((x + 1) / width) * buckets))
    let min = 0
    let max = 0
    for (let i = a; i < b && i < buckets; i++) {
      min = Math.min(min, peaks[i * 2]!)
      max = Math.max(max, peaks[i * 2 + 1]!)
    }
    g.fillRect(x, mid - max * scale, 1, Math.max(1, (max - min) * scale))
  }
}

export function GameSongWaveform() {
  const peaks = useGameSongStore(s => s.peaks)
  const analysis = useGameSongStore(s => s.analysis)
  const loop = useGameSongStore(s => s.loop)
  const playhead = useGameSongStore(s => s.playhead)
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)
  const duration = analysis?.durationSec ?? 1

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const c = canvas.current
    if (!c || !peaks || !analysis) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = HEIGHT * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, HEIGHT)
    const x = (sec: number) => (sec / analysis.durationSec) * width
    g.fillStyle = readCssColor('--wave-quiet', 'rgba(0,0,0,0.35)')
    for (const bar of analysis.bars) if (bar.quiet) g.fillRect(x(bar.startSec), 0, Math.max(1, x(bar.endSec) - x(bar.startSec)), LANE_HEIGHT * 2)
    drawLane(g, peaks.base, 0, width, readCssColor('--wave-lane-base', '#5fc9e7'))
    drawLane(g, peaks.top, LANE_HEIGHT, width, readCssColor('--wave-lane-top', '#f3a787'))
    g.strokeStyle = readCssColor('--timeline-grid-strong', 'rgba(255,255,255,0.18)')
    g.beginPath()
    g.moveTo(0, LANE_HEIGHT + 0.5)
    g.lineTo(width, LANE_HEIGHT + 0.5)
    g.stroke()
    g.fillStyle = readCssColor('--timeline-ruler-text', '#a0a0a8')
    g.font = '11px system-ui, sans-serif'
    const step = analysis.durationSec > 240 ? 30 : 15
    for (let t = 0; t < analysis.durationSec; t += step) {
      g.fillRect(x(t), LANE_HEIGHT * 2, 1, 4)
      g.fillText(formatTime(t).replace(/\.0$/, ''), x(t) + 3, HEIGHT - 3)
    }
  }, [peaks, analysis, width])

  const secAt = (e: ReactPointerEvent) => {
    const rect = (e.currentTarget.closest('.gs-wave') ?? e.currentTarget).getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration
  }
  const onMarkerDown = (e: ReactPointerEvent, which: 'start' | 'end') => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(which)
  }

  const pct = (sec: number) => `${(sec / duration) * 100}%`
  const onMarkerKey = (event: ReactKeyboardEvent, which: 'start' | 'end') => {
    if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Home' || event.key === 'End') moveMarkerToBoundary(which, event.key === 'End')
    else nudgeMarker(which, (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1) * (event.shiftKey ? 10 : 1))
  }

  return (
    <div className="gs-wave" ref={wrap} style={{ height: HEIGHT }}
      onPointerDown={e => { if (e.button === 0) seekGameSong(secAt(e)) }}>
      <canvas ref={canvas} style={{ width: '100%', height: HEIGHT }} />
      <span className="gs-wave__lane-label" style={{ top: 2 }}>Drums &amp; bass</span>
      <span className="gs-wave__lane-label" style={{ top: LANE_HEIGHT + 2 }}>Everything else</span>
      {analysis && analysis.introEndSec > 0 && (
        <span className="gs-wave__intro" style={{ width: pct(analysis.introEndSec) }}>intro</span>
      )}
      <div className="gs-wave__loop" style={{ left: pct(loop.startSec), width: pct(loop.endSec - loop.startSec) }} />
      <div className="gs-wave__marker gs-wave__marker--start" style={{ left: pct(loop.startSec) }}
        onPointerDown={e => onMarkerDown(e, 'start')} onPointerMove={e => { if (dragging === 'start') setMarker('start', secAt(e)) }} onPointerUp={() => setDragging(null)}
        tabIndex={0} onKeyDown={event => onMarkerKey(event, 'start')}
        role="slider" aria-label="Loop back to" aria-valuemin={0} aria-valuemax={Math.max(0, loop.endSec - 1)} aria-valuenow={loop.startSec} aria-valuetext={formatTime(loop.startSec)}>
        <span>Loop back to</span>
      </div>
      <div className="gs-wave__marker gs-wave__marker--end" style={{ left: pct(loop.endSec) }}
        onPointerDown={e => onMarkerDown(e, 'end')} onPointerMove={e => { if (dragging === 'end') setMarker('end', secAt(e)) }} onPointerUp={() => setDragging(null)}
        tabIndex={0} onKeyDown={event => onMarkerKey(event, 'end')}
        role="slider" aria-label="Wrap at" aria-valuemin={Math.min(duration, loop.startSec + 1)} aria-valuemax={duration} aria-valuenow={loop.endSec} aria-valuetext={formatTime(loop.endSec)}>
        <span>Wrap at</span>
      </div>
      <div className="gs-wave__playhead" style={{ left: pct(playhead) }} />
    </div>
  )
}
