import { audioEngine } from '@/audio/AudioEngine'
import { cacheBuffer, clearBufferCache, getCachedBuffer } from '@/audio/bufferCache'
import { writeWavStereo16 } from '@/audio/wavBytes'
import { downloadBlob } from '@/lib/downloadBlob'
import { clearPeaks, setPeaksForBuffer } from '@/lib/peaksCache'
import { exitGameSongMode } from '@/gameSong/actions'
import { exitLoopMode } from '@/loop/loopModeActions'
import { getOriginalBytes, loadOriginalBytesMap } from './fileBytes'
import { createProjectFile, readProjectFile } from './projectFile'
import type { PersistedProject } from './projectDb'
import { useProjectStore } from '@/store/useProjectStore'

export function saveProjectFile(): void {
  const { clips, bufferMeta, playhead, masterGain } = useProjectStore.getState()
  const fileBytes: Record<string, ArrayBuffer> = {}
  for (const { id } of bufferMeta) {
    const original = getOriginalBytes(id)
    if (original) fileBytes[id] = original
    else {
      const decoded = getCachedBuffer(id)
      if (!decoded) throw new Error('A clip is missing its source audio. It cannot be saved.')
      fileBytes[id] = writeWavStereo16(decoded)
    }
  }
  const project: PersistedProject = { version: 1, clips, bufferMeta, playhead, masterGain, fileBytes }
  downloadBlob(createProjectFile(project), 'audio-project.aeproj')
}

export async function openProjectFile(file: File): Promise<void> {
  const project = await readProjectFile(file)
  const context = await audioEngine.init()
  const decoded = new Map<string, AudioBuffer>()
  for (const { id } of project.bufferMeta) {
    try {
      decoded.set(id, await context.decodeAudioData(project.fileBytes[id]!.slice(0)))
    } catch {
      throw new Error(`Could not decode the audio in ${file.name}. The current project was kept.`)
    }
  }

  const mode = useProjectStore.getState().editorMode
  if (mode === 'loop') exitLoopMode()
  else if (mode === 'game-song') exitGameSongMode()
  audioEngine.stop()
  clearBufferCache()
  clearPeaks()
  loadOriginalBytesMap(project.fileBytes)
  for (const [id, buffer] of decoded) {
    cacheBuffer(id, buffer)
    setPeaksForBuffer(id, buffer)
  }
  useProjectStore.getState().loadSnapshot(project)
  audioEngine.setMasterGain(project.masterGain)
}
