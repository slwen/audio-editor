import type { JumpContext } from '@/pack/jumpFeatures'
import { analyzeGameSong, rankSuggestions, wrapPGood, type GameSongAnalysis } from './analyze'
import type { AnalysisRequest, AnalysisResponse } from './analysisMessages'
import type { RatedJoin } from './ratings'

/** Ranking always assumes a real blend; the chosen blend only changes the score of the current wrap. */
const RANK_FADE_SEC = 1

let song: { analysis: GameSongAnalysis; ctx: JumpContext } | null = null

function rank(priors: RatedJoin[]) {
  if (!song) throw new Error('No song analysed yet')
  const { analysis, ctx } = song
  return rankSuggestions({ bars: analysis.bars, beatsSec: analysis.beatsSec, priors,
    pGood: (exitSec, entrySec) => wrapPGood(ctx, exitSec, entrySec, RANK_FADE_SEC) })
}

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const request = e.data
  const reply = (msg: AnalysisResponse) => self.postMessage(msg)
  try {
    switch (request.kind) {
      case 'analyze': {
        song = analyzeGameSong(request.base, request.top, request.sampleRate)
        reply({ kind: 'analyzed', id: request.id, analysis: song.analysis, suggestions: rank(request.priors) })
        return
      }
      case 'rank':
        reply({ kind: 'ranked', id: request.id, suggestions: rank(request.priors) })
        return
      case 'score': {
        if (!song) throw new Error('No song analysed yet')
        reply({ kind: 'scored', id: request.id, pGood: wrapPGood(song.ctx, request.exitSec, request.entrySec, request.fadeSec) })
        return
      }
      default: {
        const unexpected: never = request
        throw new Error(`Unknown request ${JSON.stringify(unexpected)}`)
      }
    }
  } catch (err) {
    reply({ kind: 'error', id: request.id, error: err instanceof Error ? err.message : 'Analysis failed' })
  }
}
