import { useProjectStore } from '@/store/useProjectStore'
import { clipTimelineEnd } from '@/lib/clipMath'

export function splitAtPlayhead(): void {
  const st = useProjectStore.getState()
  const selected = new Set(st.selection)
  const canSplit = st.clips.some(c =>
    (selected.size === 0 || selected.has(c.id)) &&
    st.playhead > c.startTime + 1e-4 &&
    st.playhead < clipTimelineEnd(c) - 1e-4
  )
  if (!canSplit) return
  st.pushUndo()
  st.splitAt(st.playhead)
}
