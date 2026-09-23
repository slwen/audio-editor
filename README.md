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

Open a song with **Open audio** or drag it onto the editor, select it, choose **Find loops → Adaptive preview**. The everyday screen shows one exploration loop, one combat loop, and the two switches between them. It chooses a nearby pair from the draft, preferring pairs with existing Good transitions. For Cathedral of Iron this is the Good exploration hold around 2:10 and the 16-bar combat hold around 2:22. The game preview uses only those two loops; other saved holds and reviews remain available in **More loop choices, timing and export**.

**Hear combat switch** and **Hear exploration switch** start one bar before a proposed jump. Rate the heard join **Good** to make that exit available to the game preview, or **Bad** to try another. **Hear next option** auditions another exit or destination entry without removing earlier Good points. When the game requests a change, the current loop keeps playing and takes the next Good exit; each reviewed exit recurs on every repetition. The finder checks each bar of the playing loop against the first four entry bars of the destination, ranks the audio around each join, and prioritizes candidates that shrink the longest gap between Good exits. The preview shows that gap and what approving the next option could reduce it to. If you try an unreviewed switch during the preview, it plays the proposed join and asks for your rating. **Edit song markers** keeps the waveform and your rough Exploration/Combat flags: click to seek, play from there, mark changes, then **Update draft from markers**. The draft does not yet play through the full song arrangement between holds.

**Ease out of combat over** sets a minimum blend for Combat → Exploration. It defaults to one bar (about 2.4 seconds for Cathedral); two bars is available for a slower return. The longer blend applies to previously reviewed returns too, without discarding their Good ratings. A loop arrival can keep fading in across its wrap, so entering the last bar no longer caps the blend near 0.6 seconds. Changing the setting stops the current preview; start it again to hear the new blend.

### Advanced editing

The advanced view focuses on Exploration and Combat; **Show other feels** restores the other tabs. Each state holds a collection of passages. **Add Good tagged loops** adds approved cuts without replacing existing song passages. **Browse loops** offers waveform rows with inline listening before adding, plus All feels and Include unrated filters. Existing single-loop setups migrate to one-item collections without changing their chosen cuts or timing settings.

For a combat-heavy, two-state test such as *Cathedral of Iron*, click **Prepare two-state study**. It puts the longest Good combat bed first, chooses the nearest earlier Good exploration bed, starts the simulator in Combat, and turns on reviewed-only routing. Other saved passages remain available. Combat can repeat indefinitely while no tested exit exists. Select any directed pair in **Try one connection**, press **Hear this join**, then rate the completed join Good or Bad. Good adds the heard exit bar, entry bar, and blend to that pair's approved points; another Good point can be added without replacing it. Bad removes only the heard point. Changing pair timing clears those approvals until they are heard again. An unrated jump cannot occur during normal playback when **Only use reviewed jumps** is on. Exact source continuations remain available.

The song overview shows selected hold points, included source passages, and unused audio in separate feel lanes. **Hear loop** auditions the exact rendered loop; **Hear passage** plays a source passage once; **Hear song from here** plays the untouched song onward to the source trim end. These listening modes are distinct from the game simulator and stop one another. Space/transport Stop also stops inline listening.

Between non-overlapping sections of one feel, gap cards show exactly which audio is being skipped. **Hear gap** auditions that span; **Include this part of the song** adds the entire original span as a one-shot, including any partial bars. The adaptive player then prefers the continuous route through it. The gap's mood is explicitly unreviewed: including it does not infer that all intervening music matches the endpoint tags. No all-to-all transition compatibility is required; use tested jumps, natural continuations, and holds where appropriate. Playback behaviour is collapsed by default; pair tuning opens only for the selected jump or latest played connection.

**Let the music move through sections** advances at passage ends even while the gameplay state stays unchanged. It prefers adjoining source sections, then material heard less recently, and excludes cuts that overlap the current passage by 65% or more. Choose one, two, or four repetitions of a bed before moving on. A lone usable loop keeps repeating. **Include following bars** includes the next 4–16 whole bars of the source as an unscored one-shot section, preserving builds, fills, and development that might not form a good loop. Its mood needs auditioning; it has no inferred Good rating. One-shot sections move on or finish rather than repeating an untested wrap.

For adjoining passages with unnormalized audio and entry at bar one, the outgoing source joins the untouched incoming source at the passage boundary. The first arrival uses raw audio; if the destination is a loop, later repetitions use its approved wrap rendering. Other connections use complementary linear crossfades. Source passages include available post-roll for outgoing fades. **Connection settings** customize a directed pair's exit grouping, destination entry bar, and blend, or exclude that connection. **Tune this connection** beside a completed transition selects it for adjustment. Automatic progression uses passage ends; exit grouping applies to gameplay requests.

Request any state at any time. The latest request replaces pending gameplay changes and automatic progression; requesting the playing state cancels a gameplay change and resumes its collection. Repeated requests do not keep delaying an exit. Escalation queues immediately; de-escalation defaults to three seconds followed by a boundary. A one-shot must leave by its end rather than waiting beyond it. Shared passages can satisfy a new state without restarting. New setups use two-bar exits and one-beat blends; existing settings are preserved. Blends range from 5ms click repair through two bars, capped to a quarter of either passage and available source post-roll. A new change waits for an active arrival fade to finish. Each passage retains its native tempo; boundaries alone do not guarantee compatible harmony.

Space and transport controls operate the preview while it is open. Leaving stops playback. Stop to edit setup. Web Audio schedules sources and gains ahead; the UI timer advances the playlist scheduling and cleans up faded voices. If a loop has no allowed next passage, it continues holding.

Rate transitions Good/Bad and add notes, including after stopping. Events append to `transition-ratings.jsonl`, separate from loop ratings, with source identity, both cuts, actual exit/entry offsets, blend duration, natural-continuation flag, and revisions. Existing browser reviews migrate for all songs when the app opens; retries are deduplicated. Browser storage is retained as recovery if the dev server is unavailable. Save status and retry are visible in the preview. Setups and pair rules are saved per source in this browser.

**Export adaptive pack** writes version 5 `adaptive-music.json` with passage arrays per state, directed route approvals and multiple exit points, direction-specific return blending, progression settings and transition reviews. WAVs include rendered beds, raw first-arrival files for natural continuation, and post-roll files for one-shot transitions. The manifest distinguishes logical passage length from its post-roll file. This is data for a game music controller, not an engine integration. Authored bridge routing and stingers remain future extensions.

Tests cover rapid requests, cancellation, repeat suppression, one-shot progression, per-pair rules, entry offsets, long fades, exact-duration boundaries, and feedback migration/retry. Browser checks use Crypts audio; offline rendering verifies cancelled changes remain inaudible and adjoining passages reproduce the original samples across their join.

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
