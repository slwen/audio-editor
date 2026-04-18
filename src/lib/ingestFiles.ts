import { audioEngine } from '@/audio/AudioEngine'
import { useProjectStore } from '@/store/useProjectStore'

export async function ingestAudioFiles(files: File[], dropOnTimeline: boolean): Promise<void> {
  const audioFiles = files.filter(
    (f) => /audio\/|\.mp3$|\.wav$/i.test(f.type) || /\.mp3$|\.wav$/i.test(f.name)
  )
  if (audioFiles.length === 0) return
  const ctx = await audioEngine.init()
  let row = 0
  let t0 = dropOnTimeline ? useProjectStore.getState().playhead : 0
  for (const file of audioFiles) {
    const raw = await file.arrayBuffer()
    const persist = raw.slice(0)
    const buffer = await ctx.decodeAudioData(raw.slice(0))
    useProjectStore.getState().addClipFromBuffer(buffer, file.name, t0, row, persist)
    row += 1
    if (!dropOnTimeline) t0 = 0
  }
}
