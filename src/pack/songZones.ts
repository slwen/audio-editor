import type { ZoneFlag } from '@/adaptive/zonePlan'

/** Rough listener-marked feel changes for one song, saved to song-zones.json for offline tools. */
export type SongZonesRecord = {
  version: 1
  sourceName: string
  trimStartSec: number
  trimEndSec: number
  flags: ZoneFlag[]
  updatedAt: string
}
export type SongZonesFile = Record<string, SongZonesRecord>

export function isSongZonesRecord(value: unknown): value is SongZonesRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as SongZonesRecord
  return r.version === 1 && typeof r.sourceName === 'string' && r.sourceName.length > 0
    && Number.isFinite(r.trimStartSec) && Number.isFinite(r.trimEndSec) && r.trimEndSec > r.trimStartSec
    && Number.isFinite(Date.parse(r.updatedAt)) && Array.isArray(r.flags)
    && r.flags.every(f => typeof f?.id === 'string' && Number.isFinite(f.timeSec)
      && (f.state === 'exploration' || f.state === 'combat'))
}

export async function saveSongZones(record: Omit<SongZonesRecord, 'version' | 'updatedAt'>): Promise<void> {
  const response = await fetch('/__song-zones', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), ...record }) })
  if (!response.ok) throw new Error('Song markers could not be saved to disk')
}
