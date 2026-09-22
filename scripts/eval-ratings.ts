/**
 * Offline eval: score rated loops with the current detector and report
 * how well scores separate good vs bad. Run: npm run eval:loops
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseRatingLog, latestRatingRecords, latestRenderedRatingRecords, loopRatingKey } from '../src/loop/loopRatings.ts'
import { LOOP_ANALYSIS_VERSION } from '../src/loop/types.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectLoopCandidates,
  extractMonoForAnalysis,
  combineQuality,
  extractHopFeatures,
  scoreLoopWindow,
} from '@/loop/detectLoops'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const ratingsPath = path.join(root, 'loop-ratings.jsonl')
const audioDir = '/tmp/loop-eval'
const SOURCE_SR = Number(process.env.LOOP_SOURCE_SAMPLE_RATE ?? 48000)
if (![22050, 44100, 48000, 96000].includes(SOURCE_SR)) throw new Error('Unsupported LOOP_SOURCE_SAMPLE_RATE')
const SR = SOURCE_SR >= 40000 ? SOURCE_SR / 2 : SOURCE_SR

type Rating = {
  at: string
  sourceName: string
  startSec: number
  endSec: number
  bars: number
  seamScore: number
  contextScore: number
  homogeneityScore: number
  qualityScore: number
  bpm: number
  vibeWindowSec: number
  rating: 'good' | 'bad' | 'clear'
  note?: string
  analysisVersion?: string
}

function loadF32(name: string): Float32Array {
  const base = name.replace(/\.mp3$/i, '')
  const p = path.join(audioDir, `${base}.${SOURCE_SR}.stereo.f32`)
  fs.mkdirSync(audioDir, { recursive: true })
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(root, 'sample_songs', name), '-ac', '2', '-ar', String(SOURCE_SR), '-f', 'f32le', p])
  const buf = fs.readFileSync(p)
  const interleaved = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const channels = [new Float32Array(interleaved.length / 2), new Float32Array(interleaved.length / 2)]
  for (let i = 0; i < channels[0]!.length; i++) {
    channels[0]![i] = interleaved[i * 2]!
    channels[1]![i] = interleaved[i * 2 + 1]!
  }
  return extractMonoForAnalysis(channels, SOURCE_SR).samples
}

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, mean: 0, med: 0 }
  const a = [...xs].sort((x, y) => x - y)
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  const med = a[Math.floor((a.length - 1) / 2)]!
  return { n: a.length, mean, med }
}

function auc(goods: number[], bads: number[]): number {
  // Higher score should prefer good. Mann-Whitney.
  let wins = 0
  let total = 0
  for (const g of goods) {
    for (const b of bads) {
      total++
      if (g > b) wins++
      else if (g === b) wins += 0.5
    }
  }
  return total === 0 ? 0.5 : wins / total
}

export async function main() {
  const log = parseRatingLog(fs.readFileSync(ratingsPath, 'utf8'))
  const variants = latestRenderedRatingRecords(log)
  const musicalBlends = variants.filter(r => (r.wrapCrossfadeSec ?? 0) > 0.12)
  // The detector ranks original cuts. Longer musical renders change the audio
  // and need their own listening result rather than relabeling the raw splice.
  const all = latestRatingRecords(log.filter(r => r.rating === 'clear' || (r.wrapCrossfadeSec ?? 0) <= 0.12))
  console.log(`Musical-blend listening variants: ${musicalBlends.filter(r => r.rating === 'good').length} good / ${musicalBlends.filter(r => r.rating === 'bad').length} bad (reported separately from original-cut ranking)`)
  for (const r of musicalBlends.filter(r => r.rating)) console.log(`  ${r.sourceName} ${r.startSec.toFixed(2)}s ${r.bars}bar blend=${r.wrapCrossfadeSec?.toFixed(3)}s ${r.rating}: ${r.note ?? ''}`)
  console.log(`Decode ${SOURCE_SR} Hz stereo → shared browser preparation → ${SR} Hz analysis`)
  console.log(`${all.filter(r => r.note && r.rating !== 'good' && r.rating !== 'bad').length} note-only cuts are reported separately, not treated as listening votes.`)
  const bySong = new Map<string, Float32Array>()
  for (const name of new Set(all.map((r) => r.sourceName))) {
    bySong.set(name, loadF32(name))
  }

  type Row = Rating & {
    baseQ: number
    newSeam: number
    newCtx: number
    newHom: number
    newQ: number
    closure: number
  }
  const scored: Row[] = []

  const featureCache = new Map([...bySong].map(([name, samples]) => [name, extractHopFeatures(samples, SR)]))
  for (const r of all) {
    const samples = bySong.get(r.sourceName)!
    const s = r.startSec
    const e = r.endSec
    const { frames, hopSec } = featureCache.get(r.sourceName)!
    const sc = scoreLoopWindow(samples, SR, s, e, r.bpm, frames, hopSec, r.vibeWindowSec)
    const row = {
      ...r,
      baseQ: combineQuality(sc.seamScore, sc.contextScore, sc.homogeneityScore),
      newSeam: sc.seamScore,
      newCtx: sc.contextScore,
      newHom: sc.homogeneityScore,
      newQ: sc.qualityScore,
      closure: sc.closureScore,
    }
    if (r.rating === 'good' || r.rating === 'bad') scored.push(row as Row)
    else if (r.note) console.log(`Note only: ${r.sourceName} ${r.startSec.toFixed(2)}s ${r.bars}bar Q=${sc.qualityScore.toFixed(3)}: ${r.note}`)
  }

  if (process.env.LOOP_EVAL_JSON) fs.writeFileSync(process.env.LOOP_EVAL_JSON, JSON.stringify(scored, null, 2))
  const top = [...scored].sort((a, b) => b.newQ - a.newQ).slice(0, 20)
  const oldTop = [...scored].sort((a, b) => b.baseQ - a.baseQ).slice(0, 20)
  console.log(`Before closure scoring, top 20: ${oldTop.filter(r => r.rating === 'good').length} good / ${oldTop.filter(r => r.rating === 'bad').length} bad`)
  console.log(`Top 20 rated cuts: ${top.filter(r => r.rating === 'good').length} good / ${top.filter(r => r.rating === 'bad').length} bad`)
  console.log('Listener notes (exact original cuts):')
  for (const row of scored.filter(r => r.note)) console.log(`  ${row.sourceName} ${row.startSec.toFixed(2)}s ${row.bars}bar ${row.rating} Q=${row.newQ.toFixed(3)}: ${row.note}`)
  const currentVersion = scored.filter(r => r.analysisVersion === LOOP_ANALYSIS_VERSION)
  if (!process.env.LOOP_DETECTOR_FILE && currentVersion.length) {
    const maxDelta = Math.max(...currentVersion.map(r => Math.abs(r.newQ - r.qualityScore)))
    console.log(`Current-version score reproduction: n=${currentVersion.length}, largest UI/evaluator delta=${maxDelta.toFixed(6)}`)
  }
  const goods = scored.filter((r) => r.rating === 'good')
  const bads = scored.filter((r) => r.rating === 'bad')
  console.log(`Rated loops: ${scored.length} (good=${goods.length} bad=${bads.length})\n`)

  for (const key of ['baseQ', 'closure', 'newQ', 'newCtx', 'newSeam', 'newHom', 'qualityScore', 'contextScore'] as const) {
    const g = goods.map((r) => r[key])
    const b = bads.map((r) => r[key])
    const gs = stats(g)
    const bs = stats(b)
    console.log(
      `${key.padEnd(14)} good μ=${gs.mean.toFixed(3)} med=${gs.med.toFixed(3)} | bad μ=${bs.mean.toFixed(3)} med=${bs.med.toFixed(3)} | AUC=${auc(g, b).toFixed(3)}`
    )
  }

  for (const name of bySong.keys()) {
    const rows = scored.filter(r => r.sourceName === name)
    console.log(`${name}: base AUC=${auc(rows.filter(r => r.rating === 'good').map(r => r.baseQ), rows.filter(r => r.rating === 'bad').map(r => r.baseQ)).toFixed(3)} → AUC=${auc(rows.filter(r => r.rating === 'good').map(r => r.newQ), rows.filter(r => r.rating === 'bad').map(r => r.newQ)).toFixed(3)}`)
  }

  // Short motifs must not mask a regression on the game beds we actually need.
  console.log('\nLength and recent-listening checks (same development set):')
  const groups = [
    ...[4, 8, 16].map(bars => ({ label: `${bars}-bar beds`, rows: scored.filter(r => r.bars === bars) })),
    { label: `Latest version (${LOOP_ANALYSIS_VERSION})`, rows: currentVersion },
    { label: 'Musical/background mismatch notes', rows: scored.filter(r => /vibe|background|musical|seams? (?:dont|don.t) match/i.test(r.note ?? '')) },
  ]
  for (const { label, rows } of groups) {
    const good = rows.filter(r => r.rating === 'good')
    const bad = rows.filter(r => r.rating === 'bad')
    const rank = good.length && bad.length ? auc(good.map(r => r.newQ), bad.map(r => r.newQ)).toFixed(3) : 'n/a'
    console.log(`  ${label}: ${good.length} good / ${bad.length} bad, AUC=${rank}`)
  }

  // Best threshold for newQ maximizing F1 if good is positive
  const allQ = scored.map((r) => r.newQ).sort((a, b) => a - b)
  let best = { t: 0, f1: 0, prec: 0, rec: 0, keptGood: 0, keptBad: 0 }
  for (const t of allQ) {
    const predGood = scored.filter((r) => r.newQ >= t)
    const tp = predGood.filter((r) => r.rating === 'good').length
    const fp = predGood.filter((r) => r.rating === 'bad').length
    const fn = goods.length - tp
    const prec = tp / Math.max(1, tp + fp)
    const rec = tp / Math.max(1, tp + fn)
    const f1 = (2 * prec * rec) / Math.max(1e-9, prec + rec)
    if (f1 > best.f1) best = { t, f1, prec, rec, keptGood: tp, keptBad: fp }
  }
  console.log(
    `\nDescriptive threshold on this same dataset (not held-out validation): best newQ threshold t=${best.t.toFixed(3)} F1=${best.f1.toFixed(3)} P=${best.prec.toFixed(3)} R=${best.rec.toFixed(3)} keep good=${best.keptGood} bad=${best.keptBad}`
  )

  console.log('\n=== Per song detection run (default vibe 1.5) ===')
  for (const [name, samples] of bySong) {
    const t0 = Date.now()
    const result = detectLoopCandidates({ samples, sampleRate: SR, vibeWindowSec: 1.5 })
    const ms = Date.now() - t0
    console.log(`  lengths: ${[1, 2, 4, 8, 16].map(b => `${b}bar=${result.candidates.filter(c => c.bars === b).length}`).join(" ")}`)
    const songRated = scored.filter((r) => r.sourceName === name)
    // Match the same source/cut identity used by the UI. Never borrow a nearby label.
    let hitGood = 0
    let hitBad = 0
    for (const c of result.candidates) {
      const match = songRated.find(
        (r) =>
          loopRatingKey(r) === loopRatingKey({ sourceName: name, ...c })
      )
      if (!match) continue
      if (match.rating === 'good') hitGood++
      else hitBad++
    }
    const q = result.candidates.map((c) => c.qualityScore)
    console.log(
      `${name.slice(0, 28).padEnd(28)} n=${String(result.candidates.length).padStart(2)} bpm=${result.bpm.toFixed(1)} topQ=${(q[0] ?? 0).toFixed(3)} bars=[${[...new Set(result.candidates.map((c) => c.bars))].sort((a, b) => a - b)}] ratedGood=${hitGood} ratedBad=${hitBad} unrated=${result.candidates.length - hitGood - hitBad} ${ms}ms`
    )
  }
}
