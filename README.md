# Audio editor

A local React audio editor with a loop workspace for dynamic game music.

```sh
npm install
npm run dev
```

Drop a song onto the timeline, select it, and choose **Find loops**. Analysis assumes a steady **4/4** beat. The default **Beds** view shows 4–16-bar candidates; choose All or 1/2 bars in Filters for short motifs and stingers. Length quotas keep short loops from crowding out longer phrases. The detector may return no long loops when the song changes too much.

- **Hear seam** starts one bar before the wrap; **Hear full loop** auditions the entire bed. Space starts/stops playback. Shift-click selects multiple candidates.
- **Saved loops** restores exact rated or annotated cuts independently of the latest detection results. It opens with Good cuts when available, preserves their original BPM and boundaries, and ignores new score thresholds. Historical scores are labeled; saved preview settings are restored when selecting a cut.
- Mark **Good / Bad**, add a note, and tag **exploration / tension / combat / intensity / stinger**. Tags are listener-assigned. Feel and Review filters find saved decisions and stay synchronized with the timeline. New candidates default to Not marked Bad; use All or Bad to revisit rejected cuts. When a vote hides its row, a Last review panel keeps the exact cut available for a note and quick failure reasons.
- **Adjust seam, length & tempo** exposes whole-bar resizing, beat shifts, seam softening, crossfade, and manual BPM correction. Raw, Click repair, ½ beat and 1 beat blend presets act on the selected cut. Long blends are manual options; check the join and rhythm before saving. Each cut keeps its own blend and normalization through selection, reanalysis, export and copying. Mark or annotate a cut to retain its settings in the saved library. Scores are rankings, not probabilities or a guarantee of musical suitability.
- **Export loop pack** downloads one ZIP containing PCM WAVs and a JSON manifest with tags, notes, source cuts, BPM, bar counts, sample rate/count, and rendering settings. Each WAV is exactly the selected loop length, without a duplicated tail or shortened overlap. Every manifest entry records its own requested/effective blend and normalization; shared fields are null when settings differ.
- **Copy to timeline** creates independently editable, rendered clips. They use the same samples as preview/export and persist with the project. Use the editor's Duplicate command to repeat them.

The seam crossfade blends the source continuation after the end into the head, preserving duration. The default remains 35 ms. Long blends are limited by available continuation and one quarter of the loop; at the end of the source only a 5 ms click repair is available. Preview, exported WAVs, and timeline copies share this renderer. Normalization defaults off so quieter exploration beds remain quieter than combat beds; enable it when independent peak normalization is desired. A crossfade repairs a small splice, not an incompatible phrase change.

## Adaptive music preview

In loop mode, choose **Adaptive preview** in the transport. Assign one 4–16-bar bed per game state (Exploration, Tension, Combat, High intensity). Good loops are offered by default; **Include unrated beds** allows experiments. **Fill from Good feel tags** suggests assignments from listener tags. Missing moods remain unassigned. Assignments snapshot the exact cut and its blend/normalization, independent of future detection reruns.

This preview targets unpredictable encounters: request any state at any time. The latest request replaces a pending transition; requesting the currently playing state cancels it. Repeated requests for the same queued state do not keep delaying it. Escalation queues immediately; de-escalation defaults to a three-second hold followed by the next bar boundary. Change the hold to zero or six seconds. Transitions can use 1/2/4-bar boundaries or the full loop end. Boundaries follow the actual rendered sample duration (4/4), and destinations start at sample zero at their native tempo. There is no tempo stretching or harmonic compatibility guarantee.

Crossfades use complementary linear gains (¼ beat by default, optionally one beat or a direct switch with 5ms click repair). Web Audio schedules both sources and envelopes in advance on its audio clock; UI timers only report progress and clean up faded voices. New state requests do not depend on finishing a long bed. Space and transport Play/Stop control the adaptive player while this view is open; leaving it stops playback. Stop to change assignments/settings.

Rate a completed **transition** Good/Bad and add a note, including after stopping playback. These decisions append to `transition-ratings.jsonl`, separately from loop ratings, with source identity, both exact cuts, settings, exit position, and note/rating revisions. Existing browser reviews migrate automatically for all songs when the app opens; retries are deduplicated. Browser storage remains the recovery copy if the dev server is unavailable, and the preview shows save status with a retry button. Setups persist in this browser, scoped by song name and decoded length/sample rate. **Export adaptive pack** saves the assigned WAVs and `adaptive-music.json`, including per-state sample counts, loop points, bar duration, render settings, transition rules, and reviews. The pack is data for a game music controller; it does not include an engine integration. This first version uses one bed per state and direct blends; loop pools, stingers, authored bridge clips, and per-pair exit markers are future extensions.

Tests cover rapid replacement/cancellation, repeated game-state updates, de-escalation, exact-duration boundaries, late UI ticks, and source cleanup. Browser checks also use real Crypts audio and offline rendered gain envelopes to verify cancelled transitions stay inaudible.

## Listening feedback

While running the development server, ratings, notes, and tags append to `loop-ratings.jsonl`. Notes and tags are separate events and do not overwrite listening votes. Records include the analysis version and preview rendering settings. Existing logs without those fields remain readable. This endpoint is provided by Vite's development server; static production hosting alone does not persist the log.

The evaluator replays the latest decision per exact source/cut, preserves note-only updates, honors cleared ratings, and rescoring never shifts a rated cut. New candidates are not assumed good merely because they are close to a rated loop. Votes for musical blends longer than 120 ms are reported separately from original-cut ranking: a successful repair must not relabel the original rejected splice. Notes on a new rendering do not inherit a listening vote from another rendering.

```sh
npm test
npm run build
npm run lint
# Requires ffmpeg on PATH, sample_songs/, and loop-ratings.jsonl:
npm run eval:loops
# Optional per-cut machine-readable results:
LOOP_EVAL_JSON=/tmp/loop-evaluation.json npm run eval:loops
```

Evaluation defaults to a 48,000 Hz stereo decode, then uses the same downmix and analysis preparation as the browser (24,000 Hz analysis). Set `LOOP_SOURCE_SAMPLE_RATE=44100` for a browser using 44,100 Hz. The report includes exact-cut score reproduction, per-song and per-length ranking, current-version decisions, listener notes, and generated length coverage. It does not inject feedback into candidate scores. `LOOP_DETECTOR_FILE=/absolute/path/detector.ts` evaluates an experimental detector without changing the running application.

On the 174 distinct listening decisions in the September 22 evaluation (68 Good, 106 Bad), phase closure improved top-20 results from 13 Good / 7 Bad to 18 Good / 2 Bad, and ranking AUC from 0.618 to 0.776. Cathedral improved from 0.458 to 0.664. The evaluator reproduced 17 current-version browser scores within 0.000034. These are development-set measurements on three tracks, not held-out perceptual validation. The report separates 4/8/16-bar beds so aggregate improvements cannot conceal a loss of useful long loops.

The search considers alternatives in every bar rather than requiring the whole phrase to repeat later in the source. It returns 4/8/16-bar options on Cathedral and Graveyard; the listening log now includes accepted Cathedral 8-bar exploration and 16-bar combat/intensity cuts. Musical/background mismatches remain among the rejected cuts. Higher-resolution harmonic penalties and longer comparison windows were evaluated offline but not shipped: they removed accepted long beds or regressed other tracks.

The detector compares matching musical phases around both cut points, including quiet spectral bands beneath dense foreground audio. Fractional tempo refinement across up to 16 beats reduces accumulated timing drift. Tests cover long-bed duration, tempo drift, background-layer changes, stereo seam continuity, mono WAV export, ZIP integrity, and feedback replay.

Manual beat shifts and region resizing rescore in the analysis worker using the same complete source, downmix, sample rate and feature-grid origin as detection. The first edit caches the features; subsequent edits reuse them. Cancelled or superseded analyses reject pending work, and late results cannot update another source. On the Cathedral browser check, moving a 4-bar cut one beat and back restored its original score exactly; the edits took about 20 ms each after caching.

A median-filter harmonic/percussive separation experiment was also checked against all 174 rated cuts. It improved some rejected long loops but raised the scores of both explicitly reported Cathedral background mismatches (165.42s and 91.12s) and regressed Undead, so it remains outside the application.

The listener also rejected one-beat crossfade comparisons for both Cathedral cuts: neither recording sounded good and the cuts were not seamless. These attempts are logged as Bad rendering variants. Extending the blend is not a validated repair for these failures; detection needs better musical boundaries.
