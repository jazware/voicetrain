# voicetrain 🌅

A cozy, locally-run webapp for practicing and tracking feminizing voice
training. Record takes against standard practice passages with a live
waveform and real-time pitch feedback, rate how they felt, leave
yourself notes, and watch your practice history bloom on a calendar
heatmap.

Everything stays on your machine: recordings are 48kHz mono WAV files
and metadata lives in SQLite, all under `~/voice-training/`.

## Running

```bash
just build     # builds the frontend + a single binary at bin/voicetrain
./bin/voicetrain
# → http://localhost:8100
```

Or for development (two terminals):

```bash
just dev       # Go backend on :8100 (debug logging)
just ui-dev    # Vite dev server on :3002, proxies /api to :8100
```

Use it via http://localhost only. Browsers need a secure context for
microphone access, and localhost counts as one. Visiting from another
device by LAN IP fails to record without an error.

Served beyond localhost, it runs behind a reverse proxy that vouches for
the user's identity: the image is the static server plus `analyze.py` on a
Python base (`just image-base`), the analyzer runs in-process
(`--analysis-command`), and `--trusted-proxies`/`--operators`/`--site-origin`
make it believe only that proxy.

## Configuration

| Flag | Env var | Default |
|------|---------|---------|
| `--listen-address` | `VOICETRAIN_LISTEN_ADDRESS` | `127.0.0.1:8100` |
| `--data-dir` | `VOICETRAIN_DATA_DIR` | `~/voice-training` |
| `--analysis-image` | `VOICETRAIN_ANALYSIS_IMAGE` | `voicetrain-analysis` |
| `--analysis-command` | `VOICETRAIN_ANALYSIS_COMMAND` | empty (use the image) |
| `--analysis-workers` | `VOICETRAIN_ANALYSIS_WORKERS` | half the CPUs, at most 4 |
| `--analysis-batch` | `VOICETRAIN_ANALYSIS_BATCH` | `8` |
| `--backup-dir` | `VOICETRAIN_BACKUP_DIR` | empty (backups off) |
| `--backup-share` | `VOICETRAIN_BACKUP_SHARE` | empty |
| `--ops-listen` | `VOICETRAIN_OPS_LISTEN` | empty (no /metrics, pprof) |
| `--trusted-proxies` | `VOICETRAIN_TRUSTED_PROXIES` | empty (no checks: laptop mode) |
| `--operators` | `VOICETRAIN_OPERATORS` | empty |
| `--site-origin` | `VOICETRAIN_SITE_ORIGIN` | empty |
| `--debug` | `VOICETRAIN_DEBUG` | off |

## Exercises and the daily routine

Besides passages there are three exercises, seeded like the passages
(scripts with a `kind`, migration 0005): **Sirens** (slow glides across
the range), **Sustained "ah"** (one steady note on one breath) and
**Hold the band** (a minute of talking inside the home band). They
record with the same studio and live meter, and each has a coach beside
it, fed by the same live frames (`lib/exercises.ts`): the range covered
(5th to 95th percentile, in semitones), the hold in progress filling a
ring with its steadiness in cents, or the time at home with the current
and longest stretch. Those measures are saved with the take in
`pitch_stats`; the take is analyzed like any other. Progress charts
each exercise's measure on its own, and keeps exercises out of the
passage pitch chart (a siren's median isn't speaking pitch).

The daily routine (`/routine`) is siren, sustain, hold, then the
passage practised most recently. A step is done once today has a take
of it, and a bar on each step's page leads to the next one.

## Acoustic analysis

Each take is run through a dockerized Praat pipeline (`analysis/`,
Python pinned via `uv.lock`) that measures the coaching axes post-hoc:
pitch (median/band/fry), melody (semitone spread, phrase endings),
resonance (formants → estimated vocal tract length, spectral tilt),
breath/pacing (phrases, pauses, syllable rate), and weight (CPPS, HNR,
jitter/shimmer). Results land on the recording row (`analysis` JSON);
time-anchored events (fry, monotone stretches, overlong phrases)
become `source='auto'` rows in `annotations`.

```bash
just analysis-build   # one-time: build the voicetrain-analysis image
```

The recording detail page renders all of it as the "What we heard"
card: a click-to-listen pitch contour, per-axis tiles with coaching
notes, and the events as colored click-to-play regions on the
playback waveform.

New uploads are analyzed automatically. On startup the server
backfills any takes that are missing analysis or carry an older
analyzer version (bump `ANALYSIS_VERSION` in `analysis/analyze.py`
and `analysis.Version` in `pkg/analysis` together to force
re-analysis, then `just analysis-build`). The document a newer
analyzer replaces moves to `analysis_history`, one per version, so
re-analysis never loses what a take was measured as. The server asks
the image for its version (`--version`) and won't re-run old takes
through an image older than itself.
`POST /api/recordings/:id/analyze` re-queues one take.
If docker or the image is missing, the app runs fine and skips
analysis. Everything stays on-machine.

Takes go through in batches: one analyzer process (`analyze.py
--jsonl`) per batch of up to `--analysis-batch` takes (8), and
`--analysis-workers` processes at once (half the CPUs, at most 4), so
the interpreter, Praat and container start-up are paid per batch, not
per take. New takes and re-listens go ahead of a backfill, and a
backfill runs newest first. A take whose analysis fails records why
(`analysis_error`), the take's page says so instead of waiting
forever, and Settings shows progress and retries failures.
`GET /api/analysis/status` reports what the analyzer is doing;
`GET /api/recordings/:id/analyses` lists the documents newer
analyzers replaced. `--analysis-command` runs the analyzer directly
instead of in docker (the container image does).

`just analysis-test` checks the analyzer against KlattGrid voices with
known f0 and formants (Praat synthesizes them, so the tests assert
accuracy, not just shape).

Analyzer v2 measures spectral centroid and tilt, HNR and CPPS on voiced
speech only. Whole-take values also measured the pauses: on 154 real
takes, CPPS correlated +0.49 with the voiced share of the take (now
-0.03), and a synthetic take scored 27.5 dB CPPS with 0.3 s pauses and
16.9 dB with 2 s ones. Fry share counts in-phrase frames only, since
60 Hz mains hum in pauses read as fry. Pitch settings are unchanged:
against pYIN on the same takes, Praat at 0.6/0.05 had the fewest gross
errors (0.66%) of the settings tried, and per-take formant ceilings or
Praat's formant tracker didn't make within-day formant medians any
steadier than the fixed 5500 Hz ceiling.

## Live pitch

The practice screen tracks pitch in the browser with YIN
(`ui/src/lib/audio/yin.ts`): 16 kHz, a 10 ms hop, first-dip period
picking, a causal octave check, and a 3-frame onset check. Against
pYIN on the same 154 takes it went from 59% to 73% voicing recall and
from 11.8% to 1.3% gross pitch errors (the old MPM tracker updated
every 60 ms), and a take's live median now lands within 0.7 Hz of the
post-hoc one (was 3.3 Hz). `pnpm test` in `ui/` runs its synthetic
ground-truth tests.

The audio never crosses the page's main thread: the recorder worklet
streams 512-sample batches over a MessagePort to a worker
(`liveWorker.ts`) that tracks pitch, reduces the waveform to peaks and
keeps the take for the WAV. The page draws on requestAnimationFrame
from a store (`liveStore.ts`), interpolating the audio clock between
batches so the trace glides, and nothing re-renders React while
recording. Measured with a fake mic flipping 180/240 Hz each second
(headless Chrome): the readout settles on the new pitch 61-63 ms after
the flip (was 264-292 ms) and main-thread script time dropped from 47
to 22 ms per second. The trace runs ~35-45 ms behind the voice: a
10.7 ms batch, a 10 ms window centre, one frame of median, one paint.

The big number is calm on purpose: speech glides ~10 semitones a
second, so a number that followed every frame changed 35 times a
second. It moves at once for a jump over a semitone and settles
smaller moves after a quarter second; the trace shows the rest. A
take that fails to upload stays in the tab with Try again / Download
the WAV, and leaving the page mid-take asks first. Space starts and
stops a take.

## Backups

Backups are off until you set `--backup-dir`, for example to a NAS
mount. The justfile exports `VOICETRAIN_BACKUP_DIR` and
`VOICETRAIN_BACKUP_SHARE`, so `just run` backs up to the NAS; run the
binary directly with `--backup-dir ""` for a throwaway data dir. The
server backs itself up 30s after startup and every `--backup-interval`
(an hour) after that:

- `recordings/`: takes copied once, never deleted or overwritten, so
  takes deleted in the app survive there. Each run snapshots the
  database first and copies the takes that snapshot lists, checked
  against their rows' sizes, before publishing the snapshot: every
  snapshot in the backup restores with its audio.
- `db/app-<UTC time>.db`: a `VACUUM INTO` snapshot (consistent while
  the app writes, `quick_check`ed) whenever the database changed,
  thinned to a day of every change, 30 dailies and 12 monthlies;
  `app.db` is the newest. Changes are found by hashing the snapshot:
  the old check compared `app.db`'s mtime, which WAL mode only moves at
  a checkpoint, and the laptop's NAS copy had stopped updating on
  Sep 5.

`--backup-require-marker` refuses a folder without a
`.voicetrain-backup` file, for a NAS mounted with `nofail`:
an unmounted share is an empty local directory, and backing up there
would fill the local disk and look like success. Settings shows the
last backup and any failure; `/metrics` has
`voicetrain_backup_last_success_timestamp_seconds`. If the share isn't
mounted on a Mac, the server asks Finder to mount `--backup-share` using
the login saved in the keychain.

`voicetrain verify --data-dir DIR [--backup B] [--fix]` checks every
take's file against its row after a restore (deploy/yeet/docs/voicetrain.md
"Restoring").

Takes get `<id>-<random>.wav` names because SQLite hands a deleted
newest take's id to the next one; with `<id>.wav` the backup would pair
the new row with the old audio.

Backups live in the server (not launchd/cron) on purpose: new
recordings only exist while the server runs, and macOS TCC denies
network-volume access to background agents but grants it to anything
launched from your terminal. `just backup` (scripts/backup.sh) does
the same sync by hand for server-down verification.

## Data layout

```
~/voice-training/
├── app.db                    # SQLite (WAL mode; -wal/-shm siblings are normal)
└── recordings/YYYY/MM/<id>-<random>.wav   # <id>.wav before unique names
```

WAV masters run ~5.8 MB per minute. Recordings are uncompressed so
the acoustic analysis gets the full signal. Its time-anchored events
are `annotations` rows, which the API serves read-only
(`GET /api/recordings/:id/annotations`).

Mic capture turns off echo cancellation, noise suppression and auto
gain, since they distort what voice training needs to hear. So the
recording is honest, vocal fry included.

## Notes

- The app seeds two passages from `pkg/store/seeds/*.txt`: the
  Rainbow Passage and "The North Wind and the Sun" (the IPA's
  version). Seeding is idempotent and never overwrites a passage, so
  edits you make in the UI stick.
- Schema migrations: plain SQL files in `pkg/store/migrations/`,
  applied by filename order via `PRAGMA user_version`.
- `just check` runs the Go and UI tests, the typecheck + build, and the
  analyzer tests (in the analysis image).
