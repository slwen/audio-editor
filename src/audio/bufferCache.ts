import type { BufferId } from '@/types'

const buffers = new Map<BufferId, AudioBuffer>()

export function cacheBuffer(id: BufferId, buffer: AudioBuffer): void {
  buffers.set(id, buffer)
}

export function getCachedBuffer(id: BufferId): AudioBuffer | undefined {
  return buffers.get(id)
}

export function removeCachedBuffer(id: BufferId): void {
  buffers.delete(id)
}

export function clearBufferCache(): void {
  buffers.clear()
}
