import type { BufferId } from '@/types'

/** Original file bytes for IndexedDB restore (per decoded buffer). */
const originals = new Map<BufferId, ArrayBuffer>()

export function rememberOriginalBytes(id: BufferId, bytes: ArrayBuffer): void {
  originals.set(id, bytes)
}

export function takeOriginalBytesMap(): Record<string, ArrayBuffer> {
  const out: Record<string, ArrayBuffer> = {}
  for (const [k, v] of originals) out[k] = v
  return out
}

export function clearOriginalBytes(): void {
  originals.clear()
}

export function loadOriginalBytesMap(map: Record<string, ArrayBuffer>): void {
  originals.clear()
  for (const k of Object.keys(map)) originals.set(k, map[k]!)
}
