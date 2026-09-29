import type { BufferMeta, Clip, ClipId } from '@/types'
import { pickRandomAccentAvoiding, stableAccentForClipId } from '@/lib/trackAccent'

export type LayerLayout = 'two' | 'four'
export type StemKind = 'base' | 'top' | 'drums' | 'bass' | 'other' | 'vocals'
export const STEM_KINDS: Record<LayerLayout, readonly StemKind[]> = {
  two: ['base', 'top'],
  four: ['drums', 'bass', 'other', 'vocals'],
}
export const STEM_LABELS: Record<StemKind, string> = {
  base: 'Drums + bass',
  top: 'Vocals + other',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
  vocals: 'Vocals',
}

export type LayerSource = {
  sourceBufferId: string
  stems: { kind: StemKind; bufferId: string; durationSec: number }[]
}

/** Replace selected clips with aligned stems; leave all other clips untouched. */
export function planLayeredTimeline(
  clips: Clip[],
  bufferMeta: BufferMeta[],
  selectedIds: ClipId[],
  sources: LayerSource[],
  makeId: () => string = () => crypto.randomUUID()
): { clips: Clip[]; bufferMeta: BufferMeta[]; selection: ClipId[] } {
  const selected = new Set(selectedIds)
  const bySource = new Map(sources.map(source => [source.sourceBufferId, source.stems]))
  const nameByBuffer = new Map(bufferMeta.map(meta => [meta.id, meta.name]))
  const count = sources[0]?.stems.length ?? 0
  if (!count || sources.some(source => source.stems.length !== count)) throw new Error('Incomplete stem set.')

  const selectedRows = [...new Set(clips.filter(c => selected.has(c.id)).map(c => c.row))].sort((a, b) => a - b)
  let nextRow = Math.max(-1, ...clips.map(c => c.row)) + 1
  const extraRows = new Map<number, number[]>()
  for (const row of selectedRows) {
    extraRows.set(row, Array.from({ length: count - 1 }, () => nextRow++))
  }

  const nextClips: Clip[] = []
  const selection: ClipId[] = []
  for (const clip of clips) {
    if (!selected.has(clip.id)) { nextClips.push(clip); continue }
    const stems = bySource.get(clip.bufferId)
    if (!stems) throw new Error('A selected clip has no separated audio.')
    const sourceName = clip.label ?? nameByBuffer.get(clip.bufferId) ?? 'Clip'
    for (const [index, stem] of stems.entries()) {
      const id = makeId()
      nextClips.push({
        ...clip,
        id,
        bufferId: stem.bufferId,
        row: index === 0 ? clip.row : extraRows.get(clip.row)![index - 1]!,
        label: `${sourceName} · ${STEM_LABELS[stem.kind]}`,
        accentColor: index === 0 ? clip.accentColor : pickRandomAccentAvoiding(clip.accentColor ?? stableAccentForClipId(clip.id)),
      })
      selection.push(id)
    }
  }

  const used = new Set(nextClips.map(c => c.bufferId))
  const nextMeta = bufferMeta.filter(meta => used.has(meta.id))
  for (const source of sources) {
    const sourceName = nameByBuffer.get(source.sourceBufferId) ?? 'Clip'
    for (const stem of source.stems) {
      nextMeta.push({ id: stem.bufferId, name: `${sourceName} · ${STEM_LABELS[stem.kind]}`, durationSec: stem.durationSec })
    }
  }
  return { clips: nextClips, bufferMeta: nextMeta, selection }
}
