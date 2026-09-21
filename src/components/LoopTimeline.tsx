import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getCachedBuffer } from '@/audio/bufferCache'
import { getPeaks } from '@/lib/peaksCache'
import { parseHexRgb, readCssColor } from '@/lib/themeCanvas'
import { TIMELINE_PAD_L, TIMELINE_PAD_R } from '@/lib/timelineScroll'
import { filterLoopCandidates } from '@/loop/filters'
import { exitLoopMode, rerunLoopAnalysis, selectLoopCandidate } from '@/loop/loopModeActions'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'

const RULER_H = 28
const WAVE_H = 160

function zoomFactorFromWheel(e: WheelEvent): number {
  let dy = e.deltaY
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 32
  else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= 800
  if (dy === 0) return 1
  const raw = Math.exp(-dy * 0.012)
  const clamped = Math.max(0.6, Math.min(1.8, raw))
  if (dy > 0) return Math.min(0.99, clamped)
  return Math.max(1.04, clamped)
}

function maxScroll(width: number, duration: number, pps: number): number {
  const contentW = duration * pps + TIMELINE_PAD_L + TIMELINE_PAD_R
  return Math.max(0, contentW - width)
}

export function LoopTimeline() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawImplRef = useRef<() => void>(() => {})
  const rafDrawRef = useRef(0)

  const bufferId = useLoopStore((s) => s.bufferId)
  const trimStart = useLoopStore((s) => s.trimStart)
  const trimEnd = useLoopStore((s) => s.trimEnd)
  const bpm = useLoopStore((s) => s.bpm)
  const beatOffsetSec = useLoopStore((s) => s.beatOffsetSec)
  const candidates = useLoopStore((s) => s.candidates)
  const minQuality = useLoopStore((s) => s.minQuality)
  const minVibe = useLoopStore((s) => s.minVibe)
  const barFilter = useLoopStore((s) => s.barFilter)
  const lengthFilter = useLoopStore((s) => s.lengthFilter)
  const selectedIds = useLoopStore((s) => s.selectedIds)
  const previewId = useLoopStore((s) => s.previewId)
  const status = useLoopStore((s) => s.status)
  const sourceName = useLoopStore((s) => s.sourceName)
  const playhead = useProjectStore((s) => s.playhead)
  const pps = useProjectStore((s) => s.pixelsPerSecond)
  const scrollX = useProjectStore((s) => s.scrollX)
  const isPlaying = useProjectStore((s) => s.isPlaying)

  const duration = Math.max(0.01, trimEnd - trimStart)
  const visible = useMemo(
    () => filterLoopCandidates(candidates, { minQuality, minVibe, barFilter, lengthFilter }),
    [candidates, minQuality, minVibe, barFilter, lengthFilter]
  )

  const tx = useCallback(
    (bufT: number) => (bufT - trimStart) * pps - scrollX + TIMELINE_PAD_L,
    [pps, scrollX, trimStart]
  )
  const xt = useCallback(
    (x: number) => (x - TIMELINE_PAD_L + scrollX) / pps + trimStart,
    [pps, scrollX, trimStart]
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const area = canvasAreaRef.current
    if (!canvas || !area) return
    const dpr = window.devicePixelRatio || 1
    const w = area.clientWidth
    const h = area.clientHeight
    if (w <= 0 || h <= 0) return
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const css = (name: string, fb: string) => readCssColor(name, fb)
    ctx.fillStyle = css('--timeline-canvas-bg', '#1a1c2c')
    ctx.fillRect(0, 0, w, h)

    ctx.fillStyle = css('--ui-elevated', '#2a3148')
    ctx.fillRect(0, 0, w, RULER_H)
    ctx.strokeStyle = css('--timeline-grid', 'rgba(86,108,134,0.35)')
    ctx.beginPath()
    ctx.moveTo(0, RULER_H)
    ctx.lineTo(w, RULER_H)
    ctx.stroke()

    ctx.fillStyle = css('--timeline-ruler-text', '#94b0c2')
    ctx.font = '11px system-ui, sans-serif'
    const t0 = xt(0)
    const t1 = xt(w)
    if (bpm && beatOffsetSec != null) {
      const beat = 60 / bpm
      const bar = beat * 4
      let t = beatOffsetSec
      if (t < t0) t += Math.floor((t0 - t) / beat) * beat
      for (; t <= t1 + 1e-6; t += beat) {
        const x = tx(t)
        const barI = Math.round((t - beatOffsetSec) / bar)
        const isBar = Math.abs((t - beatOffsetSec) / bar - barI) < 1e-3
        ctx.strokeStyle = isBar ? css('--ui-border', '#566c86') : css('--timeline-grid', 'rgba(86,108,134,0.35)')
        ctx.beginPath()
        ctx.moveTo(x, isBar ? 4 : 14)
        ctx.lineTo(x, RULER_H)
        ctx.stroke()
        if (isBar && barI >= 0) ctx.fillText(String(barI + 1), x + 3, 12)
      }
    } else {
      const step = pps > 60 ? 1 : 2
      const start = Math.floor(t0 / step) * step
      for (let t = start; t <= t1; t += step) {
        const x = tx(t)
        ctx.fillText(`${(t - trimStart).toFixed(0)}s`, x + 2, 16)
      }
    }

    const y0 = RULER_H + 16
    const ch = Math.min(WAVE_H, h - RULER_H - 32)
    const x0 = tx(trimStart)
    const x1 = tx(trimEnd)
    ctx.fillStyle = 'rgba(65,166,246,0.06)'
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), ch)

    const buf = getCachedBuffer(bufferId)
    const peaks = getPeaks(bufferId)
    if (buf && peaks && peaks.length >= 2) {
      const buckets = peaks.length / 2
      const { r, g, b } = parseHexRgb('#41a6f6')
      ctx.strokeStyle = `rgba(${r},${g},${b},0.88)`
      ctx.lineWidth = 1
      ctx.beginPath()
      const mid = y0 + ch / 2
      const cw = Math.max(1, Math.floor(x1 - x0))
      for (let ix = 0; ix < cw; ix++) {
        const frac = cw <= 1 ? 0 : ix / (cw - 1)
        const srcT = trimStart + frac * duration
        const u = srcT / buf.duration
        const bi = Math.max(0, Math.min(buckets - 1, Math.floor(u * buckets)))
        const mn = peaks[bi * 2] ?? 0
        const mx = peaks[bi * 2 + 1] ?? 0
        const amp = Math.max(Math.abs(mn), Math.abs(mx)) * (ch / 2) * 0.9
        ctx.moveTo(x0 + ix, mid - amp)
        ctx.lineTo(x0 + ix, mid + amp)
      }
      ctx.stroke()
    }

    const selected = new Set(selectedIds)
    const ranked = [...visible].sort((a, b) => a.startSec - b.startSec)
    ranked.forEach((c, i) => {
      const cx0 = tx(c.startSec)
      const cx1 = tx(c.endSec)
      const isSel = selected.has(c.id)
      const isPrev = c.id === previewId
      const hue = 200 - i * 8
      ctx.fillStyle = isSel ? `hsla(${hue},70%,55%,0.22)` : `hsla(${hue},50%,50%,0.1)`
      ctx.strokeStyle = isPrev ? 'rgba(115,239,247,0.95)' : isSel ? 'rgba(65,166,246,0.85)' : 'rgba(148,176,194,0.35)'
      ctx.lineWidth = isPrev ? 2 : 1
      ctx.beginPath()
      ctx.roundRect(cx0, y0, Math.max(2, cx1 - cx0), ch, 4)
      ctx.fill()
      ctx.stroke()
    })

    const phx = tx(playhead)
    ctx.strokeStyle = css('--timeline-playhead', '#ef7d57')
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(phx, 0)
    ctx.lineTo(phx, h)
    ctx.stroke()

    ctx.fillStyle = css('--ui-muted', '#94b0c2')
    ctx.font = '12px system-ui, sans-serif'
    const label =
      status === 'analyzing'
        ? `Analyzing ${sourceName}…`
        : status === 'error'
          ? 'Analysis failed'
          : sourceName
    ctx.fillText(label, 10, h - 10)
  }, [
    beatOffsetSec,
    bpm,
    bufferId,
    visible,
    duration,
    playhead,
    previewId,
    selectedIds,
    sourceName,
    status,
    trimEnd,
    trimStart,
    pps,
    tx,
    xt,
  ])

  const requestDraw = useCallback(() => {
    if (rafDrawRef.current) return
    rafDrawRef.current = requestAnimationFrame(() => {
      rafDrawRef.current = 0
      drawImplRef.current()
    })
  }, [])

  useEffect(() => {
    drawImplRef.current = draw
  }, [draw])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const area = canvasAreaRef.current
    if (!area) return
    const ro = new ResizeObserver(() => requestDraw())
    ro.observe(area)
    return () => ro.disconnect()
  }, [requestDraw])

  useEffect(() => {
    if (!isPlaying) return
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth
    const st = useProjectStore.getState()
    const maxS = maxScroll(w, duration, st.pixelsPerSecond)
    const ideal = (playhead - trimStart) * st.pixelsPerSecond + TIMELINE_PAD_L - w / 2
    st.setScrollX(Math.max(0, Math.min(maxS, ideal)))
  }, [playhead, isPlaying, duration, trimStart])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheelNative = (e: WheelEvent) => {
      const st = useProjectStore.getState()
      const canvas = canvasRef.current
      const cw = canvas?.clientWidth ?? wrap.clientWidth
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = canvas?.getBoundingClientRect()
        const localX = rect ? e.clientX - rect.left : cw / 2
        const factor = zoomFactorFromWheel(e)
        const pps0 = st.pixelsPerSecond
        const pps1 = Math.max(10, Math.min(500, pps0 * factor))
        if (pps1 === pps0) return
        const anchor = localX - TIMELINE_PAD_L
        const t = (anchor + st.scrollX) / pps0
        const maxS = maxScroll(cw, duration, pps1)
        const scrollX1 = Math.max(0, Math.min(maxS, t * pps1 - anchor))
        useProjectStore.setState({ pixelsPerSecond: pps1, scrollX: scrollX1 })
        return
      }
      e.preventDefault()
      const maxS = maxScroll(cw, duration, st.pixelsPerSecond)
      const delta = e.shiftKey ? e.deltaY : e.deltaX + e.deltaY
      st.setScrollX(Math.max(0, Math.min(maxS, st.scrollX + delta)))
    }
    wrap.addEventListener('wheel', onWheelNative, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheelNative)
  }, [duration])

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const t = xt(x)
    const hit = [...visible]
      .sort((a, b) => a.endSec - a.startSec - (b.endSec - b.startSec))
      .find((c) => t >= c.startSec && t <= c.endSec)
    if (hit) selectLoopCandidate(hit.id, { toggle: e.shiftKey })
    else useLoopStore.getState().setSelectedIds([])
  }

  return (
    <div ref={wrapRef} className="timeline-wrap">
      <div className="timeline-toolbar">
        <span className="loop-mode-badge">Loop mode</span>
        <button type="button" className="btn btn--small" onClick={() => rerunLoopAnalysis()}>
          Analyze again
        </button>
        <button type="button" className="btn btn--small" onClick={() => exitLoopMode()}>
          Exit
        </button>
      </div>
      <div ref={canvasAreaRef} className="timeline-canvas-area">
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          onPointerDown={onPointerDown}
        />
      </div>
    </div>
  )
}
