export type ClipId = string
export type BufferId = string
export type EditorMode = 'edit' | 'loop' | 'game-song'

export interface Clip {
  id: ClipId
  bufferId: BufferId
  startTime: number
  row: number
  layerIndex: number
  trimStart: number
  trimEnd: number
  gain: number
  fadeInSec: number
  fadeOutSec: number
  /** 0.2 — 3; pitch-preserving via SoundTouch */
  speed: number
  /** Per-clip waveform / track accent (bright palette hex). */
  accentColor?: string
  /** Optional display name; falls back to buffer meta name. */
  label?: string
}

export interface BufferMeta {
  id: BufferId
  name: string
  durationSec: number
}

export interface ProjectSnapshot {
  clips: Clip[]
  bufferMeta: BufferMeta[]
  playhead: number
  masterGain: number
}
