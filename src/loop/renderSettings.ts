import { loopRatingKey } from './loopRatings'
import type { LoopCandidate, LoopSession } from './types'
import type { LoopRenderOptions } from './wrapLoop'

export const DEFAULT_LOOP_RENDER: LoopRenderOptions = { wrapCrossfadeSec: 0.035, normalize: false }

/** One cut's audition settings follow it into ratings, WAVs and timeline copies. */
export function loopRenderOptions(
  session: Pick<LoopSession, 'sourceName' | 'renderOverrides'>,
  candidate: LoopCandidate
): LoopRenderOptions {
  return session.renderOverrides[loopRatingKey({ sourceName: session.sourceName, ...candidate })]
    ?? candidate.savedRender ?? DEFAULT_LOOP_RENDER
}
