// Package backup mirrors the data dir to a backup destination (the
// NAS) from inside the server process. Living in the server is
// deliberate: new recordings can only appear while the server runs, and
// on a laptop a child of the user's session inherits the network-volume
// permissions macOS denies to launchd agents.
//
// What lands in the destination:
//
//	recordings/YYYY/MM/<id>.wav   mirrored, never deleted or overwritten
//	db/app-<UTC time>.db          a snapshot whenever the database changed,
//	                              thinned to hourly/daily/monthly (Retention)
//	app.db                        the newest snapshot, for a quick restore
//
// Snapshots come from VACUUM INTO: one read transaction, so they're as
// consistent as sqlite3's .backup and safe while the app writes. Each is
// written to a local temp file, checked with quick_check, then copied
// over, so SQLite never locks a network file.
package backup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jazware/voicetrain/pkg/metrics"
	"github.com/jazware/voicetrain/pkg/store"
)

// Marker is the file a destination must hold when Config.RequireMarker
// is set. When the NAS is mounted with nofail and absent, the
// mount point is an ordinary empty directory on the local disk, and a
// backup written there would fill the root filesystem and look like a
// success. The marker only exists on the real share.
const Marker = ".voicetrain-backup"

const snapshotPrefix = "app-"

// tempSnapshotPrefix names the local snapshot a run takes in the data
// dir; one left by a crash is removed at start.
const tempSnapshotPrefix = ".backup-snapshot-"
const snapshotLayout = "20060102T150405Z"

// Retention keeps every snapshot from the last Recent, then the newest
// one per day for Days days, then the newest per month for Months months.
type Retention struct {
	Recent time.Duration
	Days   int
	Months int
}

// DefaultRetention: a day of every change, a month of dailies, a year of
// monthlies. The database is a few MB, so this stays well under a GB.
var DefaultRetention = Retention{Recent: 24 * time.Hour, Days: 30, Months: 12}

// Config describes where and how often to back up.
type Config struct {
	Dir string
	// ShareURL is an SMB share to mount through Finder (macOS) when Dir
	// is missing.
	ShareURL string
	// Label names Dir for people (a container sees the NAS as /backup).
	Label string
	// RequireMarker refuses any Dir without the Marker file in it.
	RequireMarker bool
	Interval      time.Duration
	Retention     Retention
}

// Status is what the UI shows about backups.
type Status struct {
	Enabled       bool   `json:"enabled"`
	Dir           string `json:"dir,omitempty"`
	IntervalS     int64  `json:"interval_s,omitempty"`
	LastAttemptAt *int64 `json:"last_attempt_at,omitempty"`
	LastSuccessAt *int64 `json:"last_success_at,omitempty"`
	LastError     string `json:"last_error,omitempty"`
	Recordings    int    `json:"recordings"`
	Snapshots     int    `json:"snapshots"`
	// BadTakes are takes whose files don't match their rows (missing or
	// the wrong size): not backed up, and the run counts as failed.
	BadTakes []int64 `json:"bad_takes,omitempty"`
}

// Runner periodically syncs the data dir. A nil *Runner is valid and
// does nothing.
type Runner struct {
	logger  *slog.Logger
	store   *store.Store
	dataDir string
	cfg     Config
	now     func() time.Time

	mu     sync.Mutex
	status Status
	// lastHash is the newest snapshot's sha256, to skip unchanged ones.
	lastHash string
}

func NewRunner(logger *slog.Logger, st *store.Store, dataDir string, cfg Config) *Runner {
	if cfg.Dir == "" {
		return nil
	}
	if cfg.Interval <= 0 {
		cfg.Interval = time.Hour
	}
	if cfg.Retention == (Retention{}) {
		cfg.Retention = DefaultRetention
	}
	if cfg.Label == "" {
		cfg.Label = cfg.Dir
	}
	if leftovers, err := filepath.Glob(filepath.Join(dataDir, tempSnapshotPrefix+"*")); err == nil {
		for _, f := range leftovers {
			os.Remove(f)
		}
	}
	return &Runner{
		logger: logger, store: st, dataDir: dataDir, cfg: cfg, now: time.Now,
		status: Status{Enabled: true, Dir: cfg.Label, IntervalS: int64(cfg.Interval / time.Second)},
	}
}

// Start syncs once shortly after startup, then every Interval until ctx ends.
func (r *Runner) Start(ctx context.Context) {
	if r == nil {
		return
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := r.RunOnce(ctx); err != nil {
			r.logger.Warn("backup failed", "error", err)
		}
		timer.Reset(r.cfg.Interval)
	}
}

func (r *Runner) Status() Status {
	if r == nil {
		return Status{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status
}

// RunOnce backs up everything new and records the outcome.
func (r *Runner) RunOnce(ctx context.Context) error {
	start := r.now()
	copied, snapshotted, err := r.run(ctx)
	r.mu.Lock()
	at := start.UnixMilli()
	r.status.LastAttemptAt = &at
	if err != nil {
		r.status.LastError = err.Error()
	} else {
		r.status.LastError = ""
		r.status.LastSuccessAt = &at
	}
	r.mu.Unlock()

	if err != nil {
		metrics.BackupRuns.WithLabelValues("failed").Inc()
		return err
	}
	metrics.BackupRuns.WithLabelValues("ok").Inc()
	metrics.BackupLastSuccess.Set(float64(start.Unix()))
	metrics.BackupFilesCopied.Add(float64(copied))
	if copied > 0 || snapshotted {
		r.logger.Info("backup ok", "new_recordings", copied, "db_snapshot", snapshotted, "dest", r.cfg.Dir)
	} else {
		r.logger.Debug("backup: nothing new")
	}
	return nil
}

func (r *Runner) run(ctx context.Context) (int, bool, error) {
	if err := r.checkDestination(ctx); err != nil {
		return 0, false, err
	}
	// The snapshot comes first, and the takes it lists are copied before
	// the snapshot itself is published: a snapshot on the backup has all
	// of its takes there, but for any take that was already broken here
	// (listed in the status and the run's error), so a restore never
	// pairs a row with someone else's audio. A broken take never stops
	// the database from being backed up.
	snap := filepath.Join(r.dataDir, fmt.Sprintf("%s%d.db", tempSnapshotPrefix, time.Now().UnixNano()))
	defer os.Remove(snap)
	if err := r.store.SnapshotTo(snap); err != nil {
		return 0, false, fmt.Errorf("snapshotting database: %w", err)
	}
	if err := quickCheck(snap); err != nil {
		return 0, false, err
	}
	takes, err := ListTakes(snap)
	if err != nil {
		return 0, false, fmt.Errorf("reading the snapshot: %w", err)
	}
	copied, bad, err := r.syncRecordings(takes)
	if err != nil {
		return copied, false, fmt.Errorf("syncing recordings (snapshot not published): %w", err)
	}
	snapshotted, err := r.publishSnapshot(snap)
	if err != nil {
		return copied, false, fmt.Errorf("publishing the database snapshot: %w", err)
	}
	kept, err := r.prune()
	if err != nil {
		return copied, snapshotted, fmt.Errorf("pruning snapshots: %w", err)
	}
	r.mu.Lock()
	r.status.Recordings = len(takes)
	r.status.Snapshots = kept
	r.status.BadTakes = nil
	for _, t := range bad {
		r.status.BadTakes = append(r.status.BadTakes, t.ID)
	}
	r.mu.Unlock()
	metrics.BackupBadTakes.Set(float64(len(bad)))
	if len(bad) > 0 {
		names := make([]string, len(bad))
		for i, t := range bad {
			names[i] = fmt.Sprintf("%d (%s)", t.ID, t.FilePath)
		}
		return copied, snapshotted, fmt.Errorf("%d takes don't match their rows (missing or the wrong size), so they weren't backed up: %s; the database and the other takes were",
			len(bad), strings.Join(names, ", "))
	}
	return copied, snapshotted, nil
}

// checkDestination makes sure Dir is the real backup target: present
// (asking Finder to mount the share on a Mac) and, when required,
// holding the marker the bare mount point never has.
func (r *Runner) checkDestination(ctx context.Context) error {
	if _, err := os.Stat(r.cfg.Dir); err != nil && r.cfg.ShareURL != "" {
		mountCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		script := fmt.Sprintf("mount volume %q", r.cfg.ShareURL)
		if out, err := exec.CommandContext(mountCtx, "osascript", "-e", script).CombinedOutput(); err != nil {
			return fmt.Errorf("mounting %s: %v: %s", r.cfg.ShareURL, err, out)
		}
	}
	info, err := os.Stat(r.cfg.Dir)
	if err != nil {
		return fmt.Errorf("backup destination unavailable: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("backup destination %s is not a directory", r.cfg.Dir)
	}
	if r.cfg.RequireMarker {
		if _, err := os.Stat(filepath.Join(r.cfg.Dir, Marker)); err != nil {
			return fmt.Errorf("backup destination has no %s: the share looks unmounted, so nothing was written", Marker)
		}
	}
	return nil
}

type Take struct {
	ID       int64
	FilePath string
	Size     int64
}

// ListTakes reads the takes with audio from a database file (a snapshot
// or a restored app.db), opened read-only.
func ListTakes(dbPath string) ([]Take, error) {
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`SELECT id, file_path, size_bytes FROM recordings WHERE file_path != '' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Take
	for rows.Next() {
		var t Take
		if err := rows.Scan(&t.ID, &t.FilePath, &t.Size); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// syncRecordings copies the snapshot's takes that the destination lacks
// and returns the ones it couldn't: a file missing or not the size its
// row says (damaged) isn't backed up. Errors are the destination's
// (writing the NAS failed), which stop the run. A file already in
// the destination is never overwritten: a different size under the same
// name (another server's take, or an id SQLite reused before takes got
// unique names) keeps both, as <name>.<sha12>.wav.
func (r *Runner) syncRecordings(takes []Take) (int, []Take, error) {
	copied := 0
	var bad []Take
	for _, t := range takes {
		src := filepath.Join(r.dataDir, t.FilePath)
		info, err := os.Stat(src)
		if err != nil || info.Size() != t.Size {
			bad = append(bad, t)
			continue
		}
		dest := filepath.Join(r.cfg.Dir, t.FilePath)
		destInfo, statErr := os.Stat(dest)
		switch {
		case statErr == nil && destInfo.Size() == t.Size:
			continue
		case statErr == nil:
			sum, err := fileHash(src)
			if err != nil {
				return copied, bad, err
			}
			alt := AlternateName(dest, sum)
			if _, err := os.Stat(alt); err == nil {
				continue
			}
			r.logger.Warn("backup: a different file already has this take's name; keeping both",
				"take", t.ID, "path", t.FilePath, "saved_as", filepath.Base(alt))
			dest = alt
		case !errors.Is(statErr, os.ErrNotExist):
			return copied, bad, statErr
		}
		if err := copyFile(src, dest); err != nil {
			return copied, bad, fmt.Errorf("copying take %d: %w", t.ID, err)
		}
		if info, err := os.Stat(dest); err != nil || info.Size() != t.Size {
			return copied, bad, fmt.Errorf("take %d: the copy on the backup isn't %d bytes", t.ID, t.Size)
		}
		copied++
	}
	return copied, bad, nil
}

// AlternateName is where a take goes when its name is taken by another
// file: <name>.<first 12 hex of its sha256>.wav.
func AlternateName(path, sha string) string {
	return strings.TrimSuffix(path, ".wav") + "." + sha[:12] + ".wav"
}

// publishSnapshot copies the snapshot to db/app-<time>.db (and app.db)
// when the database's contents changed since the newest one there. It
// compares hashes, not file times: in WAL mode app.db's mtime only moves
// at a checkpoint, which once left the laptop's backup weeks stale. Each
// copy is re-hashed on the backup before it counts.
func (r *Runner) publishSnapshot(snap string) (bool, error) {
	sum, err := fileHash(snap)
	if err != nil {
		return false, err
	}
	dbDir := filepath.Join(r.cfg.Dir, "db")
	if r.lastHash == "" {
		if newest, ok := newestSnapshot(dbDir); ok {
			r.lastHash, _ = fileHash(filepath.Join(dbDir, newest))
		}
	}
	if sum == r.lastHash {
		return false, nil
	}
	name := snapshotPrefix + r.now().UTC().Format(snapshotLayout) + ".db"
	for _, dest := range []string{filepath.Join(dbDir, name), filepath.Join(r.cfg.Dir, "app.db")} {
		if err := copyFile(snap, dest); err != nil {
			return false, err
		}
		got, err := fileHash(dest)
		if err != nil {
			return false, err
		}
		if got != sum {
			os.Remove(dest)
			return false, fmt.Errorf("the copy of the snapshot at %s doesn't match (sha256 %s, want %s)", dest, got[:12], sum[:12])
		}
	}
	r.lastHash = sum
	return true, nil
}

func (r *Runner) prune() (int, error) {
	dbDir := filepath.Join(r.cfg.Dir, "db")
	names := snapshotNames(dbDir)
	keep := Keep(names, r.now(), r.cfg.Retention)
	for _, n := range names {
		if !keep[n] {
			if err := os.Remove(filepath.Join(dbDir, n)); err != nil && !os.IsNotExist(err) {
				return 0, err
			}
		}
	}
	return len(keep), nil
}

// Keep decides which snapshots (by name) the retention policy keeps:
// everything newer than Recent, then the newest of each of the last Days
// days, then the newest of each of the last Months months. The newest
// snapshot is always kept, and names it can't parse are never deleted.
func Keep(names []string, now time.Time, ret Retention) map[string]bool {
	type snap struct {
		name string
		at   time.Time
	}
	keep := map[string]bool{}
	var snaps []snap
	for _, n := range names {
		at, err := time.Parse(snapshotLayout, strings.TrimSuffix(strings.TrimPrefix(n, snapshotPrefix), ".db"))
		if err != nil {
			keep[n] = true
			continue
		}
		snaps = append(snaps, snap{n, at})
	}
	sort.Slice(snaps, func(i, j int) bool { return snaps[i].at.After(snaps[j].at) })
	days := map[string]bool{}
	months := map[string]bool{}
	dayCutoff := now.UTC().AddDate(0, 0, -ret.Days)
	monthCutoff := now.UTC().AddDate(0, -ret.Months, 0)
	for i, s := range snaps {
		day, month := s.at.Format("2006-01-02"), s.at.Format("2006-01")
		switch {
		case i == 0, now.Sub(s.at) <= ret.Recent:
			keep[s.name] = true
		case s.at.After(dayCutoff) && !days[day]:
			keep[s.name] = true
		case s.at.After(monthCutoff) && !months[month]:
			keep[s.name] = true
		}
		days[day] = true
		months[month] = true
	}
	return keep
}

func snapshotNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && strings.HasPrefix(n, snapshotPrefix) && strings.HasSuffix(n, ".db") {
			out = append(out, n)
		}
	}
	return out
}

func newestSnapshot(dir string) (string, bool) {
	names := snapshotNames(dir)
	if len(names) == 0 {
		return "", false
	}
	sort.Strings(names) // the timestamp layout sorts in time order
	return names[len(names)-1], true
}

func quickCheck(path string) error {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var res string
	if err := db.QueryRow("PRAGMA quick_check").Scan(&res); err != nil {
		return err
	}
	if res != "ok" {
		return fmt.Errorf("snapshot failed quick_check: %s", res)
	}
	return nil
}

func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// copyFile writes via a temp name and renames, so a sync interrupted
// mid-copy never leaves a truncated file at the real name.
func copyFile(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := dest + ".partial"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}
