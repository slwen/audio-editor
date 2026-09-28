import type { PersistedProject } from './projectDb'
import type { BufferMeta, Clip } from '@/types'

const MAGIC = 'AEPROJ1\n'
const HEADER_SIZE = MAGIC.length + 4
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

type AudioEntry = { id: string; byteLength: number }
type Manifest = {
  version: 1
  clips: Clip[]
  bufferMeta: BufferMeta[]
  playhead: number
  masterGain: number
  audio: AudioEntry[]
}

const invalid = () => new Error('This is not a valid audio editor project file.')
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function validManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<Manifest>
  if (m.version !== 1 || !Array.isArray(m.clips) || !Array.isArray(m.bufferMeta) ||
      !Array.isArray(m.audio) || !finite(m.playhead) || !finite(m.masterGain)) return false
  const ids = new Set<string>()
  for (const b of m.bufferMeta) {
    if (!b || typeof b.id !== 'string' || !b.id || typeof b.name !== 'string' ||
        !finite(b.durationSec) || b.durationSec < 0 || ids.has(b.id)) return false
    ids.add(b.id)
  }
  const audioIds = new Set<string>()
  for (const a of m.audio) {
    if (!a || typeof a.id !== 'string' || !ids.has(a.id) || audioIds.has(a.id) ||
        !Number.isSafeInteger(a.byteLength) || a.byteLength <= 0) return false
    audioIds.add(a.id)
  }
  if (audioIds.size !== ids.size) return false
  const clipIds = new Set<string>()
  for (const c of m.clips) {
    if (!c || typeof c.id !== 'string' || !c.id || clipIds.has(c.id) || !ids.has(c.bufferId) ||
        !finite(c.startTime) || !finite(c.row) || !finite(c.layerIndex) ||
        !finite(c.trimStart) || !finite(c.trimEnd) || !finite(c.gain) ||
        !finite(c.fadeInSec) || !finite(c.fadeOutSec) || !finite(c.speed) ||
        c.trimStart < 0 || c.trimEnd <= c.trimStart || c.speed <= 0 ||
        (c.label !== undefined && typeof c.label !== 'string') ||
        (c.accentColor !== undefined && typeof c.accentColor !== 'string')) return false
    clipIds.add(c.id)
  }
  return true
}

/** A small JSON manifest followed by the original audio files, with no base64 expansion. */
export function createProjectFile(project: PersistedProject): Blob {
  const audio: AudioEntry[] = project.bufferMeta.map(({ id }) => {
    const bytes = project.fileBytes[id]
    if (!bytes?.byteLength) throw new Error('A clip is missing its source audio. It cannot be saved.')
    return { id, byteLength: bytes.byteLength }
  })
  const manifest: Manifest = {
    version: 1,
    clips: project.clips,
    bufferMeta: project.bufferMeta,
    playhead: project.playhead,
    masterGain: project.masterGain,
    audio,
  }
  const encoded = new TextEncoder().encode(JSON.stringify(manifest))
  if (encoded.byteLength > MAX_MANIFEST_BYTES) throw new Error('The project is too large to save.')
  const header = new Uint8Array(HEADER_SIZE)
  for (let i = 0; i < MAGIC.length; i++) header[i] = MAGIC.charCodeAt(i)
  new DataView(header.buffer).setUint32(MAGIC.length, encoded.byteLength, true)
  return new Blob([header, encoded, ...audio.map(({ id }) => project.fileBytes[id]!)],
    { type: 'application/octet-stream' })
}

export async function readProjectFile(file: Blob): Promise<PersistedProject> {
  if (file.size < HEADER_SIZE) throw invalid()
  const header = new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer())
  for (let i = 0; i < MAGIC.length; i++) if (header[i] !== MAGIC.charCodeAt(i)) throw invalid()
  const manifestLength = new DataView(header.buffer).getUint32(MAGIC.length, true)
  if (!manifestLength || manifestLength > MAX_MANIFEST_BYTES ||
      HEADER_SIZE + manifestLength > file.size) throw invalid()
  let manifest: unknown
  try {
    manifest = JSON.parse(await file.slice(HEADER_SIZE, HEADER_SIZE + manifestLength).text())
  } catch {
    throw invalid()
  }
  if (!validManifest(manifest)) throw invalid()
  let offset = HEADER_SIZE + manifestLength
  const fileBytes: Record<string, ArrayBuffer> = Object.create(null) as Record<string, ArrayBuffer>
  for (const entry of manifest.audio) {
    if (entry.byteLength > file.size - offset) throw invalid()
    fileBytes[entry.id] = await file.slice(offset, offset + entry.byteLength).arrayBuffer()
    offset += entry.byteLength
  }
  if (offset !== file.size) throw invalid()
  const { version, clips, bufferMeta, playhead, masterGain } = manifest
  return { version, clips, bufferMeta, playhead, masterGain, fileBytes }
}
