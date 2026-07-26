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

**Use it via http://localhost only** — browsers require a secure
context for microphone access, and localhost qualifies; visiting from
another device by LAN IP will silently fail to record.

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

New uploads are analyzed automatically; on startup the server
backfills any takes that are missing analysis or carry an older
analyzer version (bump `ANALYSIS_VERSION` in `analysis/analyze.py`
and `analysis.Version` in Go together to force re-analysis).
`POST /api/recordings/:id/analyze` re-queues one take. If docker or
the image is missing the app runs fine — analysis is just skipped.
Everything stays on-machine.

## Backups

With `--backup-dir` set (the justfile exports point it at a NAS
mount), the **server backs itself up**:
30s after startup and hourly after that, it copies any missing/changed
WAVs and a WAL-consistent `VACUUM INTO` snapshot of the database.
Nothing is ever deleted from the backup — takes deleted in the app
survive on the NAS. If the share isn't mounted, it asks Finder to
mount `--backup-share` using the login saved in the keychain.

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

WAV masters run ~5.8 MB per minute. Recordings are uncompressed on
purpose: they're the ideal input for the planned automated analysis
(pitch/resonance annotations anchored to points in a take — the
`annotations` table and API already exist, read-only for now).

Mic capture disables echo cancellation, noise suppression, and auto
gain — those "helpers" distort exactly what voice training needs to
hear. Recording quality is therefore honest, including vocal fry.

## Notes

- Seed passages are placeholders right now ("We like to party") —
  replace the text in `pkg/store/seeds/*.txt` (delivered via
  idempotent seeding; edits you make in the UI stick).
- Schema migrations: plain SQL files in `pkg/store/migrations/`,
  applied by filename order via `PRAGMA user_version`.
- `just test` runs Go tests; the frontend typechecks during `ui-build`.
