import { useEffect } from 'react'
import { audioEngine } from '@/audio/AudioEngine'
import { cacheBuffer } from '@/audio/bufferCache'
import { setPeaksForBuffer } from '@/lib/peaksCache'
import { loadOriginalBytesMap, takeOriginalBytesMap } from '@/persistence/fileBytes'
import { loadProject, saveProject } from '@/persistence/projectDb'
import type { PersistedProject } from '@/persistence/projectDb'
import { useProjectStore } from '@/store/useProjectStore'

/** Keep autosave mounted in both Edit and Loop modes. */
export function useProjectPersistence(): void {
  const loadSnapshot = useProjectStore((s) => s.loadSnapshot)

  useEffect(() => {
    let saveTimer: number
    let unsub: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        const raw = await loadProject()
        if (!cancelled && raw && raw.version === 1) {
          const ctx = await audioEngine.init()
          loadOriginalBytesMap(raw.fileBytes ?? {})
          for (const m of raw.bufferMeta) {
            const bytes = raw.fileBytes?.[m.id]
            if (!bytes) continue
            try {
              const buf = await ctx.decodeAudioData(bytes.slice(0))
              cacheBuffer(m.id, buf)
              setPeaksForBuffer(m.id, buf)
            } catch {
              /* skip corrupt */
            }
          }
          loadSnapshot({
            clips: raw.clips,
            bufferMeta: raw.bufferMeta,
            playhead: raw.playhead,
            masterGain: raw.masterGain,
          })
        }
      } catch {
        /* ignore load errors */
      }
      if (cancelled) return
      unsub = useProjectStore.subscribe((s) => {
        window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          const data: PersistedProject = {
            version: 1,
            clips: s.clips,
            bufferMeta: s.bufferMeta,
            playhead: s.playhead,
            masterGain: s.masterGain,
            fileBytes: takeOriginalBytesMap(),
          }
          void saveProject(data)
        }, 500)
      })
    })()

    return () => {
      cancelled = true
      window.clearTimeout(saveTimer)
      unsub?.()
    }
  }, [loadSnapshot])
}
