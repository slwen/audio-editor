/**
 * Play a pack through a simulated level and render what the player would hear.
 * Run: npm run simulate -- sample_songs/<song>.mp3 [--minutes 10] [--seed 1] [--urgent]
 * --urgent makes every combat request "combat now", which cuts to an entrance hit.
 * Writes analysis/<song>.sim-<seed>.wav and .sim-<seed>.json (every join with its time).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Pack } from '@/pack/pack'
import { renderSegments, stepsToSegments } from '@/pack/render'
import { randomRequests, simulatePack, summarizeSimulation } from '@/pack/simulate'
import { writeWavStereo16 } from '@/audio/wavBytes'
import { decodeStereo } from './decodeAudio.ts'
import { packPath, printReadiness } from './build-pack.ts'

function option(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}

export async function main(args: string[]) {
  const file = args.find(a => !a.startsWith('--') && !/^\d/.test(a))
  if (!file) throw new Error('Usage: npm run simulate -- sample_songs/<song>.mp3 [--minutes 10] [--seed 1]')
  const minutes = option(args, 'minutes', 10)
  const seed = option(args, 'seed', 1)
  const sourceName = path.basename(file)
  const pack: Pack = JSON.parse(fs.readFileSync(packPath(sourceName), 'utf8'))
  const requests = randomRequests(minutes * 60, seed, 'exploration', args.includes('--urgent'))
  const sim = simulatePack(pack, minutes * 60, requests)
  const summary = summarizeSimulation(pack, sim)
  const { channels, sampleRate } = decodeStereo(file)
  const rendered = renderSegments(channels, sampleRate, stepsToSegments(sim.steps))
  const base = path.join('analysis', `${sourceName.replace(/\.[^.]+$/, '')}.sim-${seed}`)
  const buffer = { numberOfChannels: rendered.length, length: rendered[0]!.length, sampleRate,
    getChannelData: (c: number) => rendered[c]! } as unknown as AudioBuffer
  fs.writeFileSync(`${base}.wav`, Buffer.from(writeWavStereo16(buffer)))
  fs.writeFileSync(`${base}.json`, JSON.stringify({ sourceName, seed, summary, requests: sim.requests, joins: sim.joins }, null, 1))
  console.log(`${sourceName} seed ${seed}: ${summary.minutes.toFixed(1)} min, ${summary.requests} feel requests`)
  printReadiness(pack)
  const { combat, exploration } = summary.latencySec
  console.log(`  switch latency: into combat median ${combat.median.toFixed(1)} s, max ${combat.max.toFixed(1)} s;`
    + ` into exploration median ${exploration.median.toFixed(1)} s, max ${exploration.max.toFixed(1)} s`
    + ` (includes ${pack.policy.releaseSec} s release)`)
  const peak = Math.max(...rendered.map(ch => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)))
  const sourcePeak = Math.max(...channels.map(ch => ch.reduce((m, v) => Math.max(m, Math.abs(v)), 0)))
  console.log(`  peak ${peak.toFixed(3)} (source ${sourcePeak.toFixed(3)})${peak > 1 ? ' - CLIPS in the WAV' : ''}`)
  console.log(`  joins: ${Object.entries(summary.joins).map(([k, v]) => `${k} ${v}`).join(', ')};`
    + ` ${summary.heardJoins} of the planned ones approved by you; lowest planned P(Good) ${summary.lowestPlannedP.toFixed(2)}`)
  console.log(`  heard: exploration ${(summary.coverage.exploration * 100).toFixed(0)}%, combat ${(summary.coverage.combat * 100).toFixed(0)}%`
    + ` of source beats; longest stretch without repeating ${summary.longestFreshSec.toFixed(0)} s`)
  const long = summary.periods.filter(p => p.lengthSec >= 45)
  console.log(`  sustained periods of 45 s or more (length / time before repeating itself): ${long.length
    ? long.map(p => `${p.feel[0]!.toUpperCase()} ${p.lengthSec.toFixed(0)}/${p.freshSec.toFixed(0)}`).join(', ') : 'none'}`)
  console.log(`  -> ${base}.wav, ${base}.json`)
}
