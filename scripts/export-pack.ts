/**
 * Copy a built pack, compressed audio and the dependency-free runtime into a game client.
 * Run: npm run export-pack -- sample_songs/<song>.mp3 --to <game>/client [--bitrate 80k]
 * Writes <client>/sfx/music/adaptive/<song>.pack.json and <song>.mp3 (libmp3lame 80k by default; the game's
 * own pipeline uses 128k), plus <client>/src/audio/adaptive/vendor/{packFormat,runtime,livePlayer}.ts.
 * When analysis/<song>.layers/base.wav and top.wav exist, writes <song>.base.mp3 and <song>.top.mp3 instead
 * and removes a stale full-mix <song>.mp3. Requires ffmpeg.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PACK_VERSION, type Pack } from '@/pack/packFormat'
import { randomRequests, simulatePack, summarizeSimulation } from '@/pack/simulate'
import { packPath } from './build-pack.ts'

const RUNTIME_FILES = ['packFormat.ts', 'runtime.ts', 'livePlayer.ts']
const CHECK_RATE = 48000
/** Encoders may add a fixed delay; a constant shift moves every exit and entry alike, so joins still line up. */
const MAX_OFFSET_SPREAD_SEC = 0.001

function decodeMono(file: string): Float32Array {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(CHECK_RATE), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 })
  return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4)
}

/** Lag (seconds) that best aligns `encoded` to `original` around `atSec`, within ±60 ms. */
function offsetAt(original: Float32Array, encoded: Float32Array, atSec: number): number {
  const win = Math.round(0.5 * CHECK_RATE)
  const maxLag = Math.round(0.06 * CHECK_RATE)
  const start = Math.round(atSec * CHECK_RATE)
  let best = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0
    let energy = 0
    for (let i = 0; i < win; i += 2) {
      const a = original[start + i] ?? 0
      const b = encoded[start + i + lag] ?? 0
      dot += a * b
      energy += b * b
    }
    const score = dot / Math.sqrt(energy + 1e-12)
    if (score > bestScore) { bestScore = score; best = lag }
  }
  return best / CHECK_RATE
}

function encodeMp3(input: string, output: string, bitrate: string) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', bitrate, output])
}

function alignmentOffsets(original: Float32Array, encoded: Float32Array): number[] {
  const duration = original.length / CHECK_RATE
  return [0.2, 0.4, 0.6, 0.8].map(f => offsetAt(original, encoded, duration * f))
}

function assertNoDrift(offsets: number[]) {
  const spread = Math.max(...offsets) - Math.min(...offsets)
  if (spread > MAX_OFFSET_SPREAD_SEC) {
    throw new Error(`Encoded audio drifts against the original (${offsets.map(o => (o * 1000).toFixed(2)).join(', ')} ms); joins would misalign`)
  }
}

function sumMono(a: Float32Array, b: Float32Array): Float32Array {
  const frames = Math.max(a.length, b.length)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
  return out
}

/**
 * Smaller JSON for the web: times to 0.1 ms and probabilities to 3 places. Every time goes through
 * the same rounding, so exits that equal beats (and entrances that equal zone starts) still match.
 */
function compactPack(pack: Pack): Pack {
  const t = (sec: number) => Math.round(sec * 1e4) / 1e4
  const p = (value: number) => Math.round(value * 1e3) / 1e3
  return {
    ...pack,
    durationSec: t(pack.durationSec),
    beatsSec: pack.beatsSec.map(t),
    zones: pack.zones.map(z => ({ ...z, startSec: t(z.startSec), endSec: t(z.endSec) })),
    jumps: pack.jumps.map(j => ({
      ...j,
      exitSec: t(j.exitSec),
      entrySec: t(j.entrySec),
      pCut: p(j.pCut),
      pBlended: p(j.pBlended),
      ...(j.fadeSec !== undefined ? { fadeSec: t(j.fadeSec) } : {}),
      ...(j.entranceSec !== undefined ? { entranceSec: t(j.entranceSec) } : {}),
    })),
  }
}

export async function main(args: string[]) {
  const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
  const client = option('to')
  const bitrate = option('bitrate') ?? '80k'
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  if (!file || !client) throw new Error('Usage: npm run export-pack -- sample_songs/<song>.mp3 --to <game>/client [--bitrate 80k]')
  const sourceName = path.basename(file)
  const pack: Pack = JSON.parse(fs.readFileSync(packPath(sourceName), 'utf8'))
  if (pack.version !== PACK_VERSION) throw new Error(`${packPath(sourceName)} is ${pack.version}; rebuild it with npm run build-pack`)
  if (pack.zoneSource !== 'listener') console.warn(`Warning: ${sourceName} uses guessed zones; mark it in the editor first.`)

  const assets = path.join(client, 'sfx', 'music', 'adaptive')
  const vendor = path.join(client, 'src', 'audio', 'adaptive', 'vendor')
  fs.mkdirSync(assets, { recursive: true })
  fs.mkdirSync(vendor, { recursive: true })
  const base = sourceName.replace(/\.[^.]+$/, '')
  const baseWav = path.join('analysis', `${base}.layers`, 'base.wav')
  const topWav = path.join('analysis', `${base}.layers`, 'top.wav')
  const layered = fs.existsSync(baseWav) && fs.existsSync(topWav)
  const fullMix = path.join(assets, `${base}.mp3`)
  const original = decodeMono(file)
  const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
  let audioLog: string
  if (layered) {
    const baseMp3 = path.join(assets, `${base}.base.mp3`)
    const topMp3 = path.join(assets, `${base}.top.mp3`)
    encodeMp3(baseWav, baseMp3, bitrate)
    encodeMp3(topWav, topMp3, bitrate)
    if (fs.existsSync(fullMix)) fs.unlinkSync(fullMix)
    const baseEnc = decodeMono(baseMp3)
    const topEnc = decodeMono(topMp3)
    const deltaMs = Math.abs(baseEnc.length - topEnc.length) / CHECK_RATE * 1000
    if (deltaMs > 1) {
      throw new Error(`Encoded layers differ by ${deltaMs.toFixed(2)} ms (${baseEnc.length} vs ${topEnc.length} samples)`)
    }
    const offsets = alignmentOffsets(original, sumMono(baseEnc, topEnc))
    assertNoDrift(offsets)
    audioLog = `Audio: ${bitrate} MP3 layers, base ${mb(fs.statSync(baseMp3).size)} MB, top ${mb(fs.statSync(topMp3).size)} MB;`
      + ` constant offset ${(offsets[0]! * 1000).toFixed(2)} ms (joins unaffected)`
  } else {
    encodeMp3(file, fullMix, bitrate)
    const offsets = alignmentOffsets(original, decodeMono(fullMix))
    assertNoDrift(offsets)
    audioLog = `Audio: ${bitrate} MP3, ${mb(fs.statSync(file).size)} MB -> ${mb(fs.statSync(fullMix).size)} MB;`
      + ` constant offset ${(offsets[0]! * 1000).toFixed(2)} ms (joins unaffected)`
  }

  const compact = compactPack(pack)
  const before = summarizeSimulation(pack, simulatePack(pack, 600, randomRequests(600, 1)))
  const after = summarizeSimulation(compact, simulatePack(compact, 600, randomRequests(600, 1)))
  if (JSON.stringify(before.joins) !== JSON.stringify(after.joins)) {
    throw new Error(`Rounding changed playback (${JSON.stringify(before.joins)} vs ${JSON.stringify(after.joins)})`)
  }
  const packFile = path.join(assets, `${base}.pack.json`)
  fs.writeFileSync(packFile, JSON.stringify(compact))
  for (const name of RUNTIME_FILES) {
    const body = fs.readFileSync(path.join('src', 'pack', name), 'utf8')
    fs.writeFileSync(path.join(vendor, name),
      `// Copied from audio-editor src/pack/${name} by \`npm run export-pack\`. Edit it there, then export again.\n${body}`)
  }
  const approved = pack.jumps.filter(j => j.source === 'listener').length
  console.log(`${sourceName}: ${pack.zones.length} zones, ${pack.jumps.length} jumps (${approved} approved),`
    + ` ${(fs.statSync(packFile).size / 1e3).toFixed(0)} KB -> ${assets}`)
  console.log(audioLog)
  console.log(`Runtime: ${RUNTIME_FILES.join(', ')} -> ${vendor}`)
}
