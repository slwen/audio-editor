import { describe, expect, it } from 'vitest'
import { createProjectFile, readProjectFile } from './projectFile'
import type { PersistedProject } from './projectDb'

const project: PersistedProject = {
  version: 1,
  clips: [{
    id: 'clip-1', bufferId: 'audio-1', startTime: 12.345, row: 2, layerIndex: 1,
    trimStart: 0.75, trimEnd: 4.25, gain: 0.6, fadeInSec: 0.2,
    fadeOutSec: 0.3, speed: 1.25, accentColor: '#abcdef', label: 'Intro',
  }, {
    id: 'clip-2', bufferId: 'audio-1', startTime: 20, row: 3, layerIndex: 0,
    trimStart: 1, trimEnd: 3, gain: 1, fadeInSec: 0,
    fadeOutSec: 0, speed: 1,
  }],
  bufferMeta: [{ id: 'audio-1', name: 'source.mp3', durationSec: 5 }],
  playhead: 12.9,
  masterGain: 0.8,
  fileBytes: { 'audio-1': new Uint8Array([0, 42, 255, 7]).buffer },
}

describe('portable project file', () => {
  it('round trips clips, exact timing settings, shared audio and playback settings', async () => {
    const restored = await readProjectFile(createProjectFile(project))
    expect(restored).toEqual(project)
  })

  it('rejects truncated files without yielding a partial project', async () => {
    const file = createProjectFile(project)
    await expect(readProjectFile(file.slice(0, file.size - 1))).rejects.toThrow('valid audio editor project')
  })

  it('rejects a file whose clip references missing audio', async () => {
    const file = createProjectFile({ ...project, clips: [{ ...project.clips[0]!, bufferId: 'missing' }] })
    await expect(readProjectFile(file)).rejects.toThrow('valid audio editor project')
  })
})
