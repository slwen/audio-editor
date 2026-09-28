import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { getCachedBuffer } from '@/audio/bufferCache'
import { ingestAudioFiles } from '@/lib/ingestFiles'
import {
  clipTimelineDuration,
  clipTimelineEnd,
  clipsSortedForDraw,
  clipsSortedForHitTest,
  fadeMultiplier,
  sourceTimeAtTimelineTime,
} from '@/lib/clipMath'
import { getPeaks } from '@/lib/peaksCache'
import { rulerStepSeconds } from '@/lib/rulerTicks'
import { edgeSnapStart } from '@/lib/snap'
import { readCssColor, withAlpha } from '@/lib/themeCanvas'
import { maxTimelineScrollPx, scrollForPlayheadCentered, TIMELINE_PAD_L } from '@/lib/timelineScroll'
import { clipAccentHex } from '@/lib/trackAccent'
import { seekToTimelineTime } from '@/playback/playbackActions'
import { useProjectStore } from '@/store/useProjectStore'
import type { Clip, ClipId } from '@/types'

const ROW_H = 72
const RULER_H = 28
const DRAG_START_PX = 3
const DRAG_STEP_SEC = 0.1

/** Map wheel delta to a zoom multiplier (⌃/⌘+wheel / pinch). */
function zoomFactorFromWheel(e: WheelEvent): number {
  let dy = e.deltaY
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 32
  else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= 800
  if (dy === 0) return 1
  const sensitivity = 0.012
  const raw = Math.exp(-dy * sensitivity)
  const clamped = Math.max(0.6, Math.min(1.8, raw))
  // Ensure tiny pinch deltas still produce visible zoom movement.
  if (dy > 0) return Math.min(0.99, clamped)
  return Math.max(0.04, clamped)
}

type DragClip = {
  id: ClipId
  dragIds: ClipId[]
  origById: Record<ClipId, { startTime: number; row: number }>
  pointerId: number
  startClientX: number
  startClientY: number
  origStart: number
  origRow: number
  hasMoved: boolean
  /** Alt+drag on clip: source id until duplicate is created, then `id` is the copy. */
  altDupSourceId?: ClipId
  altDupCreated?: boolean
}

type Marquee = {
  pointerId: number
  x0: number
  y0: number
  x1: number
  y1: number
}

function resolveDraggedClipStart(
  clips: Clip[],
  baseClip: Clip,
  start: number,
  row: number,
  snapOn: boolean,
  pps: number
): number {
  const s = Math.max(0, start)
  if (!snapOn) return s
  return edgeSnapStart(clips, { ...baseClip, startTime: s, row }, s, pps)
}

function quantizeTimelineStep(t: number): number {
  return Math.round(t / DRAG_STEP_SEC) * DRAG_STEP_SEC
}

export function Timeline() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hoverLineRef = useRef<HTMLDivElement>(null)
  const hoverTimeRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragClip | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const previewByIdRef = useRef<Record<ClipId, { startTime: number; row: number }> | null>(null)
  const anchorRef = useRef<ClipId | null>(null)
  /** Canvas-local X of last hover position, or null if hidden */
  const hoverLocalXRef = useRef<number | null>(null)
  const canvasCssRef = useRef({ w: 0, h: 0, dpr: 0 })
  const drawImplRef = useRef<() => void>(() => {})
  const rafDrawRef = useRef(0)

  const clips = useProjectStore((s) => s.clips)
  const bufferMeta = useProjectStore((s) => s.bufferMeta)
  const selection = useProjectStore((s) => s.selection)
  const scrollX = useProjectStore((s) => s.scrollX)
  const pps = useProjectStore((s) => s.pixelsPerSecond)
  const playhead = useProjectStore((s) => s.playhead)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const selectOnly = useProjectStore((s) => s.selectOnly)
  const toggleSelect = useProjectStore((s) => s.toggleSelect)
  const selectRangeFromAnchor = useProjectStore((s) => s.selectRangeFromAnchor)
  const setSelection = useProjectStore((s) => s.setSelection)
  const updateClip = useProjectStore((s) => s.updateClip)
  const pushUndo = useProjectStore((s) => s.pushUndo)
  const splitAt = useProjectStore((s) => s.splitAt)
  const duplicateClipForDrag = useProjectStore((s) => s.duplicateClipForDrag)

  const clipsDrawOrder = useMemo(() => clipsSortedForDraw(clips), [clips])
  const clipsHitOrder = useMemo(() => clipsSortedForHitTest(clips), [clips])

  const tx = useCallback(
    (t: number) => t * pps - scrollX + TIMELINE_PAD_L,
    [pps, scrollX]
  )
  const xt = useCallback((x: number) => (x - TIMELINE_PAD_L + scrollX) / pps, [pps, scrollX])

  const syncHoverDom = useCallback(() => {
    const x = hoverLocalXRef.current
    const area = canvasAreaRef.current
    const line = hoverLineRef.current
    const label = hoverTimeRef.current
    if (!area || !line || !label) return
    if (x == null) {
      line.style.display = 'none'
      label.style.display = 'none'
      return
    }
    const aw = area.clientWidth
    if (x < 0 || x > aw) {
      line.style.display = 'none'
      label.style.display = 'none'
      return
    }
    const t = Math.max(0, (x - TIMELINE_PAD_L + scrollX) / pps)
    line.style.display = 'block'
    label.style.display = 'block'
    line.style.left = `${x}px`
    label.style.left = `${Math.min(x + 4, Math.max(0, aw - 52))}px`
    label.textContent = `${t.toFixed(2)}s`
  }, [pps, scrollX])

  const hitTest = useCallback(
    (clientX: number, clientY: number, canvasRect: DOMRect): Clip | null => {
      const x = clientX - canvasRect.left
      const y = clientY - canvasRect.top
      if (y < RULER_H) return null
      const row = Math.floor((y - RULER_H) / ROW_H)
      for (const c of clipsHitOrder) {
        if (c.row !== row) continue
        const x0 = tx(c.startTime)
        const w = clipTimelineDuration(c) * pps
        if (x >= x0 && x <= x0 + w) return c
      }
      return null
    },
    [clipsHitOrder, pps, tx]
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const prevLayout = canvasCssRef.current
    if (prevLayout.w !== w || prevLayout.h !== h || prevLayout.dpr !== dpr) {
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvasCssRef.current = { w, h, dpr }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const css = (name: string, fb: string) => readCssColor(name, fb)

    ctx.fillStyle = css('--timeline-canvas-bg', '#141416')
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = css('--timeline-grid', 'rgba(255,255,255,0.07)')
    ctx.lineWidth = 1
    const t0 = xt(0)
    const t1 = xt(w)
    const sec0 = Math.floor(Math.min(t0, t1))
    const sec1 = Math.ceil(Math.max(t0, t1))
    ctx.fillStyle = css('--timeline-ruler-text', '#a0a0a8')
    ctx.font = '11px system-ui, sans-serif'
    const labelWidth = Math.max(ctx.measureText(`${sec0}s`).width, ctx.measureText(`${sec1}s`).width)
    const step = rulerStepSeconds(pps, Math.max(48, labelWidth + 12))
    for (let s = Math.ceil(Math.max(0, sec0) / step) * step; s <= sec1; s += step) {
      const x = tx(s)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.fillText(`${s}s`, x + 2, 16)
    }

    const selectionSet = new Set(selection)
    const nameByBuffer = new Map(bufferMeta.map((b) => [b.id, b.name]))

    const drawClip = (c: Clip) => {
      const p = previewByIdRef.current?.[c.id]
      const start = p?.startTime ?? c.startTime
      const row = p?.row ?? c.row
      const cc: Clip = { ...c, startTime: start, row }
      const x0 = tx(start)
      const dur = clipTimelineDuration(cc)
      const cw = Math.max(2, dur * pps)
      const y0 = RULER_H + row * ROW_H + 6
      const ch = ROW_H - 12
      const isSelected = selectionSet.has(c.id)
      const accent = clipAccentHex(cc)

      ctx.fillStyle = withAlpha(accent, isSelected ? 0.22 : 0.08)
      ctx.strokeStyle = withAlpha(accent, isSelected ? 0.92 : 0.38)
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.beginPath()
      const radius = 6
      ctx.roundRect(x0, y0, cw, ch, radius)
      ctx.fill()
      ctx.stroke()

      const buf = getCachedBuffer(c.bufferId)
      const peaks = getPeaks(c.bufferId)
      if (buf && peaks && peaks.length >= 2) {
        const buckets = peaks.length / 2
        ctx.strokeStyle = withAlpha(accent, 0.88)
        ctx.lineWidth = 1
        ctx.beginPath()
        const mid = y0 + ch / 2
        const endT = clipTimelineEnd(cc)
        for (let ix = 0; ix < cw; ix++) {
          const frac = cw <= 1 ? 0 : ix / (cw - 1)
          const tLine = Math.min(endT, Math.max(start, start + frac * dur))
          const srcT = sourceTimeAtTimelineTime(cc, tLine)
          const u = srcT / buf.duration
          const bi = Math.max(0, Math.min(buckets - 1, Math.floor(u * buckets)))
          const mn = peaks[bi * 2] ?? 0
          const mx = peaks[bi * 2 + 1] ?? 0
          const fadeMul = fadeMultiplier(cc, tLine, endT)
          const amp = Math.max(Math.abs(mn), Math.abs(mx)) * (ch / 2) * 0.85 * fadeMul
          ctx.moveTo(x0 + ix, mid - amp)
          ctx.lineTo(x0 + ix, mid + amp)
        }
        ctx.stroke()
      }

      ctx.fillStyle = css('--ui-text', '#ececee')
      ctx.font = '12px system-ui, sans-serif'
      ctx.fillText(c.label ?? nameByBuffer.get(c.bufferId) ?? 'clip', x0 + 8, y0 + 18)
    }

    for (const c of clipsDrawOrder) drawClip(c)

    const phx = tx(playhead)
    ctx.strokeStyle = css('--timeline-playhead', '#ff5dcc')
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(phx, 0)
    ctx.lineTo(phx, h)
    ctx.stroke()

    const mq = marqueeRef.current
    if (mq) {
      const x = Math.min(mq.x0, mq.x1)
      const y = Math.min(mq.y0, mq.y1)
      const rw = Math.abs(mq.x1 - mq.x0)
      const rh = Math.abs(mq.y1 - mq.y0)
      ctx.fillStyle = css('--timeline-marquee-fill', 'rgba(95,201,231,0.1)')
      ctx.strokeStyle = css('--timeline-marquee-stroke', 'rgba(94,253,247,0.5)')
      ctx.fillRect(x, y, rw, rh)
      ctx.strokeRect(x, y, rw, rh)
    }

    syncHoverDom()
  }, [bufferMeta, clipsDrawOrder, playhead, pps, selection, syncHoverDom, tx, xt])

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

  useLayoutEffect(() => {
    if (!isPlaying) return
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth
    if (w <= 0) return
    const st = useProjectStore.getState()
    const next = scrollForPlayheadCentered(playhead, w, st.clips, st.pixelsPerSecond)
    st.setScrollX(next)
  }, [playhead, isPlaying, clips, pps])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const onWheelNative = (e: WheelEvent) => {
      const st = useProjectStore.getState()
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const canvas = canvasRef.current
        const cw = canvas?.clientWidth ?? wrap.clientWidth
        const rect = canvas?.getBoundingClientRect()
        const localX = rect ? e.clientX - rect.left : cw / 2
        const factor = zoomFactorFromWheel(e)
        const pps0 = st.pixelsPerSecond
        const pps1 = Math.max(10, Math.min(500, pps0 * factor))
        if (pps1 === pps0) return
        const anchor = localX - TIMELINE_PAD_L
        const t = (anchor + st.scrollX) / pps0
        const maxS = maxTimelineScrollPx(cw, st.clips, pps1)
        const scrollX1 = Math.max(0, Math.min(maxS, t * pps1 - anchor))
        useProjectStore.setState({ pixelsPerSecond: pps1, scrollX: scrollX1 })
        return
      }
      e.preventDefault()
      const canvas = canvasRef.current
      const cw = canvas?.clientWidth ?? wrap.clientWidth
      const maxS = maxTimelineScrollPx(cw, st.clips, st.pixelsPerSecond)
      const delta = e.shiftKey ? e.deltaY : e.deltaX + e.deltaY
      const next = Math.max(0, Math.min(maxS, st.scrollX + delta))
      st.setScrollX(next)
    }

    wrap.addEventListener('wheel', onWheelNative, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheelNative)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const hit = hitTest(e.clientX, e.clientY, rect)
    const y = e.clientY - rect.top
    const x = e.clientX - rect.left
    const t = Math.max(0, xt(x))

    if (e.altKey && y >= RULER_H) {
      if (hit) {
        if (e.shiftKey && anchorRef.current) {
          selectRangeFromAnchor(anchorRef.current, hit.id)
        } else if (e.shiftKey) {
          toggleSelect(hit.id)
          anchorRef.current = hit.id
        } else {
          selectOnly(hit.id)
          anchorRef.current = hit.id
        }
        dragRef.current = {
          id: hit.id,
          dragIds: [hit.id],
          origById: { [hit.id]: { startTime: hit.startTime, row: hit.row } },
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          origStart: hit.startTime,
          origRow: hit.row,
          hasMoved: false,
          altDupSourceId: hit.id,
          altDupCreated: false,
        }
        previewByIdRef.current = null
        hoverLocalXRef.current = null
        syncHoverDom()
        canvas.setPointerCapture(e.pointerId)
        canvas.style.cursor = 'grabbing'
        requestDraw()
        return
      }
      pushUndo()
      splitAt(t, { column: true })
      void seekToTimelineTime(t)
      return
    }

    if (hit) {
      const selectedNow = useProjectStore.getState().selection
      const dragIds =
        !e.shiftKey && selectedNow.length > 1 && selectedNow.includes(hit.id)
          ? selectedNow
          : [hit.id]
      if (e.shiftKey && anchorRef.current) {
        selectRangeFromAnchor(anchorRef.current, hit.id)
      } else if (e.shiftKey) {
        toggleSelect(hit.id)
        anchorRef.current = hit.id
      } else if (dragIds.length === 1) {
        selectOnly(hit.id)
        anchorRef.current = hit.id
      }
      const clipById = new Map(clips.map((c) => [c.id, c] as const))
      const origById: Record<ClipId, { startTime: number; row: number }> = {}
      for (const id of dragIds) {
        const c = clipById.get(id)
        if (!c) continue
        origById[id] = { startTime: c.startTime, row: c.row }
      }
      dragRef.current = {
        id: hit.id,
        dragIds,
        origById,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origStart: hit.startTime,
        origRow: hit.row,
        hasMoved: false,
      }
      previewByIdRef.current = null
      hoverLocalXRef.current = null
      syncHoverDom()
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
      requestDraw()
      return
    }

    if (y >= RULER_H) {
      void seekToTimelineTime(t)
      marqueeRef.current = {
        pointerId: e.pointerId,
        x0: x,
        y0: y,
        x1: x,
        y1: y,
      }
      hoverLocalXRef.current = null
      syncHoverDom()
      canvas.setPointerCapture(e.pointerId)
      if (!e.shiftKey) selectOnly(null)
      requestDraw()
      return
    }

    void seekToTimelineTime(t)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const lx = e.clientX - rect.left
    const d = dragRef.current
    const m = marqueeRef.current
    if (!d && !m) {
      hoverLocalXRef.current = lx
      syncHoverDom()
      const ly = e.clientY - rect.top
      if (ly >= RULER_H && hitTest(e.clientX, e.clientY, rect)) canvas.style.cursor = 'grab'
      else canvas.style.cursor = 'crosshair'
    }

    if (d && e.pointerId === d.pointerId) {
      hoverLocalXRef.current = null
      syncHoverDom()
      const dx = e.clientX - d.startClientX
      const dy = e.clientY - d.startClientY
      if (!d.hasMoved && Math.hypot(dx, dy) < DRAG_START_PX) return
      d.hasMoved = true
      if (d.altDupSourceId && !d.altDupCreated) {
        pushUndo()
        const newId = duplicateClipForDrag(d.altDupSourceId)
        if (!newId) {
          dragRef.current = null
          previewByIdRef.current = null
          if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
          canvas.style.cursor = ''
          requestDraw()
          return
        }
        d.id = newId
        d.dragIds = [newId]
        d.origById = { [newId]: { startTime: d.origStart, row: d.origRow } }
        d.altDupCreated = true
        selectOnly(newId)
        anchorRef.current = newId
      }
      const clipsNow = useProjectStore.getState().clips
      const c = clipsNow.find((x) => x.id === d.id)
      if (!c) {
        requestDraw()
        return
      }
      const groupIds = d.dragIds.filter((id) => d.origById[id] != null)
      if (groupIds.length === 0) {
        requestDraw()
        return
      }
      const rawStart = Math.max(0, quantizeTimelineStep(d.origStart + dx / pps))
      let rowShift = Math.round(dy / ROW_H)
      const minOrigRow = Math.min(...groupIds.map((id) => d.origById[id]!.row))
      if (minOrigRow + rowShift < 0) rowShift = -minOrigRow
      const minOrigStart = Math.min(...groupIds.map((id) => d.origById[id]!.startTime))
      let deltaStart = rawStart - d.origStart
      if (minOrigStart + deltaStart < 0) deltaStart = -minOrigStart
      const anchorRawStart = d.origStart + deltaStart
      const newRow = Math.max(0, d.origRow + rowShift)
      const snapOn = !(e.metaKey || e.ctrlKey)
      const staticClips = clipsNow.filter((x) => !groupIds.includes(x.id))
      const newStart = resolveDraggedClipStart(staticClips, c, anchorRawStart, newRow, snapOn, pps)
      deltaStart = newStart - d.origStart
      const nextPreview: Record<ClipId, { startTime: number; row: number }> = {}
      for (const id of groupIds) {
        const orig = d.origById[id]
        nextPreview[id] = {
          startTime: Math.max(0, orig.startTime + deltaStart),
          row: Math.max(0, orig.row + rowShift),
        }
      }
      previewByIdRef.current = nextPreview
      requestDraw()
      return
    }

    if (m && e.pointerId === m.pointerId) {
      hoverLocalXRef.current = null
      syncHoverDom()
      m.x1 = e.clientX - rect.left
      m.y1 = e.clientY - rect.top
      requestDraw()
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    const d = dragRef.current
    if (d && e.pointerId === d.pointerId) {
      dragRef.current = null
      const dropById = previewByIdRef.current
      previewByIdRef.current = null
      if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      if (canvas) canvas.style.cursor = ''
      const moved =
        d.hasMoved || Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY) >= DRAG_START_PX
      if (!moved) {
        const rect = canvas?.getBoundingClientRect()
        if (rect) {
          const lx = e.clientX - rect.left
          const t = Math.max(0, xt(lx))
          if (d.altDupSourceId && !d.altDupCreated) {
            pushUndo()
            splitAt(t, { onlyClipId: d.altDupSourceId })
          }
          void seekToTimelineTime(t)
        }
        requestDraw()
        return
      }
      {
        const clipsNow = useProjectStore.getState().clips
        const updates: Array<{ id: ClipId; startTime: number; row: number }> = []
        for (const id of d.dragIds) {
          const clip = clipsNow.find((x) => x.id === id)
          const drop = dropById?.[id]
          if (!clip || !drop) continue
          const changed =
            Math.abs(drop.startTime - clip.startTime) > 1e-6 || drop.row !== clip.row
          if (!changed) continue
          updates.push({ id, startTime: drop.startTime, row: drop.row })
        }
        if (updates.length) {
          pushUndo()
          for (const up of updates) updateClip(up.id, { startTime: up.startTime, row: up.row })
        }
      }
      requestDraw()
      return
    }

    const m = marqueeRef.current
    if (m && e.pointerId === m.pointerId) {
      marqueeRef.current = null
      if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      if (canvas) canvas.style.cursor = ''
      const x = Math.min(m.x0, m.x1)
      const y = Math.min(m.y0, m.y1)
      const rw = Math.abs(m.x1 - m.x0)
      const rh = Math.abs(m.y1 - m.y0)
      const t0 = xt(x)
      const t1 = xt(x + rw)
      const row0 = Math.floor((y - RULER_H) / ROW_H)
      const row1 = Math.floor((y + rh - RULER_H) / ROW_H)
      const loT = Math.min(t0, t1)
      const hiT = Math.max(t0, t1)
      const loR = Math.min(row0, row1)
      const hiR = Math.max(row0, row1)
      const picked: ClipId[] = []
      for (const c of clips) {
        const cs = c.startTime
        const ce = clipTimelineEnd(c)
        if (c.row < loR || c.row > hiR) continue
        if (ce < loT || cs > hiT) continue
        picked.push(c.id)
      }
      if (picked.length) setSelection(picked)
      requestDraw()
    }
  }

  const onPointerLeave = () => {
    hoverLocalXRef.current = null
    syncHoverDom()
  }

  return (
    <div
      ref={wrapRef}
      className="timeline-wrap"
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void ingestAudioFiles([...e.dataTransfer.files], true)
      }}
    >
      <div ref={canvasAreaRef} className="timeline-canvas-area">
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        <div className="timeline-hover-layer">
          <div ref={hoverLineRef} className="timeline-hover-line" aria-hidden />
          <div ref={hoverTimeRef} className="timeline-hover-time" aria-hidden />
        </div>
      </div>
    </div>
  )
}
