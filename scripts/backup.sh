#!/usr/bin/env bash
# Mirror the voicetrain data dir to the NAS.
#
# - The SQLite DB is snapshotted with `.backup` (WAL-consistent) rather
#   than copied live, so a mid-write sync can't corrupt the copy.
# - rsync never deletes on the NAS side: takes deleted in the app stay
#   in the backup. This is a safety net, not a mirror.
# - Manual escape hatch (`just backup`) — the server does the same
#   sync itself hourly while running (pkg/backup); this script exists
#   for server-down verification and first-time seeding.
set -euo pipefail

DATA_DIR="${VOICETRAIN_DATA_DIR:-$HOME/voice-training}"
SHARE_URL="smb://10.0.6.4/storage"
MOUNT_POINT="/Volumes/storage"
DEST="$MOUNT_POINT/Backup/voicetrain"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Mount the share if needed. `mount volume` goes through Finder, which
# reuses the login saved in the keychain from a previous manual mount.
if ! mount | grep -q " on $MOUNT_POINT "; then
  log "mounting $SHARE_URL"
  osascript -e "mount volume \"$SHARE_URL\"" >/dev/null
  for _ in $(seq 1 10); do
    mount | grep -q " on $MOUNT_POINT " && break
    sleep 1
  done
fi
if ! mount | grep -q " on $MOUNT_POINT "; then
  log "ERROR: $MOUNT_POINT is not mounted; is the NAS up?"
  exit 1
fi

mkdir -p "$DEST/recordings"

# WAL-consistent snapshot of the database.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
sqlite3 "$DATA_DIR/app.db" ".backup '$tmp_dir/app.db'"

# SMB-friendly rsync: no ownership/permission juggling, tolerant of the
# share's coarse timestamps. Never --delete.
RSYNC_OPTS=(-rt --no-perms --no-owner --no-group --modify-window=2 --exclude='.*')
new_count=$(rsync "${RSYNC_OPTS[@]}" --itemize-changes \
  "$DATA_DIR/recordings/" "$DEST/recordings/" | grep -c '^>f' || true)
rsync "${RSYNC_OPTS[@]}" "$tmp_dir/app.db" "$DEST/app.db"

# macOS drops AppleDouble (._*) metadata sidecars on SMB shares; they
# carry no audio and just clutter the backup.
find "$DEST" -name '._*' -delete 2>/dev/null || true

total=$(find "$DEST/recordings" -name '*.wav' ! -name '._*' | wc -l | tr -d ' ')
log "backup ok: $new_count new recording(s) copied, $total total on NAS"
