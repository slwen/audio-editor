import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { extractMonoForAnalysis } from '@/loop/detectLoops'

const SOURCE_SAMPLE_RATE = Number(process.env.LOOP_SOURCE_SAMPLE_RATE ?? 48000)

/** Same preparation as the browser: stereo decode, downmix, and analysis-rate decimation. Requires ffmpeg. */
export function decodeForAnalysis(file: string): { samples: Float32Array; sampleRate: number } {
  return extractMonoForAnalysis(decodeStereo(file).channels, SOURCE_SAMPLE_RATE)
}

/** Full-rate stereo, for rendering. */
function decodeStereo(file: string): { channels: Float32Array[]; sampleRate: number } {
  const cache = path.join(os.tmpdir(), 'audio-editor-decode')
  fs.mkdirSync(cache, { recursive: true })
  const key = createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12)
  const out = path.join(cache, `${path.basename(file).replace(/\.[^.]+$/, '')}.${key}.${SOURCE_SAMPLE_RATE}.stereo.f32`)
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(file).mtimeMs) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '2', '-ar', String(SOURCE_SAMPLE_RATE), '-f', 'f32le', out])
  }
  const buf = fs.readFileSync(out)
  const interleaved = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const channels = [new Float32Array(interleaved.length / 2), new Float32Array(interleaved.length / 2)]
  for (let i = 0; i < channels[0]!.length; i++) {
    channels[0]![i] = interleaved[i * 2]!
    channels[1]![i] = interleaved[i * 2 + 1]!
  }
  return { channels, sampleRate: SOURCE_SAMPLE_RATE }
}
