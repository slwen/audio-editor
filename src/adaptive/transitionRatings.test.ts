import { afterEach, expect, it, vi } from 'vitest'
import { browserTransitionRecords, mergeTransitionReviews, parseTransitionRatings, syncTransitionRecords, transitionRecordKey } from './transitionRatings'
import type { TransitionRatingRecord } from './transitionRatings'
import type { TransitionReview } from './model'

const review = { id: 'transition-1', at: '2026-09-22T10:00:00Z', from: 'combat', to: 'intensity',
  fromLoop: { key: 'a', candidate: { startSec: 10, endSec: 20 } },
  toLoop: { key: 'b', candidate: { startSec: 40, endSec: 50 } }, settings: {},
  exitOffsetSec: 2, fadeSec: 0.2, rating: 'bad', note: 'abrupt' } as TransitionReview
const key = 'adaptive-music-v1:song:with-colon.mp3:10000:48000'
const record: TransitionRatingRecord = { version: 1, sourceName: 'song:with-colon.mp3', sourceKey: key, review }
function storage() {
  const values = new Map([[key, JSON.stringify({ reviews: [review] })], ['adaptive-music-v1:broken', '{'], ['unrelated', '{}']])
  return { length: values.size, key: (i: number) => [...values.keys()][i], getItem: (k: string) => values.get(k) } as Storage
}
afterEach(() => vi.unstubAllGlobals())
it('migrates old browser feedback for all songs and retains source names with colons', () => {
  expect(browserTransitionRecords(storage())).toEqual([record])
  expect(parseTransitionRatings(`${JSON.stringify(record)}\n{partial\n{}\n`)).toEqual([record])
})
it('keeps the newest decision even if stale browser feedback is appended later', () => {
  const edited = { ...review, updatedAt: '2026-09-22T11:00:00Z', rating: 'good' as const, note: 'fixed' }
  expect(mergeTransitionReviews([edited], [review])).toEqual([edited])
  expect(transitionRecordKey(record)).not.toBe(transitionRecordKey({ ...record, review: edited }))
})
it('does not repost reviews already persisted, including repeat migrations', async () => {
  const request = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(record), { headers: { 'content-type': 'application/x-ndjson' } })))
  vi.stubGlobal('fetch', request)
  await syncTransitionRecords(storage())
  await syncTransitionRecords(storage())
  expect(request.mock.calls.every(call => call[1].method !== 'POST')).toBe(true)
})
it('keeps browser feedback available after a failed save and retries the same record', async () => {
  const request = vi.fn().mockImplementation((_url, opts) => Promise.resolve(opts.method === 'POST'
    ? new Response('', { status: 500 }) : new Response('', { headers: { 'content-type': 'application/x-ndjson' } })))
  vi.stubGlobal('fetch', request)
  const local = storage()
  await expect(syncTransitionRecords(local)).rejects.toThrow()
  expect(browserTransitionRecords(local)).toEqual([record])
  request.mockImplementation((_url, opts) => Promise.resolve(opts.method === 'POST'
    ? new Response('ok') : new Response('', { headers: { 'content-type': 'application/x-ndjson' } })))
  expect(await syncTransitionRecords(local)).toEqual([record])
})
