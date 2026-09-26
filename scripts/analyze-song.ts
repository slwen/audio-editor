/**
 * Headless song map for agents: bar grid, per-bar features and a ranked jump table.
 * Run: npm run analyze -- sample_songs/cathedral-of-iron.mp3 [more files]
 * Writes analysis/<song>.songmap.json. Requires ffmpeg on PATH.
 */
import fs from 'node:fs'
import path from 'node:path'
import { analyzeSongMap, type SongMap } from '@/pack/songMap'
import { decodeForAnalysis } from './decodeAudio.ts'

const round = (value: number, digits = 4) => Number(value.toFixed(digits))

function compact(map: SongMap, sourceName: string) {
  return {
    ...map,
    sourceName,
    durationSec: round(map.durationSec),
    bpm: round(map.bpm),
    beatsSec: map.beatsSec.map(t => round(t)),
    downbeatConfidence: round(map.downbeatConfidence, 3),
    bars: map.bars.map(bar => ({ ...bar, startSec: round(bar.startSec), endSec: round(bar.endSec),
      loudnessDb: round(bar.loudnessDb, 2), brightness: round(bar.brightness, 3), density: round(bar.density, 3),
      chroma: bar.chroma.map(v => round(v, 3)) })),
    jumps: map.jumps.map(jump => ({ exitBeat: jump.exitBeat, entryBeat: jump.entryBeat,
      pGoodCut: round(jump.pGoodCut, 3), pGoodBlended: round(jump.pGoodBlended, 3), seam: round(jump.seam, 3),
      vibe: round(jump.vibe, 3), join: round(jump.join, 3), closure: round(jump.closure, 3),
      loudnessChangeDb: round(jump.loudnessChangeDb, 2) })),
  }
}

export async function main(args: string[]) {
  const files = args.length ? args : fs.readdirSync('sample_songs').filter(f => /\.(mp3|wav|flac|ogg)$/i.test(f))
    .map(f => path.join('sample_songs', f))
  fs.mkdirSync('analysis', { recursive: true })
  for (const file of files) {
    const t0 = Date.now()
    const { samples, sampleRate } = decodeForAnalysis(file)
    const map = analyzeSongMap({ samples, sampleRate })
    const sourceName = path.basename(file)
    const out = path.join('analysis', `${sourceName.replace(/\.[^.]+$/, '')}.songmap.json`)
    fs.writeFileSync(out, JSON.stringify(compact(map, sourceName)))
    const exits = new Set(map.jumps.map(jump => jump.exitBeat)).size
    const safeExits = (key: 'pGoodCut' | 'pGoodBlended') =>
      new Set(map.jumps.filter(jump => jump[key] >= 0.7).map(jump => jump.exitBeat)).size
    console.log(`${sourceName}: ${map.beatsSec.length} beats, ${map.bars.length} bars, ${map.bpm.toFixed(2)} BPM,`
      + ` downbeat beat ${map.downbeatBeat} (confidence ${map.downbeatConfidence.toFixed(2)});`
      + ` exit beats with a jump at p >= 0.7: cut ${safeExits('pGoodCut')}/${exits}, blended ${safeExits('pGoodBlended')}/${exits};`
      + ` ${Date.now() - t0} ms -> ${out}`)
  }
}
