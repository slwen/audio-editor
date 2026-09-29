# Audio editor performance audit — 30 September 2026

**Implementation follow-up completed.** The stressed Play interaction improved from 843 ms to 36 ms; p95 frame time improved from 433.4 ms to 16.8 ms at 4× CPU slowdown. The original audit findings below are retained as baseline evidence. Verified fixes and limitations are recorded at the end.

The app loads quickly and stays visually stable. Its serious performance problems occur during editing and exporting: a four-minute MP3 export blocked the production UI for 7.225 seconds, and 16 timeline clips at maximum zoom produced a measured 843 ms interaction latency under 4× CPU throttling.

## Scope and measurement conditions

- All five web-perf phases completed: traces, Core Web Vitals, network requests and headers, accessibility snapshots, and source/build analysis.
- Chrome DevTools MCP 1.10.1, isolated headless Chrome 154 on this Mac. The existing shared browser was left running; the audit used its own browser profile.
- Production build: React 19.2.5, Vite 8.0.16 / Rolldown 1.0.3, Zustand 5.0.12. The build passed. Source baseline: commit 2fed702 plus the pre-existing edits in scripts/decodeAudio.ts and src/pack/songMap.ts and its test.
- Development app at http://localhost:5174 for server-backed Game Song and Find loops workflows. Production preview at http://127.0.0.1:5274 for load, playback, stress interaction, and actual selected-clip export.
- Desktop: 1440×900, DPR 1, no network throttling. Mobile: 390×844, DPR 1, Slow 4G, 4× CPU slowdown. Cache was explicitly bypassed for the reported cold-load traces; the earlier warm measurements are supplementary.
- Song fixture: cathedral-of-iron.mp3, 241.68 seconds, 48 kHz stereo after decoding, 11,600,640 samples per channel. The 16-clip stress fixture contains sequential duplicates sharing one decoded source; 15 clips are offscreen.
- These are local lab observations, not field percentiles or a claim that the app passes Core Web Vitals for all users. No CrUX data exists for this local app. Runtime windows were approximately three seconds and are descriptive samples. CPU throttling simulates a slower CPU; it does not simulate a particular phone or memory limit.
- Canvas drawing hooks were used to count waveform work. The reported stress frame intervals were repeated after a full reload with those hooks disabled. The 843 ms interaction came from a real DevTools Play-button click, not a programmatically dispatched click.

## Core Web Vitals and load summary

The companion canvas contains the metric table and workload comparison.

- Desktop cold LCP: 79 ms — good. FCP: 80 ms from the browser performance timeline. TTFB: approximately 3 ms. CLS: 0.00.
- Mobile cold LCP: 2,149 ms — good. FCP: 2,132 ms — needs improvement under the skill's FCP guide. CLS: 0.00. DevTools LCP breakdown reports about 2 ms TTFB; separately, the network chain reports a 588 ms document request under emulation. Those differently defined timings should not be treated as an observed production-backend response time.
- Stress interaction INP: 843 ms — poor, measured with 16 clips, maximum 500 px/s zoom, 4× CPU slowdown. Breakdown: 3 ms input delay, 282 ms processing, 558 ms presentation delay.
- No main-thread task longer than 50 ms occurred after FCP in either empty-project cold-load trace. Observed post-FCP blocking time was 0 ms. This is a trace-window TBT proxy, not Lighthouse's formal FCP-to-TTI TBT calculation.
- Speed Index and a Lighthouse performance score were not collected. The installed MCP Lighthouse tool excludes performance. Automated accessibility scored 100 on the empty mobile editor and the loaded desktop Game Song screen.
- The earlier warm desktop trace measured 309 ms LCP; the development trace measured 377 ms. Differences between isolated runs include initialization, scheduling, and tracing overhead; the audit does not claim cold cache makes the app intrinsically faster.

Thresholds were checked against [web.dev Web Vitals](https://web.dev/articles/vitals). Good LCP is at most 2.5 seconds, INP at most 200 ms, and CLS at most 0.1. Site-level assessment uses field measurements at the 75th percentile; these single-session lab measurements do not establish that assessment.

## 1. High impact: move MP3 encoding off the UI thread

**Evidence.** A real production Export 1 selected action, using the four-minute song, caused a 7,225.42 ms main-thread RunTask and a 7,199.7 ms animation-frame gap. Calling the same encoder directly in the development app took 6,098.4 ms. The production export trace is the stronger evidence because it exercises the actual UI flow.

**Cause.** [encodeMp3.ts](/Users/samenoka/projects/audio-editor/src/audio/encodeMp3.ts:16) converts whole channels to Int16Array, then synchronously encodes every 1,152-sample frame. [exportWav.ts](/Users/samenoka/projects/audio-editor/src/audio/exportWav.ts:14) invokes it on the main thread after OfflineAudioContext finishes. Marking the surrounding function async does not move this synchronous work to another thread.

**Fix.** Put the encoder and PCM conversion in a module worker loaded on first export. Send owned PCM copies or bounded chunks using transferable buffers; do not detach channel data still needed for playback. Return the encoded bytes, report progress, and terminate or cancel a job when requested. Keep OfflineAudioContext rendering asynchronous and reuse the existing encoding correctness tests.

~~~typescript
// Main-thread entry point, instantiated only when exporting.
const worker = new Worker(new URL('./encodeMp3.worker.ts', import.meta.url), {
  type: 'module',
})
// Send owned channel copies in bounded chunks; the worker assembles and encodes them.
worker.postMessage({ kind: 'pcm', channel, samples: ownedChunk }, [ownedChunk.buffer])
~~~

**Impact.** Moves roughly 6–7 seconds of measured synchronous encoding off the UI thread for this fixture. This improves responsiveness, not necessarily total export duration. Frame-sized allocations also merit review: the loop copies each input subarray into another Int16Array even though the channels were already converted.

**Validation target.** Repeat the production selected export and compare encoded duration/channel content against existing expectations; keyboard and transport interaction should remain responsive throughout encoding. Measure the transfer/setup work as well as the worker.

## 2. High impact: bound timeline drawing to the viewport

**Evidence.** At default 80 px/s, one 241.68-second clip draws 19,335 waveform segments into a 1,139-pixel-wide production canvas. With 16 sequential clips, the renderer draws about 309,360 segments even though only part of the first clip is visible. Maximum zoom increases that to 1,933,440 segments per redraw.

With drawing hooks disabled, 16 clips at 4× CPU slowdown produced a frame-interval p95 of 83.3 ms at default zoom, and 433.4 ms at maximum zoom. The maximum-zoom run included 427–435 ms long tasks. Without CPU throttling, maximum zoom still produced a 116.7 ms frame-interval p95, about ten observed frames per second. A single clip at default zoom stayed near 60 fps, with 16.7 ms p95.

The stress Play interaction measured 843 ms INP; most of that was processing and presentation delay. These measurements support a real editor responsiveness problem despite the good page-load metrics.

**Cause.** [Timeline.tsx](/Users/samenoka/projects/audio-editor/src/components/Timeline.tsx:209) renders every clip and iterates through its entire duration in pixels. The draw callback depends on the playhead, so playback repeats the work. [Timeline.tsx](/Users/samenoka/projects/audio-editor/src/components/Timeline.tsx:310) also writes scrollX on every playback update, including when the computed value has not changed.

**Fix.** First cull clips outside the horizontal and vertical viewport, then restrict each waveform loop to its visible pixels. Preserve the full clip-relative fraction when looking up peaks; resetting the fraction at the viewport edge would draw the wrong audio.

~~~typescript
if (x0 >= w || x0 + cw <= 0 || y0 >= h || y0 + ch <= 0) return
const firstPixel = Math.max(0, Math.floor(-x0))
const lastPixel = Math.min(Math.ceil(cw), Math.ceil(w - x0))
for (let ix = firstPixel; ix < lastPixel; ix++) {
  const frac = cw <= 1 ? 0 : ix / (cw - 1)
  // Existing source-time, peak lookup, and fade calculation.
}
~~~

Then cache the static ruler/waveform layer and render the playhead separately. Invalidate the cache for viewport changes, clip edits, selection styling, or colors. During scrolling, redraw only what becomes visible. Only set scrollX when it changes.

**Impact.** Viewport culling reduces the maximum-zoom fixture's waveform iteration count from about 1.93 million to at most about 1,139 visible columns: over 99.9% less waveform-loop work in this specific layout. This is a calculated work bound, not a measured post-fix latency saving. Actual gains require repeating the trace after implementation.

**Validation target.** Check waveform alignment and fades while zooming, panning, trimming, dragging, and seeking; repeat native Play and pause interactions with 1, 16, and more clips. Target stable frame delivery and lab interaction latency under 200 ms in the same stress setup.

## 3. Medium impact: prevent autosave starvation and separate audio blobs

**Evidence.** With one clip playing, the production app scheduled its 500 ms save timer 363 times during a three-second sample and performed no IndexedDB write. In a separate controlled test, changing master gain during 1.6 seconds of playback scheduled 194 timers and produced zero writes; pausing then waiting 800 ms produced one write. That write serialized 5,821,836 source bytes and took about 3.4 ms synchronously in the development probe.

**Cause.** [useProjectPersistence.ts](/Users/samenoka/projects/audio-editor/src/persistence/useProjectPersistence.ts:57) subscribes to every store update, so playhead and scroll changes continually restart the debounce. Every completed save writes the complete original-byte map again through a single IndexedDB project record.

**Fix.** Subscribe to durable document fields such as clips, bufferMeta, and masterGain. Save view/transport position independently at a bounded cadence, or on pause. Add a maximum wait for pending document saves, and store immutable source blobs by bufferId only when their bytes change. A conceptual filter for the current store is:

~~~typescript
useProjectStore.subscribe((next, previous) => {
  if (next.clips === previous.clips &&
      next.bufferMeta === previous.bufferMeta &&
      next.masterGain === previous.masterGain) return
  scheduleDocumentSave(next) // debounce with a bounded maximum wait
})
~~~

**Impact.** Eliminates roughly 120 timer reschedules per second in the single-clip sample and permits edits to be saved while playback continues. Separating source blobs avoids rewriting 5.82 MB for each small settings change in this fixture. The current single-source write is only a few milliseconds; the larger concern is scaling and unbounded save delay.

## 4. Medium impact: cache and cancel stem loads

**Evidence.** Each Game Song WAV response was 92,805,212 bytes with Cache-Control: no-store. Selecting the same ready song again fetched both complete stems again: 185,610,424 body bytes, about 185.6 MB. Ready-state loading took 1,543 ms initially and 1,476 ms on the repeat, including decode and analysis. These are local-server times; large repeated transfers would matter more on a remote connection.

**Cause.** [gameSongPlugin.ts](/Users/samenoka/projects/audio-editor/server/gameSongPlugin.ts:109) explicitly disables caching. [actions.ts](/Users/samenoka/projects/audio-editor/src/gameSong/actions.ts:180) discards the current pair, fetches and decodes both stems, and only then checks its generation number. The generation check prevents stale state updates but does not abort stale fetches or decoding work.

**Fix.** Add validators based on the stem file version and support conditional responses. Use a content-versioned URL or private revalidation so regenerated stems remain correct. Keep a bounded decoded-stem/analysis cache, with an explicit byte budget rather than an unlimited map. Abort obsolete fetches with AbortController. Check generation after each await before starting additional CPU work.

**Impact.** A successfully reused decoded pair can avoid the measured 185.6 MB refetch plus much of the roughly 1.5-second reload. Server validators alone primarily reduce transfer and still leave decode/analysis costs. The two decoded stereo buffers contain about 185.6 MB of PCM, so cache eviction is essential.

## 5. Medium impact: reduce preprocessing copies before worker analysis

**Evidence.** Peak generation took 21.4–28.4 ms in three unthrottled calls and allocated a 46,402,560-byte merged Float32Array for each four-minute buffer. Analysis downmix/decimation took 54.8 ms in a separate call. A ready Game Song reload produced a 133 ms long task; entering Find loops produced a 99 ms long task before otherwise smooth frame delivery.

**Cause.** The FFT/detection work already runs in workers, but [peaks.ts](/Users/samenoka/projects/audio-editor/src/lib/peaks.ts:24) and [analysisClient.ts](/Users/samenoka/projects/audio-editor/src/gameSong/analysisClient.ts:44) prepare whole arrays on the main thread. [runDetection.ts](/Users/samenoka/projects/audio-editor/src/loop/runDetection.ts:24) additionally slices each stereo trim before downmixing and decimating it. For this full-source fixture that is approximately 92.8 MB of channel copies before the mono intermediates.

**Fix.** Fuse channel averaging directly into peak buckets to avoid the full merged array. Move downmix/decimation into worker preprocessing or prepare bounded chunks with yields. Pass only the trim range and necessary owned PCM chunks. The current code already transfers its prepared mono buffers, which is good; preserve that behavior.

**Impact.** Removes a calculated 46.4 MB temporary allocation per peak pass and reduces measured 55–133 ms startup stalls. The exact combined latency saving is unmeasured; the quoted timings come from separate probes and must not be added together as one observed task.

Find loops finished in about 1.30 seconds, produced 156 candidates, and maintained approximately 16.7 ms p95 frame intervals after preprocessing. Loaded Game Song playback stayed near 60 fps with no observed long tasks in the three-second sample. Rewriting the worker algorithms is not a priority.

## 6. Medium impact over long sessions: release unreferenced original bytes

**Evidence.** Removing the only timeline clip through removeClip left zero live clips and zero bufferMeta entries, but the original-byte map still contained the 5,821,836-byte MP3. This particular probe used removeClip directly and left no undo snapshot owning the removed source.

**Cause.** [useProjectStore.ts](/Users/samenoka/projects/audio-editor/src/store/useProjectStore.ts:257) removes decoded-buffer and peak entries but does not remove the corresponding entry from [fileBytes.ts](/Users/samenoka/projects/audio-editor/src/persistence/fileBytes.ts:4). Autosave includes all entries in that map, and restore loads the entire map again.

**Fix.** Track ownership across current clips and undo/redo snapshots. Evict original bytes, decoded buffers, and peaks only once no retained state needs them. Do not blindly remove all source bytes on delete: undo must remain able to restore playable audio. Prune unreferenced entries before persistence as well.

**Impact.** Releases 5.82 MB per deleted, unreferenced copy of this fixture and prevents those bytes from remaining in every autosave. A project file saved manually already filters to live bufferMeta; the problem is the in-memory map and autosave path.

## 7. Medium for remote/mobile load: defer the encoder and review critical CSS

The production entry is 491,882 bytes minified / 159,360 bytes gzip by the build report. Browser cold-transfer timing showed 157,990 encoded bytes for the JS and 4,396 for CSS. The small difference between build gzip and server gzip reflects compression settings. Gzip and minification are already enabled; no exposed source maps were emitted.

The MP3 codec is statically imported into the entry despite being used only during export. A separate Rolldown production minification of the codec measured 163,311 bytes minified / 56,284 bytes gzip. That suggests roughly 56 KB gzip can move to an export-only worker; it is an estimate, not an exact measured entry-bundle delta. At the observed mobile JS download rate, that payload corresponds to about 0.3 seconds of transfer, excluding protocol and parsing effects.

The single CSS file is 18,632 bytes decoded. DevTools estimated zero desktop LCP savings from its render blocking, so desktop CSS changes are low priority. Under Slow 4G, the CSS request took 619 ms and DevTools estimated 549 ms FCP/LCP savings. Treat that as a tooling estimate; the JS entry still controls React's first contentful render, so it is not a guaranteed additive improvement. After the runtime fixes, consider a small inline critical shell stylesheet and defer mode-specific rules while checking for flashes or new layout shifts.

The local preview serves assets with revalidation rather than immutable caching. That is expected preview behavior, not evidence about a deployed service. If deploying later, use long-lived immutable caching for hashed assets and revalidate HTML. This repository relies on Vite dev middleware for stems and server export, so a static production preview cannot exercise those endpoints.

## 8. Accessibility: keyboard-operable markers and a quieter live clock

Automated accessibility scored 100 in both tested states. The loaded Game Song DOM had no duplicate IDs or broken aria-labelledby/aria-describedby references. Most buttons and inputs were named, and the stylesheet has focus-visible rules.

Manual inspection found the two custom waveform sliders have tabIndex -1 and no key handlers: [GameSongWaveform.tsx](/Users/samenoka/projects/audio-editor/src/components/GameSongWaveform.tsx:98). Add tabIndex=0, Arrow/Home/End handling, and a visible focus style. Coordinate this with App's global keyboard capture so it does not consume arrow keys intended for sliders. The existing nudge buttons offer a keyboard alternative, but the sliders themselves should match the interaction implied by their ARIA role.

The transport clock is a polite live region and updates on every playback tick. Move announcements to meaningful playback/state changes or a much slower cadence to avoid overwhelming assistive technology. Audible announcement behavior was not tested with a screen reader. An automated 100 score is not a complete keyboard or assistive-technology audit.

## Build and source findings

Vite/Rolldown performs production tree shaking and minification by default in this configuration. There is no explicit tree-shaking disablement, global core-js import, lodash/moment import, CSS-in-JS runtime, remote font, image hero, or third-party request in the initial production page. The page uses system fonts and no preconnects. No recommendation to remove an allegedly unused dependency is justified by this audit.

The detector and Game Song workers are already emitted as separate 14.61 KB and 16.08 KB chunks. Editor, Find loops, and Game Song screens are eagerly imported by App, and the encoder is eager. Lazy workspace boundaries are worth considering only after measuring the bundle delta; simply adding React.lazy will be ineffective for code still reachable through shared static imports.

## Recommended implementation order

1. Fix viewport culling and isolate static waveform drawing; repeat native stress interaction traces.
2. Move MP3 encoding to a worker, including progress and cancellation; verify export correctness and UI responsiveness.
3. Filter autosave subscriptions and separate audio blobs from document metadata.
4. Add bounded stem reuse, HTTP validators, and cancellation; move/fuse preprocessing.
5. Prune source ownership safely across live and undo/redo state; add marker keyboard support and adjust clock announcements.
6. Reassess cold mobile CSS and optional workspace splitting after measuring the new build.

## Evidence and reproduction

Raw traces, full MCP insight responses, probe outputs, and both Lighthouse HTML/JSON reports are preserved in [the evidence directory](/Users/samenoka/.codex/visualizations/2026/09/29/01a0ef28-f4db-75d0-8a09-11a612b80fc8/audio-perf-audit/evidence). The structured summary is [performance-audit-2026-09-30.json](/Users/samenoka/projects/audio-editor/docs/performance-audit-2026-09-30.json).

For load reproduction: build the current worktree, run a separate preview, select the target page, apply the viewport/CPU/network settings above, start a trace without an automatic reload, reload with cache bypass, wait for the UI to paint, and stop the trace. Confirm response body bytes were transferred rather than relying on a warm 304 navigation.

For the stress case: import the fixture, duplicate the selected clip 15 times, zoom to 500 px/s with Ctrl/Command-wheel, apply 4× CPU slowdown, start a trace, and use a real Play button click. Also test the same case without slowdown. For export: export one selected four-minute clip as MP3 and inspect the longest main-thread task. For stems: select an already-split song twice and compare response bytes and cache headers.

The initial audit used only its isolated browser's project storage and existing ready stems. It did not run a new Demucs separation or export into a game folder. Functional audio correctness, real audible glitches, large ZIP exports, and multi-file project-save behavior were not benchmarked in that baseline pass.

## Implementation follow-up and verification

All eight findings have been addressed through implementation or measured reassessment. The changes remain local in the working tree; the pre-existing songMap and decodeAudio edits were preserved.

- **Timeline:** horizontal and vertical culling, visible-column waveform loops with original clip-relative sample mapping, a separate DOM playhead, and unchanged-scroll suppression. The canvas stays intact when only the playhead changes. The same 16 sequential clips at 500 px/s and 4× CPU slowdown now have **16.8 ms p95 frames**, compared with 433.4 ms. A native Play click measured **36 ms INP**, compared with 843 ms. No long tasks appeared in the three-second frame sample.
- **MP3:** the codec and PCM conversion run in a lazily loaded module worker. One frame-aligned chunk is transferred at a time, source AudioBuffer storage stays intact, progress is bounded to four notifications per second, and cancellation terminates the worker. The final traced export's longest target main-thread task was **5.65 ms**, compared with 7,225.42 ms. The untraced export had 16.7 ms p95 frames, a 16.8 ms maximum frame gap, and produced a 3,871,488-byte MPEG blob. Full export wall time was 12.55 s in that run; baseline full wall time was not recorded. Encoding still takes seconds, while controls remain responsive. A browser cancellation check settled within the 100 ms observation window.
- **Autosave:** playback ticks no longer restart the debounce. Durable edits save after 500 ms, with a two-second maximum delay during continuous editing; stopped transport position is saved too. IndexedDB version 2 stores immutable audio in a separate source store and writes small metadata separately. A gain edit saved during playback using one timer and one metadata write, with **zero audio bytes rewritten**; pausing added one metadata write. Unit tests cover continuous edits and cleanup.
- **Stems:** server responses include size/mtime validators and private revalidation caching; conditional requests return **304 with zero response bytes**. One recent decoded pair and its peaks is cached with a **192 MiB decoded-audio budget**. The worker reuses the active analysis and unchanged rankings, while new versions invalidate the cache. Superseded loads abort, and generation/signal checks precede decoding and CPU preparation. Re-selecting the fixture made **zero stem requests**, versus 185.6 MB previously, and reached ready in about **48 ms**, plus a deliberate 100 ms probe wait. The initial load still downloads both WAVs.
- **Preparation and memory:** peak averaging is fused into buckets without the 46.4 MB merged temporary. Game Song peak work yields in bounded batches. Trimming, downmixing, and decimation are fused and chunked before transferring mono analysis data; there are no full stereo trim copies. Deleted buffers, peaks, and original bytes are retained by live metadata and undo/redo snapshots, then released when ownership expires. Tests verify playable undo/redo and eviction after history expiry. In-flight AudioContext initialization is shared, preventing extra contexts during concurrent startup or restore.
- **Loading and CSS:** the entry bundle fell from **159.36 KB to approximately 103.60 KB gzip** in the build report, about 35%. Cold mobile LCP improved from 2,149 ms to **1,939 ms**, with CLS 0. An inline-stylesheet experiment measured 1,852 ms LCP and CLS 0: only an 87 ms difference in one comparison, versus the tool's 580 ms estimate. The existing cacheable stylesheet is retained; the JavaScript path limits the potential gain. No critical-CSS build machinery was added.
- **Accessibility:** markers accept Tab, arrows, Shift-arrows, Home and End; global shortcuts respect slider focus, bounds preserve a nonempty loop, and focus is visible. A native ArrowRight changed the start marker from 63.6903 s to 66.1283 s while preserving focus and its 2 px outline. The transport announces Playing/Paused and exposes the clock as a non-live timer. The loaded Game Song accessibility snapshot scored **100** again.

`npm test` passed **120 tests in 29 files**. `npm run lint`, `npm run build`, and `git diff --check` passed. Tests include byte-identical streamed MPEG output, owned PCM transfers, cancellation, trimmed analysis equivalence at three sample rates, peak equivalence, autosave deadlines, cache/version invalidation, stale-load cancellation, marker boundaries, audio ownership, and concurrent context initialization.

A real version-1 IndexedDB fixture restored its encoded audio, metadata, gain, and playhead. Its next edit migrated 96,044 source bytes atomically into the new source store. Reloading the version-2 project restored a playable 48,000-sample mono source and the edited gain. The browser checks used isolated contexts and fresh storage; existing project data was kept intact.

These remain descriptive local lab samples rather than repeated-run estimates or field p75. Real audible quality, actual screen-reader announcements, regenerated Demucs files, and large ZIP/project exports still need their own product checks. The export trace observed a small 0.01 layout shift when synthetic clicks inserted progress/cancel controls; cold navigation and the native stressed interaction both retained CLS 0.

Raw follow-up traces, probes, migration evidence, keyboard results, and Lighthouse reports are preserved in [the fixes evidence directory](/Users/samenoka/.codex/visualizations/2026/09/29/01a0ef28-f4db-75d0-8a09-11a612b80fc8/audio-perf-audit/evidence/fixes). The JSON report contains an `implementation` section with the measurements.
