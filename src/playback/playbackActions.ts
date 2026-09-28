import { audioEngine } from '@/audio/AudioEngine'
import { seekGameSong, toggleGameSongPlayback } from '@/gameSong/actions'
import { joinPreviewOffset } from '@/loop/detectLoops'
import { getProjectEndTime } from '@/lib/clipMath'
import { startLoopPreview, stopLoopPreview } from '@/loop/loopModeActions'
import { useGameSongStore } from '@/gameSong/store'
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
    await startLoopPreview(id ?? undefined, 'full', tClamped)
    return
  }
  const { onEnded, onTick } = playCallbacks()
  audioEngine.play(tClamped, st.clips, st.masterGain, onEnded, onTick)
}

export function seekRelative(seconds: number): void {
  const st = useProjectStore.getState()
  if (st.editorMode === 'game-song') {
    const song = useGameSongStore.getState()
    const end = song.analysis?.durationSec ?? Infinity
    seekGameSong(Math.max(0, Math.min(end, song.playhead + seconds)))
    return
  }
  if (st.editorMode === 'loop') {
    const loop = useLoopStore.getState()
    const candidate = loop.candidates.find(c => c.id === (loop.previewId ?? loop.selectedIds[0]))
    const start = candidate?.startSec ?? loop.trimStart
    const end = candidate?.endSec ?? loop.trimEnd
    void seekToTimelineTime(Math.max(start, Math.min(end, st.playhead + seconds)))
    return
  }
  void seekToTimelineTime(Math.max(0, Math.min(getProjectEndTime(st.clips), st.playhead + seconds)))
}

export async function togglePlayback(): Promise<void> {
  if (useProjectStore.getState().editorMode === 'game-song') {
    await toggleGameSongPlayback()
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
  if (useProjectStore.getState().editorMode === 'game-song') {
    seekGameSong(0)
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
