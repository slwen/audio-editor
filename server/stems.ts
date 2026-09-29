/**
 * Split a song with local Demucs (htdemucs) into either the existing base/top pair or
 * four editor stems. Outputs are 48 kHz stereo float and match the source length.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStereo, run, STEM_SAMPLE_RATE, writeStereoWav } from './ffmpeg.ts'

const DEMUCS_BIN = path.join(os.homedir(), '.cache', 'audio-editor-demucs', 'bin', 'demucs')
export const DEMUCS_INSTALL = 'python3 -m venv ~/.cache/audio-editor-demucs && ~/.cache/audio-editor-demucs/bin/python -m pip install -U demucs numpy'

export const demucsInstalled = () => fs.existsSync(DEMUCS_BIN)

export const stemFiles = (outDir: string) => ({ base: path.join(outDir, 'base.wav'), top: path.join(outDir, 'top.wav') })
export const EDITOR_STEMS = ['drums', 'bass', 'other', 'vocals'] as const
export type EditorStem = typeof EDITOR_STEMS[number]
export type StemLayout = 'two' | 'four'
export type StemQuality = 'standard' | 'high'
export const editorStemNames = (layout: StemLayout): readonly string[] =>
  layout === 'two' ? ['base', 'top'] : EDITOR_STEMS

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
export async function splitStems(
  song: string,
  outDir: string,
  onProgress: (p: SplitProgress) => void = () => {},
  layout: StemLayout = 'two',
  quality: StemQuality = 'standard'
): Promise<string> {
  if (!demucsInstalled()) throw new Error(`Demucs is not installed (${DEMUCS_BIN}). Install it with:\n${DEMUCS_INSTALL}`)
  const started = Date.now()
  const separated = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-editor-demucs-'))
  try {
    const model = quality === 'high' ? 'htdemucs_ft' : 'htdemucs'
    const modelArgs = quality === 'high' ? ['--shifts', '2'] : []
    onProgress({ progress: 0, message: `Separating with ${model}` })
    // none: the default rescale turns a stem down when it peaks over full scale, so the sum would no longer match the song.
    await run(DEMUCS_BIN, ['-n', model, ...modelArgs, '-o', separated, '--float32', '--clip-mode', 'none', song], text => {
      const matches = [...text.matchAll(/(\d{1,3})%\|/g)]
      const last = matches.at(-1)
      // The fine-tuned model is a four-model ensemble with a separate progress bar for each pass.
      // Its percentage cannot be treated as the overall job percentage.
      if (last && quality === 'standard') onProgress({ progress: Math.min(1, Number(last[1]) / 100) * 0.9, message: `Separating with ${model}` })
    })
    onProgress({ progress: 0.9, message: layout === 'two' ? 'Combining stems' : 'Writing stems' })
    const original = await readStereo(song)
    const frames = original[0]!.length
    const stem = (name: string) => readStereo(findStem(separated, name))
    fs.mkdirSync(outDir, { recursive: true })
    let residual: number | null = null
    if (layout === 'two') {
      // Float sum, not amix's default normalize, so a pair of stems is not halved.
      const base = fitLength(add(await stem('drums'), await stem('bass')), frames)
      const top = fitLength(add(await stem('other'), await stem('vocals')), frames)
      const files = stemFiles(outDir)
      onProgress({ progress: 0.95, message: 'Writing stems' })
      await writeStereoWav(files.base, base)
      await writeStereoWav(files.top, top)
      residual = residualDb(original, base, top)
    } else {
      for (const [index, name] of EDITOR_STEMS.entries()) {
        onProgress({ progress: 0.9 + index * 0.025, message: `Writing ${name}` })
        await writeStereoWav(path.join(outDir, `${name}.wav`), fitLength(await stem(name), frames))
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    return `${path.basename(song)}: ${frames} samples at ${STEM_SAMPLE_RATE} Hz; ${layout === 'two' ? `base + top − original is ${residual!.toFixed(1)} dB; ` : 'four stems; '}${seconds}s -> ${outDir}`
  } finally {
    fs.rmSync(separated, { recursive: true, force: true })
  }
}
