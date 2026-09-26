/**
 * Song + listener zones -> analysis/<song>.pack.json, the runtime's whole input.
 * Run: npm run build-pack -- sample_songs/<song>.mp3 [more files]
 * Zones come from song-zones.json (saved by the editor's song markers); without them, loud busy
 * stretches are guessed as combat and the pack says so.
 */
import fs from 'node:fs'
import path from 'node:path'
import { analyzeSongMap } from '@/pack/songMap'
import { buildPack, type Pack } from '@/pack/pack'
import { packReadiness } from '@/pack/simulate'
import type { SongZonesFile } from '@/pack/songZones'
import { decodeForAnalysis } from './decodeAudio.ts'
import { listenerJoins } from './listenerJoins.ts'

export function packPath(sourceName: string): string {
  return path.join('analysis', `${sourceName.replace(/\.[^.]+$/, '')}.pack.json`)
}

export function printReadiness(pack: Pack) {
  console.log(`  zones (${pack.zoneSource}):`)
  for (const r of packReadiness(pack)) {
    const hold = r.holdAfterSec === null ? 'NO GOOD HOLD'
      : `holds after ${r.holdAfterSec.toFixed(0)} s (${r.holdHeard ? 'approved by you' : 'suggested'})`
    const wait = r.longestSwitchWaitSec === null ? 'NO GOOD SWITCH' : `longest switch wait ${r.longestSwitchWaitSec.toFixed(1)} s`
    console.log(`    ${String(r.zone).padStart(2)} ${r.feel.padEnd(11)} ${r.startSec.toFixed(1).padStart(6)}-${r.endSec.toFixed(1).padEnd(6)} s:`
      + ` ${hold}, ${r.switchExits} switch exits (${r.heardSwitchExits} approved), ${wait}`)
  }
}

export async function main(args: string[]) {
  const files = args.length ? args : fs.readdirSync('sample_songs').filter(f => /\.(mp3|wav|flac|ogg)$/i.test(f))
    .map(f => path.join('sample_songs', f))
  const zonesFile: SongZonesFile = fs.existsSync('song-zones.json') ? JSON.parse(fs.readFileSync('song-zones.json', 'utf8')) : {}
  fs.mkdirSync('analysis', { recursive: true })
  for (const file of files) {
    const sourceName = path.basename(file)
    const { samples, sampleRate } = decodeForAnalysis(file)
    const map = analyzeSongMap({ samples, sampleRate, jumpsPerExit: Infinity })
    const zones = zonesFile[sourceName]
    const pack = buildPack(sourceName, map, zones?.flags.length ? zones : null, listenerJoins(sourceName))
    const out = packPath(sourceName)
    // Probabilities stay unrounded: rounding would move jumps across the minP threshold.
    fs.writeFileSync(out, JSON.stringify(pack))
    const approved = pack.jumps.filter(j => j.source === 'listener').length
    console.log(`${sourceName}: ${pack.jumps.length} jumps (${approved} approved by you, ${pack.blockedJumps} you rated Bad removed) -> ${out}`)
    printReadiness(pack)
  }
}
