import { create } from 'zustand'
import { DEFAULT_MUSIC_SETTINGS, type MusicSettings, type MusicSlots, type MusicState, type TransitionReview, type TransitionRules, type MusicSlot } from './model'
import { STOPPED_MUSIC, type MusicPlayback } from './AdaptivePlayer'
import type { ZoneFlag } from './zonePlan'

type AdaptiveState = {
  open: boolean; storageKey: string; slots: MusicSlots; settings: MusicSettings
  playback: MusicPlayback; reviews: TransitionReview[]; error: string; starting: boolean
  initialState: MusicState
  ratingSync: 'idle' | 'saving' | 'saved' | 'error'
  rules: TransitionRules
  zoneFlags: ZoneFlag[]
  zoneDraft: boolean
  audition: { slot: MusicSlot; mode: 'loop' | 'song'; sourceTime: number } | null
}
export const useAdaptiveStore = create<AdaptiveState>(() => ({
  open: false, storageKey: '', slots: {}, settings: DEFAULT_MUSIC_SETTINGS,
  playback: STOPPED_MUSIC, reviews: [], error: '', starting: false, initialState: 'exploration',
  ratingSync: 'idle',
  rules: {},
  zoneFlags: [], zoneDraft: false,
  audition: null,
}))

export function saveAdaptive(): void {
  const { storageKey, slots, settings, reviews, initialState, rules, zoneFlags, zoneDraft } = useAdaptiveStore.getState()
  try { localStorage.setItem(storageKey, JSON.stringify({ slots, settings, reviews, initialState, rules, zoneFlags, zoneDraft })) }
  catch { useAdaptiveStore.setState({ error: 'Could not save this setup in the browser. Export a pack to keep a copy.' }) }
}
