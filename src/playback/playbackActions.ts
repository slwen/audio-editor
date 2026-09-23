import { audioEngine } from '@/audio/AudioEngine'
import { auditionPassage, startAdaptive, stopAdaptive } from '@/adaptive/actions'
import { useAdaptiveStore } from '@/adaptive/store'
import { joinPreviewOffset } from '@/loop/detectLoops'
import { startLoopPreview, stopLoopPreview } from '@/loop/loopModeActions'
import { useLoopStore } from '@/store/useLoopStore'
import { useProjectStore } from '@/store/useProjectStore'

const playCallbacks = () =>
  ({
    onEnded: () => {
      useProjectStore.getState().setIsPlaying(false)
      useProjectStore.getState().setPlayhead(audioEngine.getCurrentTimelineTime())
    },
    onTick: (t: number) => useProjectStore.getState().setPlayhead(t),
  }) as const

export async function seekToTimelineTime(t: number): Promise<void> {
  const tClamped = Math.max(0, t)
  await audioEngine.init()
  const st = useProjectStore.getState()
  st.setPlayhead(tClamped)
  if (!st.isPlaying) {
    audioEngine.stop()
    return
  }
  if (st.editorMode === 'loop') {
    const loop = useLoopStore.getState()
    const id = loop.previewId ?? loop.selectedIds[0]
    await startLoopPreview(id ?? undefined)
    return
  }
  const { onEnded, onTick } = playCallbacks()
  audioEngine.play(tClamped, st.clips, st.masterGain, onEnded, onTick)
}

export async function togglePlayback(): Promise<void> {
  if (useAdaptiveStore.getState().open && useProjectStore.getState().editorMode === 'loop') {
    if (useAdaptiveStore.getState().playback.current || useAdaptiveStore.getState().starting || useAdaptiveStore.getState().audition) stopAdaptive()
    else await startAdaptive()
    return
  }
  const st = useProjectStore.getState()
  await audioEngine.init()
  if (st.editorMode === 'loop') {
    if (st.isPlaying) {
      stopLoopPreview()
      return
    }
    await startLoopPreview()
    return
  }
  if (st.isPlaying) {
    const t = audioEngine.getCurrentTimelineTime()
    audioEngine.stop()
    st.setPlayhead(t)
    st.setIsPlaying(false)
    return
  }
  st.setIsPlaying(true)
  const { onEnded, onTick } = playCallbacks()
  audioEngine.play(st.playhead, st.clips, st.masterGain, onEnded, onTick)
}

export function skipToStart(): void {
  if (useAdaptiveStore.getState().open && useProjectStore.getState().editorMode === 'loop') {
    const audition = useAdaptiveStore.getState().audition
    if (audition) { void auditionPassage(audition.slot, audition.mode); return }
    const current = useAdaptiveStore.getState().playback.current
    if (current) void startAdaptive(current)
    return
  }
  void audioEngine.init().then(() => {
    const st = useProjectStore.getState()
    if (st.editorMode === 'loop') {
      const loop = useLoopStore.getState()
      const cand = loop.candidates.find((c) => c.id === (loop.previewId ?? loop.selectedIds[0]))
      const bpm = cand?.bpm ?? loop.bpm ?? 120
      const t = cand
        ? joinPreviewOffset(cand.startSec, cand.endSec, bpm)
        : loop.trimStart
      if (st.isPlaying) {
        void startLoopPreview(cand?.id)
        return
      }
      audioEngine.stop()
      st.setPlayhead(t)
      st.setIsPlaying(false)
      return
    }
    audioEngine.stop()
    st.setPlayhead(0)
    st.setIsPlaying(false)
  })
}
