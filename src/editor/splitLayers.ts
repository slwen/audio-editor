import { audioEngine } from '@/audio/AudioEngine'
import { getCachedBuffer } from '@/audio/bufferCache'
import { writeWavStereo16 } from '@/audio/wavBytes'
import { getOriginalBytes } from '@/persistence/fileBytes'
import { useProjectStore } from '@/store/useProjectStore'
import { STEM_KINDS, type LayerLayout, type StemKind } from './layerPlan'

type JobResponse = {
  id: string
  state: 'running' | 'ready' | 'error'
  progress: number
  message: string
}

export type LayerSplitProgress = {
  sourceName: string
  current: number
  total: number
  progress: number
  message: string
}
export type LayerSplitQuality = 'standard' | 'high'

async function jsonResponse(response: Response): Promise<JobResponse> {
  const data = await response.json() as JobResponse & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Stem splitter returned ${response.status}.`)
  return data
}

const waitForStatus = () => new Promise<void>(resolve => window.setTimeout(resolve, 1000))

/** Separate each unique source once, then atomically replace the clips selected at click time. */
export async function splitSelectedIntoLayers(
  layout: LayerLayout,
  quality: LayerSplitQuality,
  onProgress: (progress: LayerSplitProgress) => void
): Promise<number> {
  const initial = useProjectStore.getState()
  const clipsReference = initial.clips
  const selectedIds = [...initial.selection]
  const selected = initial.clips.filter(c => selectedIds.includes(c.id))
  if (initial.editorMode !== 'edit' || !selected.length) throw new Error('Select clips in Editor first.')
  const sourceIds = [...new Set(selected.map(c => c.bufferId))]
  const context = await audioEngine.init()
  const prepared: {
    sourceBufferId: string
    stems: { kind: StemKind; bufferId: string; buffer: AudioBuffer; bytes: ArrayBuffer }[]
  }[] = []

  for (const [index, sourceBufferId] of sourceIds.entries()) {
    const meta = initial.bufferMeta.find(m => m.id === sourceBufferId)
    const sourceName = meta?.name ?? 'Selected clip'
    const decoded = getCachedBuffer(sourceBufferId)
    const sourceBytes = getOriginalBytes(sourceBufferId) ?? (decoded ? writeWavStereo16(decoded) : undefined)
    if (!sourceBytes) throw new Error(`Source audio is missing for ${sourceName}.`)
    const report = (progress: number, message: string) =>
      onProgress({ sourceName, current: index + 1, total: sourceIds.length, progress, message })
    report(0, 'Uploading audio')

    const start = await jsonResponse(await fetch(
      `/__editor-stems/jobs?layout=${layout}&quality=${quality}&name=${encodeURIComponent(sourceName)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: sourceBytes.slice(0) }
    ))
    const jobId = start.id
    try {
      let status = start
      while (status.state === 'running') {
        report(status.progress, status.message)
        await waitForStatus()
        status = await jsonResponse(await fetch(`/__editor-stems/jobs?id=${encodeURIComponent(jobId)}`))
      }
      if (status.state !== 'ready') throw new Error(status.message || `Could not split ${sourceName}.`)
      const stems: typeof prepared[number]['stems'] = []
      for (const kind of STEM_KINDS[layout]) {
        report(1, `Loading ${kind}`)
        const response = await fetch(`/__editor-stems/stem?id=${encodeURIComponent(jobId)}&stem=${kind}`)
        if (!response.ok) throw new Error(`Could not load the ${kind} layer for ${sourceName}.`)
        const bytes = await response.arrayBuffer()
        const buffer = await context.decodeAudioData(bytes.slice(0))
        stems.push({ kind, bufferId: crypto.randomUUID(), buffer, bytes })
      }
      prepared.push({ sourceBufferId, stems })
    } finally {
      void fetch(`/__editor-stems/jobs?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {})
    }
  }

  if (useProjectStore.getState().clips !== clipsReference) {
    throw new Error('The timeline changed during splitting. Select the clips and try again.')
  }
  return useProjectStore.getState().replaceSelectedWithLayers(selectedIds, prepared)
}
