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

## Configuration

| Flag | Env var | Default |
|------|---------|---------|
| `--listen-address` | `VOICETRAIN_LISTEN_ADDRESS` | `:8100` |
| `--data-dir` | `VOICETRAIN_DATA_DIR` | `~/voice-training` |
| `--analysis-image` | `VOICETRAIN_ANALYSIS_IMAGE` | `voicetrain-analysis` |
| `--backup-dir` | `VOICETRAIN_BACKUP_DIR` | empty (backups off) |
| `--backup-share` | `VOICETRAIN_BACKUP_SHARE` | empty |
| `--debug` | `VOICETRAIN_DEBUG` | off |

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
re-analysis). `POST /api/recordings/:id/analyze` re-queues one take.
If docker or the image is missing, the app runs fine and skips
analysis. Everything stays on-machine.

## Backups

Backups are off until you set `--backup-dir`, for example to a NAS
mount (the justfile has commented-out exports for
`VOICETRAIN_BACKUP_DIR` and `VOICETRAIN_BACKUP_SHARE`). Then the server
backs itself up 30s after startup and hourly after that. It copies any
missing or changed WAVs and a WAL-consistent `VACUUM INTO` snapshot of
the database. Nothing is ever deleted from the backup, so takes deleted
in the app survive there. If the share isn't mounted, the server asks
Finder to mount `--backup-share` using the login saved in the keychain.

Backups live in the server (not launchd/cron) on purpose: new
recordings only exist while the server runs, and macOS TCC denies
network-volume access to background agents but grants it to anything
launched from your terminal. `just backup` (scripts/backup.sh) does
the same sync by hand for server-down verification.

## Data layout

```
~/voice-training/
├── app.db                    # SQLite (WAL mode; -wal/-shm siblings are normal)
└── recordings/YYYY/MM/<id>.wav
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
  Rainbow Passage, and "The North Wind and the Sun", which is still a
  placeholder ("We like to party"). Seeding is idempotent, so edits you
  make in the UI stick.
- Schema migrations: plain SQL files in `pkg/store/migrations/`,
  applied by filename order via `PRAGMA user_version`.
- `just test` runs the Go tests, and the frontend typechecks during `ui-build`.
