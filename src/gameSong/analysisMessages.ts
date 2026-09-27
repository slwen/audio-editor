import type { GameSongAnalysis, LoopSuggestion } from './analyze'
import type { RatedJoin } from './ratings'

export type AnalysisRequest =
  | { kind: 'analyze'; id: number; base: Float32Array; top: Float32Array; sampleRate: number; priors: RatedJoin[] }
  | { kind: 'rank'; id: number; priors: RatedJoin[] }
  | { kind: 'score'; id: number; exitSec: number; entrySec: number; fadeSec: number }

export type AnalysisResponse =
  | { kind: 'analyzed'; id: number; analysis: GameSongAnalysis; suggestions: LoopSuggestion[] }
  | { kind: 'ranked'; id: number; suggestions: LoopSuggestion[] }
  | { kind: 'scored'; id: number; pGood: number }
  | { kind: 'error'; id: number; error: string }
