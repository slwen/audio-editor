import fs from 'node:fs'
import { spawn } from 'node:child_process'

export const STEM_SAMPLE_RATE = 48000

/** Runs a command and collects its output; rejects with the tail of stderr on failure. */
export function run(cmd: string, args: string[], onStderr?: (text: string) => void): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-200_000)
      onStderr?.(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr })
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().split('\n').slice(-5).join('\n')}`))
    })
  })
}

function toFloat32(pcm: Buffer): Float32Array {
  // Copy: Buffer pooling can leave byteOffset unaligned for Float32Array.
  const bytes = new Uint8Array(pcm.byteLength)
  bytes.set(pcm)
  return new Float32Array(bytes.buffer)
}

export async function readStereo(file: string, sampleRate = STEM_SAMPLE_RATE): Promise<Float32Array[]> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', '-'])
  const interleaved = toFloat32(stdout)
  const frames = interleaved.length / 2
  const channels = [new Float32Array(frames), new Float32Array(frames)]
  for (let i = 0; i < frames; i++) {
    channels[0]![i] = interleaved[i * 2]!
    channels[1]![i] = interleaved[i * 2 + 1]!
  }
  return channels
}

export async function readMono(file: string, sampleRate = STEM_SAMPLE_RATE): Promise<Float32Array> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'])
  return toFloat32(stdout)
}

export async function writeStereoWav(file: string, channels: Float32Array[], sampleRate = STEM_SAMPLE_RATE): Promise<void> {
  const frames = channels[0]!.length
  const interleaved = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    interleaved[i * 2] = channels[0]![i]!
    interleaved[i * 2 + 1] = channels[1]![i]!
  }
  const raw = `${file}.f32`
  fs.writeFileSync(raw, Buffer.from(interleaved.buffer))
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', raw, '-c:a', 'pcm_f32le', file])
  } finally {
    fs.rmSync(raw, { force: true })
  }
}
