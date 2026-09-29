import { peaksForBuffer } from '@/lib/peaks'
import type { BufferId } from '@/types'

const peaks = new Map<BufferId, Float32Array>()

export function setPeaksForBuffer(id: BufferId, buffer: AudioBuffer): void {
  peaks.set(id, peaksForBuffer(buffer))
}

export function getPeaks(id: BufferId): Float32Array | undefined {
  return peaks.get(id)
}

export function removePeaks(id: BufferId): void {
  peaks.delete(id)
}

export function clearPeaks(): void {
  peaks.clear()
}

export function retainPeaks(ids: Set<BufferId>): void {
  for (const id of peaks.keys()) if (!ids.has(id)) peaks.delete(id)
}
