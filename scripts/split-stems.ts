/**
 * Split a song into a drums+bass base layer and an everything-else top layer.
 * Run: npm run split-stems -- sample_songs/<song>.mp3
 * Writes analysis/<song>.layers/base.wav and top.wav, 48 kHz stereo, the same
 * length as the original. Requires ffmpeg and Demucs in ~/.cache/audio-editor-demucs.
 * The Game song screen runs the same split from the dev server.
 */
import path from 'node:path'
import { splitStems } from '../server/stems.ts'

export async function main(args: string[]) {
  const file = args[0]
  if (!file) throw new Error('Usage: npm run split-stems -- sample_songs/<song>.mp3')
  const baseName = path.basename(file).replace(/\.[^.]+$/, '')
  let shown = -1
  const summary = await splitStems(path.resolve(file), path.resolve('analysis', `${baseName}.layers`), p => {
    const pct = Math.round(p.progress * 100)
    if (pct !== shown) { shown = pct; console.log(`${pct}% ${p.message}`) }
  })
  console.log(summary)
}
