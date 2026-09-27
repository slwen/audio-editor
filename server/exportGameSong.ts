/**
 * Encode a stem pair and its song.json for the game: same gain on both stems (measured on their sum),
 * identical sample length, and a check that encoding did not move the loop.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readMono, readStereo, run, STEM_SAMPLE_RATE } from './ffmpeg.ts'
import { stemFiles } from './stems.ts'
import { buildSongJson, gameSongFiles, isSongId, normalizeGainDb, TARGET_LUFS, MAX_TRUE_PEAK_DB } from '../src/gameSong/songJson.ts'
import type { ExportRequest, ExportResult } from '../src/gameSong/api.ts'
import { encoderOffsets, MAX_OFFSET_SPREAD_SEC, naturalEndFrames, offsetSpread } from '../src/gameSong/exportChecks.ts'

/**
 * The game decodes music at 32 kHz, so nothing above 16 kHz survives. The default spends 96 kbps
 * below that cutoff; high quality keeps the encoder's own band limit at 128 kbps.
 */
function mp3Args(highQuality: boolean): string[] {
  return highQuality ? ['-b:a', '128k'] : ['-b:a', '96k', '-cutoff', '16000']
}

type Loudness = { input_i: string; input_tp: string }

async function measureLoudness(base: string, top: string, frames: number): Promise<{ lufs: number; truePeakDb: number }> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', base, '-i', top, '-filter_complex',
    `[0:a][1:a]amix=inputs=2:normalize=0:duration=longest,atrim=end_sample=${frames},loudnorm=I=${TARGET_LUFS}:TP=${MAX_TRUE_PEAK_DB}:print_format=json`,
    '-f', 'null', '-'])
  const json = [...stderr.matchAll(/\{[^{}]*\}/g)].at(-1)?.[0]
  if (!json) throw new Error('Could not measure loudness (no loudnorm report from ffmpeg)')
  const report = JSON.parse(json) as Loudness
  const lufs = Number(report.input_i)
  const truePeakDb = Number(report.input_tp)
  if (!Number.isFinite(lufs) || !Number.isFinite(truePeakDb)) throw new Error(`Could not measure loudness (${json})`)
  return { lufs, truePeakDb }
}

async function encodeStem(input: string, output: string, frames: number, gainDb: number, mono: boolean, highQuality: boolean) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', input,
    '-af', `atrim=end_sample=${frames},volume=${gainDb.toFixed(3)}dB`,
    ...(mono ? ['-ac', '1'] : []), '-ar', String(STEM_SAMPLE_RATE),
    '-map_metadata', '-1', '-codec:a', 'libmp3lame', ...mp3Args(highQuality), output])
}

const sumMono = (a: Float32Array, b: Float32Array, frames: number) => {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
  return out
}

export async function exportGameSong(req: ExportRequest, layersDir: string, stagingRoot: string): Promise<ExportResult> {
  if (!isSongId(req.id)) throw new Error('The song id may only use lowercase letters, numbers and dashes, like "cathedral-of-iron".')
  const stems = stemFiles(layersDir)
  if (!fs.existsSync(stems.base) || !fs.existsSync(stems.top)) throw new Error('Split the stems first.')
  const notes: string[] = []

  const base = await readStereo(stems.base)
  const top = await readStereo(stems.top)
  const total = Math.min(base[0]!.length, top[0]!.length)
  const loopEnd = req.loop.endSec + req.loop.fadeSec / 2
  if (req.loop.startSec < 0 || req.loop.endSec <= req.loop.startSec || loopEnd * STEM_SAMPLE_RATE > total) {
    throw new Error('The loop points are outside the song.')
  }
  let frames = total
  if (req.trimEnd) {
    const mix = [0, 1].map(c => sumMono(base[c]!, top[c]!, total))
    frames = naturalEndFrames(mix, STEM_SAMPLE_RATE, loopEnd + 0.5)
    if (frames < total) notes.push(`Cut ${((total - frames) / STEM_SAMPLE_RATE).toFixed(1)} s of silence after the song ends.`)
  }

  const loudness = await measureLoudness(stems.base, stems.top, frames)
  const gainDb = normalizeGainDb(loudness.lufs, loudness.truePeakDb)
  const integratedLufs = loudness.lufs + gainDb
  if (integratedLufs < TARGET_LUFS - 0.5) {
    notes.push(`Only raised to ${integratedLufs.toFixed(1)} LUFS (target ${TARGET_LUFS}) to keep peaks below ${MAX_TRUE_PEAK_DB} dB.`)
  }

  const names = gameSongFiles(req.id)
  const stagingDir = path.join(stagingRoot, req.id)
  fs.rmSync(stagingDir, { recursive: true, force: true })
  fs.mkdirSync(stagingDir, { recursive: true })
  const baseMp3 = path.join(stagingDir, names.base)
  const topMp3 = path.join(stagingDir, names.top)
  await encodeStem(stems.base, baseMp3, frames, gainDb, req.monoBase, req.highQuality)
  await encodeStem(stems.top, topMp3, frames, gainDb, false, req.highQuality)

  const baseEnc = await readMono(baseMp3)
  const topEnc = await readMono(topMp3)
  if (baseEnc.length !== topEnc.length || baseEnc.length !== frames) {
    throw new Error(`Encoded stems have different lengths (base ${baseEnc.length}, top ${topEnc.length}, expected ${frames} samples).`)
  }
  const original = sumMono(await readMono(stems.base), await readMono(stems.top), frames)
  const offsets = encoderOffsets(original, sumMono(baseEnc, topEnc, frames), STEM_SAMPLE_RATE)
  if (offsetSpread(offsets) > MAX_OFFSET_SPREAD_SEC) {
    throw new Error(`Encoded audio drifts against the stems (${offsets.map(o => (o * 1000).toFixed(2)).join(', ')} ms); the loop would move.`)
  }
  // A constant encoder delay shifts the whole song; moving both loop points with it keeps the wrap exact.
  const shift = Math.abs(offsets[0]!) >= 0.0005 ? offsets[0]! : 0
  if (shift) notes.push(`Moved loop points by ${(shift * 1000).toFixed(2)} ms to match the encoder delay.`)

  const song = buildSongJson({
    id: req.id,
    title: req.title.trim() || req.id,
    sourceName: req.sourceName,
    bpm: req.bpm,
    durationSec: frames / STEM_SAMPLE_RATE,
    loop: { startSec: req.loop.startSec + shift, endSec: req.loop.endSec + shift, fadeSec: req.loop.fadeSec },
    integratedLufs,
    gainDb,
  })
  fs.writeFileSync(path.join(stagingDir, names.json), `${JSON.stringify(song, null, 2)}\n`)

  const files = [names.base, names.top, names.json].map(name => ({ name, bytes: fs.statSync(path.join(stagingDir, name)).size }))
  let copiedTo: string | null = null
  if (req.destDir.trim()) {
    const dest = req.destDir.trim()
    if (!path.isAbsolute(dest)) throw new Error('The game folder must be a full path starting with "/".')
    fs.mkdirSync(dest, { recursive: true })
    for (const { name } of files) fs.copyFileSync(path.join(stagingDir, name), path.join(dest, name))
    copiedTo = dest
  }
  return { song, files, stagingDir, copiedTo, notes }
}
