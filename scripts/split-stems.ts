/**
 * Split a song into a drums+bass base layer and an everything-else top layer.
 * Run: npm run split-stems -- sample_songs/<song>.mp3
 * Writes analysis/<song>.layers/base.wav and top.wav, 48 kHz stereo, the same
 * length as the original. Requires ffmpeg and Demucs in ~/.cache/audio-editor-demucs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { decodeStereo, SOURCE_SAMPLE_RATE } from './decodeAudio.ts'

const DEMUCS_BIN = path.join(os.homedir(), '.cache', 'audio-editor-demucs', 'bin', 'demucs')
const INSTALL = 'python3 -m venv ~/.cache/audio-editor-demucs && ~/.cache/audio-editor-demucs/bin/python -m pip install -U demucs numpy'

function readStereo(file: string): Float32Array[] {
  const pcm = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-ac', '2', '-ar', String(SOURCE_SAMPLE_RATE), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 })
  const interleaved = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4)
  const frames = interleaved.length / 2
  const channels = [new Float32Array(frames), new Float32Array(frames)]
  for (let i = 0; i < frames; i++) {
    channels[0]![i] = interleaved[i * 2]!
    channels[1]![i] = interleaved[i * 2 + 1]!
  }
  return channels
}

function writeStereo(file: string, channels: Float32Array[]) {
  const frames = channels[0]!.length
  const interleaved = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    interleaved[i * 2] = channels[0]![i]!
    interleaved[i * 2 + 1] = channels[1]![i]!
  }
  const raw = `${file}.f32`
  fs.writeFileSync(raw, Buffer.from(interleaved.buffer))
  try {
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'f32le', '-ar', String(SOURCE_SAMPLE_RATE), '-ac', '2', '-i', raw,
      '-c:a', 'pcm_f32le', file,
    ])
  } finally {
    fs.rmSync(raw, { force: true })
  }
}

/** Jump times belong to the original, so a shorter or longer stem is padded or trimmed to that length. */
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
  const out = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < 2; c++) {
    const left = a[c]!
    const right = b[c]!
    const sum = out[c]!
    for (let i = 0; i < frames; i++) sum[i] = (left[i] ?? 0) + (right[i] ?? 0)
  }
  return out
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

function rms(channels: Float32Array[]): number {
  let energy = 0
  let count = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i]!
      energy += sample * sample
      count++
    }
  }
  return Math.sqrt(energy / count)
}

/** dB RMS of (base + top − original), relative to the original. Summing keeps each stem's level. */
function residualDb(original: Float32Array[], base: Float32Array[], top: Float32Array[]): number {
  let energy = 0
  let count = 0
  for (let c = 0; c < 2; c++) {
    const mix = original[c]!
    const low = base[c]!
    const high = top[c]!
    for (let i = 0; i < mix.length; i++) {
      const diff = (low[i] ?? 0) + (high[i] ?? 0) - mix[i]!
      energy += diff * diff
      count++
    }
  }
  return 20 * Math.log10(Math.sqrt(energy / count) / rms(original))
}

export async function main(args: string[]) {
  const file = args[0]
  if (!file) throw new Error('Usage: npm run split-stems -- sample_songs/<song>.mp3')
  if (!fs.existsSync(DEMUCS_BIN)) {
    throw new Error(`Demucs is not installed (${DEMUCS_BIN}). Install it with:\n${INSTALL}`)
  }
  const song = path.resolve(file)
  const baseName = path.basename(song).replace(/\.[^.]+$/, '')
  const started = Date.now()
  const separated = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-editor-demucs-'))
  try {
    // none: the default rescale turns a stem down when it peaks over full scale, so the sum would no longer match the song.
    execFileSync(DEMUCS_BIN, [
      '-n', 'htdemucs', '-o', separated, '--float32', '--clip-mode', 'none', song,
    ], { stdio: 'inherit' })
    const original = decodeStereo(song)
    const frames = original.channels[0]!.length
    // Float sum, not amix's default normalize, so a pair of stems is not halved.
    const base = fitLength(add(readStereo(findStem(separated, 'drums')), readStereo(findStem(separated, 'bass'))), frames)
    const top = fitLength(add(readStereo(findStem(separated, 'other')), readStereo(findStem(separated, 'vocals'))), frames)
    const outDir = path.join('analysis', `${baseName}.layers`)
    fs.mkdirSync(outDir, { recursive: true })
    const baseWav = path.join(outDir, 'base.wav')
    const topWav = path.join(outDir, 'top.wav')
    writeStereo(baseWav, base)
    writeStereo(topWav, top)
    const baseLen = readStereo(baseWav)[0]!.length
    const topLen = readStereo(topWav)[0]!.length
    const residual = residualDb(original.channels, base, top)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`${baseName}: original ${frames} samples, base ${baseLen}, top ${topLen} (${SOURCE_SAMPLE_RATE} Hz stereo)`)
    console.log(`null test: base + top − original is ${residual.toFixed(1)} dB RMS relative to the original`)
    console.log(`htdemucs in ${seconds}s -> ${outDir}`)
  } finally {
    fs.rmSync(separated, { recursive: true, force: true })
  }
}
