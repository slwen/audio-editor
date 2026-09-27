/**
 * Split a song into a drums+bass base layer and an everything-else top layer with local Demucs (htdemucs).
 * Writes <outDir>/base.wav and top.wav, 48 kHz stereo float, the same length as the original.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStereo, run, STEM_SAMPLE_RATE, writeStereoWav } from './ffmpeg.ts'

const DEMUCS_BIN = path.join(os.homedir(), '.cache', 'audio-editor-demucs', 'bin', 'demucs')
export const DEMUCS_INSTALL = 'python3 -m venv ~/.cache/audio-editor-demucs && ~/.cache/audio-editor-demucs/bin/python -m pip install -U demucs numpy'

export const demucsInstalled = () => fs.existsSync(DEMUCS_BIN)

export const stemFiles = (outDir: string) => ({ base: path.join(outDir, 'base.wav'), top: path.join(outDir, 'top.wav') })

/** Stems exist and are newer than the song they came from. */
export function stemsReady(song: string, outDir: string): boolean {
  const { base, top } = stemFiles(outDir)
  if (!fs.existsSync(base) || !fs.existsSync(top)) return false
  if (!fs.existsSync(song)) return true
  const songTime = fs.statSync(song).mtimeMs
  return fs.statSync(base).mtimeMs >= songTime && fs.statSync(top).mtimeMs >= songTime
}

/** Loop times belong to the original, so a shorter or longer stem is padded or trimmed to that length. */
function fitLength(channels: Float32Array[], frames: number): Float32Array[] {
  return channels.map(channel => {
    if (channel.length === frames) return channel
    const fitted = new Float32Array(frames)
    fitted.set(channel.subarray(0, frames))
    return fitted
  })
}

function add(a: Float32Array[], b: Float32Array[]): Float32Array[] {
  const frames = Math.max(a[0]!.length, b[0]!.length)
  return [0, 1].map(c => {
    const sum = new Float32Array(frames)
    for (let i = 0; i < frames; i++) sum[i] = (a[c]![i] ?? 0) + (b[c]![i] ?? 0)
    return sum
  })
}

function findStem(root: string, name: string): string {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === `${name}.wav`) hits.push(full)
    }
  }
  walk(root)
  if (hits.length !== 1) throw new Error(`Expected one ${name}.wav from Demucs under ${root}, found ${hits.length}`)
  return hits[0]!
}

/** dB RMS of (base + top − original), relative to the original. */
function residualDb(original: Float32Array[], base: Float32Array[], top: Float32Array[]): number {
  let diff = 0
  let ref = 0
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < original[c]!.length; i++) {
      const d = base[c]![i]! + top[c]![i]! - original[c]![i]!
      diff += d * d
      ref += original[c]![i]! ** 2
    }
  }
  return 10 * Math.log10(diff / (ref || 1) + 1e-12)
}

export type SplitProgress = { progress: number; message: string }

/** Returns a one-line summary. `onProgress` gets 0..1 while Demucs runs, then the post-processing steps. */
export async function splitStems(song: string, outDir: string, onProgress: (p: SplitProgress) => void = () => {}): Promise<string> {
  if (!demucsInstalled()) throw new Error(`Demucs is not installed (${DEMUCS_BIN}). Install it with:\n${DEMUCS_INSTALL}`)
  const started = Date.now()
  const separated = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-editor-demucs-'))
  try {
    onProgress({ progress: 0, message: 'Separating drums and bass from the rest' })
    // none: the default rescale turns a stem down when it peaks over full scale, so the sum would no longer match the song.
    await run(DEMUCS_BIN, ['-n', 'htdemucs', '-o', separated, '--float32', '--clip-mode', 'none', song], text => {
      const matches = [...text.matchAll(/(\d{1,3})%\|/g)]
      const last = matches.at(-1)
      if (last) onProgress({ progress: Math.min(1, Number(last[1]) / 100) * 0.9, message: 'Separating drums and bass from the rest' })
    })
    onProgress({ progress: 0.9, message: 'Combining stems' })
    const original = await readStereo(song)
    const frames = original[0]!.length
    // Float sum, not amix's default normalize, so a pair of stems is not halved.
    const stem = (name: string) => readStereo(findStem(separated, name))
    const base = fitLength(add(await stem('drums'), await stem('bass')), frames)
    const top = fitLength(add(await stem('other'), await stem('vocals')), frames)
    fs.mkdirSync(outDir, { recursive: true })
    const files = stemFiles(outDir)
    onProgress({ progress: 0.95, message: 'Writing stems' })
    await writeStereoWav(files.base, base)
    await writeStereoWav(files.top, top)
    const residual = residualDb(original, base, top)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    return `${path.basename(song)}: ${frames} samples at ${STEM_SAMPLE_RATE} Hz; base + top − original is ${residual.toFixed(1)} dB; ${seconds}s -> ${outDir}`
  } finally {
    fs.rmSync(separated, { recursive: true, force: true })
  }
}
