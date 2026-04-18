import { audioEngine } from '@/audio/AudioEngine'
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
  const { onEnded, onTick } = playCallbacks()
  audioEngine.play(tClamped, st.clips, st.masterGain, onEnded, onTick)
}

export async function togglePlayback(): Promise<void> {
  const st = useProjectStore.getState()
  await audioEngine.init()
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
  void audioEngine.init().then(() => {
    audioEngine.stop()
    useProjectStore.getState().setPlayhead(0)
    useProjectStore.getState().setIsPlaying(false)
  })
}
