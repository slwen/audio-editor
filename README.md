# Audio editor — Game Song

A local Vite + React tool that turns an ordinary song into looping, two-layer game music. It splits the song into a **base** stem (drums & bass, always playing) and a **top** stem (everything else, louder in fights), helps you pick and rate a seamless loop, and exports a small pack a game can play adaptively.

The app also still contains the original multitrack editor (**Edit**) and the **Find loops** workspace; the **Game song** button in the top bar opens the workflow described here.

## Setup

Requirements:

- Node.js with npm.
- `ffmpeg` on `PATH` — used for decoding, loudness measurement and MP3 encoding.
- Demucs in a Python venv at `~/.cache/audio-editor-demucs` (the path is fixed in `server/stems.ts`). Install once:

  ```sh
  python3 -m venv ~/.cache/audio-editor-demucs && ~/.cache/audio-editor-demucs/bin/python -m pip install -U demucs numpy
  ```

  If it is missing, the Game song screen shows this command with a Copy button.

```sh
npm install
npm run dev        # http://localhost:5173
```

Stem splitting, ratings and export run as Vite dev-server middleware under `/__game-song` (`server/gameSongPlugin.ts`), so they only work with `npm run dev`, not a static build. No environment variables are needed.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server (app + `/__game-song` endpoints) |
| `npm run split-stems -- sample_songs/<song>.mp3` | Same stem split from the command line |
| `npm test` / `npm run lint` / `npm run build` | Vitest, ESLint, type-check + production build |
| `npm run analyze -- sample_songs/<song>.mp3` | Writes `analysis/<song>.songmap.json` (beat grid, bar features, likely jumps) |
| `npm run eval:loops` | Replays `loop-ratings.jsonl` against the Find loops detector |

Files the workflow creates in the repo:

- `sample_songs/<song>` — imported source audio.
- `analysis/<song>.layers/base.wav`, `top.wav` — stems (48 kHz stereo float, exactly the source length).
- `game-song-ratings.jsonl` — Good/Bad wrap ratings (gitignored).

## Workflow

Click **Game song** in the top bar. Space plays/stops.

### 1. Import a song

Drop an audio file anywhere on the page, **Choose file…**, use the clip currently in the editor, or pick a song used before. The file is copied to `sample_songs/`.

### 2. Split into two layers

**Split stems** runs Demucs `htdemucs` (a few minutes). `drums + bass` become `base.wav`, `other + vocals` become `top.wav`; both are padded/trimmed to the source length so loop times match the original. Existing stems are reused unless the source file is newer.

### 3. Pick the loop

The game plays the song from 0. When it reaches **Wrap at**, it blends back to **Loop back to** and repeats until the level ends, then plays out to the end of the file.

- **Waveform and markers** — drag **Loop back to** (loop start) and **Wrap at** (loop end), or nudge them with ‹ ›. **Snap to** Bars or Beats. Shaded regions have few drums.
- **Blend** — crossfade length at the wrap: Tiny (35 ms click repair), ½ beat, 1 beat, 1 bar, or 1 second (default). Fades of 0.3 s or more are equal-power; shorter ones are linear. The fade is clamped so it fits inside the loop and the file.
- **Hear wrap** plays across the seam; **Hear from start** plays the song as the game would; **Stop**.
- **Seam** — the jump model's estimated chance the wrap sounds good.
- **Good / Bad** — your verdict on this exact wrap. Each click appends a record to `game-song-ratings.jsonl` (`{ version: 1, at, sourceName, exitSec, entrySec, fadeSec, rating: "good" | "bad" | "clear" }`); the latest record per song and wrap wins. Ratings from the older tools (`pack-ratings.jsonl`, `analysis/<song>.pack.json`) are also read and shown as "Rated … in the old tools".
- **Suggestions** — ranked wraps of at least 60 s, from the jump model, the drums & bass level (quiet intros/breakdowns are avoided), where the top layer drops out and returns, and earlier Good/Bad ratings. **Try next suggestion** cycles through them.
- **Warnings** — loop shorter than 60 s, loop start in the intro or a quiet part, or long quiet stretches inside the loop.
- **Calm mode / Calm level** — preview how the song sounds outside combat, with the top stem at the calm level (default `0.1`, `DEFAULT_CALM_LEVEL` in `src/gameSong/store.ts`; slider 0–50 %). **Hear fight → calm** plays the top stem at full, then fades it to the calm level over 8 s. The calm level is a preview setting saved in the browser; it is **not** written to `song.json` — set the matching value in the game.

Preview and export use the same wrap logic (`src/gameSong/wrap.ts`), so what you hear is what ships.

### 4. Export to the game

- **Song id** — lowercase letters, digits and dashes (`cathedral-of-iron`); used for file names.
- **Title** — display name.
- **Game music folder** — absolute path the files are copied into (remembered in the browser's localStorage; empty by default). Leave empty and use **Download ZIP** instead.
- **Cut the silence after the song ends** (default on) — trims to 1 s after the last sound, never before the loop's crossfade ends.
- **Mono drums & bass** — smaller base file.
- **Higher quality** — 128 kbps full band instead of 96 kbps with a 16 kHz cutoff.

**Export to game** then:

1. Measures loudness of base + top summed and applies the **same gain to both stems** to reach −14 LUFS, limited so true peak stays below −1 dBFS.
2. Encodes both stems to 48 kHz MP3 and checks they decode to identical sample lengths.
3. Checks encoder delay is constant along the file; a constant delay is compensated by shifting both loop points.
4. Writes the files to a staging folder, then copies them to the game folder.

Output:

```text
<game music folder>/
  <id>.base.mp3     drums & bass (stereo, or mono if chosen)
  <id>.top.mp3      everything else
  <id>.song.json    metadata below
```

### `song.json` (`game-song-v1`)

```json
{
  "version": "game-song-v1",
  "id": "cathedral-of-iron",
  "title": "Cathedral Of Iron",
  "sourceName": "cathedral-of-iron.mp3",
  "bpm": 98.477,
  "durationSec": 241.68,
  "loop": { "startSec": 63.685, "endSec": 183.104, "fadeSec": 1 },
  "loudness": { "integratedLufs": -14, "gainDb": -2.63 }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Always `"game-song-v1"`. |
| `id` | Matches `^[a-z0-9]+(-[a-z0-9]+)*$` and the file name prefix. |
| `title`, `sourceName` | Display name; original file name. |
| `bpm` | Detected tempo (3 decimals). |
| `durationSec` | Exact length of both MP3s after trimming. |
| `loop.startSec` / `loop.endSec` | Loop back to / Wrap at, in seconds from file start. `0 ≤ startSec < endSec ≤ durationSec`. |
| `loop.fadeSec` | Crossfade length, centred on the wrap. |
| `loudness.integratedLufs` / `gainDb` | Loudness after export; gain applied to both stems. |

The type and builder are in `src/gameSong/songJson.ts`; export code is in `server/exportGameSong.ts`.

**Wrap semantics.** Let `h = fadeSec / 2`. During output time `endSec − h … endSec + h`, the outgoing voice continues reading the file at `endSec + s` and fades out, while the incoming voice reads `startSec + s` and fades in (`s` runs from `−h` to `+h`). After the fade only the incoming voice plays, and the next wrap happens `endSec − startSec` seconds later. Curves are equal-power (`sin`) when `fadeSec ≥ 0.3`, otherwise linear. The file always contains at least `endSec + h` of audio.

## Building a compatible game audio system

Give the prompt below to a coding agent working in your game's repository. It is engine-agnostic; a Web Audio reference implementation exists but is not required.

````text
You are implementing an adaptive music system in this game. First inspect the game's existing audio
code (engine, audio APIs, asset loading, how levels start and end, any combat or threat state) and
summarise what you found. Ask me questions wherever the engine differs from the assumptions below
(e.g. no sample-accurate scheduling, streaming-only audio, no per-voice gain automation) before
writing code. Keep music on its own bus/mixer/context, separate from sound effects.

## Asset format ("game-song-v1")

A music folder contains one or more songs. Each song `<id>` is three files:
- `<id>.base.mp3` — drums & bass. Always audible.
- `<id>.top.mp3` — everything else. Volume follows game intensity.
- `<id>.song.json`:
  {
    "version": "game-song-v1",
    "id": "cathedral-of-iron",          // ^[a-z0-9]+(-[a-z0-9]+)*$, equals the file prefix
    "title": "Cathedral Of Iron",
    "sourceName": "cathedral-of-iron.mp3",
    "bpm": 98.477,
    "durationSec": 241.68,              // exact length of both MP3s
    "loop": { "startSec": 63.685, "endSec": 183.104, "fadeSec": 1 },
    "loudness": { "integratedLufs": -14, "gainDb": -2.63 }
  }
Both MP3s decode to exactly the same number of samples and are already loudness-matched
(-14 LUFS across songs), so play them at the same gain with no extra normalisation. Loop times are
seconds from the start of the file.

Validate every song.json on load: version must equal "game-song-v1"; id must match the regex and the
file name; all numbers finite; 0 <= loop.startSec < loop.endSec <= durationSec; fadeSec >= 0. Skip
(and log) invalid songs instead of crashing.

## Required behaviour

1. Stems in lockstep. Start base and top at file position 0 at the same scheduled audio-clock time.
   They must never drift; every operation (wrap, stop, fade) applies to both at the same time.

2. Sample-accurate loop wrap with crossfade. Play from 0. When playback reaches loop.endSec, continue
   from loop.startSec, forever, until the level ends. With h = fadeSec / 2:
   - Schedule a new pair of voices so that at output time T_wrap - h it starts reading the file at
     loop.startSec - h, fading in over fadeSec; the current voices keep reading past endSec
     (up to endSec + h) and fade out over the same window. The fade is centred on the wrap.
   - Curves: equal-power (gain_in = sin(x*pi/2), gain_out = cos(x*pi/2)) if fadeSec >= 0.3,
     linear otherwise; x goes 0..1 across the fade.
   - Next wrap is (endSec - startSec) seconds after the previous one.
   - Schedule each wrap on the audio clock at least one loop ahead (or as far ahead as the engine
     allows), never from a frame/update timer. Do not rely on native looping if it cannot express
     loop-start/end with a crossfade (e.g. Web Audio's AudioBufferSourceNode ignores loopEnd when
     loopStart is 0 in Chromium); use explicitly scheduled voices instead.

3. Intensity-driven top stem. The top stem's gain follows a game intensity signal:
   gain = calm + (1 - calm) * intensity, where intensity is 0..1 (or 0/1 for combat off/on).
   - calm is a configurable floor (default 0.1); 0 silences the top stem when calm.
   - Ramp towards the target over several seconds (default ~6 s, configurable) rather than jumping;
     retarget smoothly if intensity changes mid-ramp. The base stem stays at full.

4. Level end = play out. When the level ends, cancel any pending wraps and let the current voices
   run to the end of the file, then fade out (a few seconds, or naturally at end of file). If the
   level ends mid-crossfade, keep whichever voice continues into the file.

5. Song rotation. Each level picks a song from the available list, never the one that just played
   (unless only one exists). The next level's song crossfades in over ~4 s (configurable) while the
   previous song plays out/fades.

6. Memory and loading. Decode (or open streams for) only the current song and the next one; preload
   the next song during the current level and release songs that are no longer current/next.
   If the next song isn't ready when needed, start it as soon as it is, rather than blocking.

7. Robustness. Handle audio-context suspension/resume (autoplay policies, app backgrounding) without
   losing sync between stems or breaking the wrap schedule; handle pause if the game pauses music.

## Hooks the game must provide

- setIntensity(value 0..1)  — or setCombat(on: boolean) mapped to 1/0.
- onLevelStart(levelId?)    — pick/start (or crossfade to) a song.
- onLevelEnd()              — stop wrapping, play out.
- Optional: setMusicVolume(0..1), pause()/resume(), forceSong(id) for debugging.

## Deliverables

- The music system module(s) and the wiring to the hooks above.
- A song list/manifest discovery that works with this engine's asset system.
- Tests for the pure parts (song.json validation, wrap schedule times, gain/ramp maths, rotation).
- A debug way to jump near loop.endSec to audition the wrap.
- A short summary of how it works and any engine limitations you had to work around.
````

## Code map

- `src/components/GameSongScreen.tsx`, `GameSongWaveform.tsx` — the screen.
- `src/gameSong/` — analysis worker and suggestions (`analyze.ts`), wrap timing and fade curves (`wrap.ts`), preview player (`player.ts`), ratings (`ratings.ts`), `song.json` (`songJson.ts`), export checks (`exportChecks.ts`), state and actions.
- `server/` — dev-server plugin (`gameSongPlugin.ts`), Demucs split (`stems.ts`), export (`exportGameSong.ts`), ffmpeg helpers (`ffmpeg.ts`).
