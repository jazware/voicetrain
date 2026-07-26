// Package backup mirrors the data dir to a backup destination (the
// NAS) from inside the server process. Living in the server is
// deliberate: new recordings can only appear while the server runs, and
// a child of the user's session inherits the network-volume permissions
// that macOS denies to launchd agents.
//
// WAVs are immutable, so a file is copied only if missing or
// size-mismatched at the destination. The SQLite database is
// snapshotted with VACUUM INTO (WAL-consistent) to a local temp file
// and then streamed over, so SQLite never has to lock a network file.
// Nothing is ever deleted from the backup.
package backup

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jazware/voicetrain/pkg/store"
)

const (
	checkInterval = 1 * time.Hour
	// SMB timestamps are coarse; only re-copy the DB when the local
	// file is clearly newer than the backup copy.
	dbSkew = 1 * time.Minute
)

// Runner periodically syncs the data dir. A nil *Runner is valid and
// does nothing.
type Runner struct {
	logger   *slog.Logger
	store    *store.Store
	dataDir  string
	destDir  string
	shareURL string
}

// NewRunner returns a runner, or nil when destDir is empty (disabled).
func NewRunner(logger *slog.Logger, st *store.Store, dataDir, destDir, shareURL string) *Runner {
	if destDir == "" {
		return nil
	}
	return &Runner{logger: logger, store: st, dataDir: dataDir, destDir: destDir, shareURL: shareURL}
}

// Start syncs once shortly after startup, then hourly until ctx ends.
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
		if err := r.runOnce(ctx); err != nil {
			r.logger.Warn("backup skipped", "error", err)
		}
		timer.Reset(checkInterval)
	}
}

func (r *Runner) runOnce(ctx context.Context) error {
	if err := r.ensureMounted(ctx); err != nil {
		return err
	}

	copied, err := r.syncRecordings()
	if err != nil {
		return fmt.Errorf("syncing recordings: %w", err)
	}
	dbCopied, err := r.syncDatabase()
	if err != nil {
		return fmt.Errorf("syncing database: %w", err)
	}

	if copied > 0 || dbCopied {
		r.logger.Info("backup ok", "new_recordings", copied, "db_updated", dbCopied,
			"dest", r.destDir)
	} else {
		r.logger.Debug("backup: nothing new")
	}
	return nil
}

// ensureMounted checks the destination exists, asking Finder to mount
// the share (using the keychain login) when it looks unmounted.
func (r *Runner) ensureMounted(ctx context.Context) error {
	if _, err := os.Stat(r.destDir); err == nil {
		return nil
	}
	if r.shareURL != "" {
		mountCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		script := fmt.Sprintf("mount volume %q", r.shareURL)
		if out, err := exec.CommandContext(mountCtx, "osascript", "-e", script).CombinedOutput(); err != nil {
			return fmt.Errorf("mounting %s: %v: %s", r.shareURL, err, out)
		}
	}
	if _, err := os.Stat(r.destDir); err != nil {
		return fmt.Errorf("backup destination unavailable: %w", err)
	}
	return nil
}

func (r *Runner) syncRecordings() (int, error) {
	srcRoot := filepath.Join(r.dataDir, "recordings")
	destRoot := filepath.Join(r.destDir, "recordings")
	copied := 0

	err := filepath.WalkDir(srcRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) && path == srcRoot {
				return filepath.SkipAll
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		// Finder droppings (.DS_Store etc.) aren't recordings.
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		rel, err := filepath.Rel(srcRoot, path)
		if err != nil {
			return err
		}
		srcInfo, err := d.Info()
		if err != nil {
			return err
		}
		destPath := filepath.Join(destRoot, rel)
		if destInfo, err := os.Stat(destPath); err == nil && destInfo.Size() == srcInfo.Size() {
			return nil // immutable WAV, already backed up
		}
		if err := copyFile(path, destPath); err != nil {
			return fmt.Errorf("copying %s: %w", rel, err)
		}
		copied++
		return nil
	})
	return copied, err
}

func (r *Runner) syncDatabase() (bool, error) {
	localInfo, err := os.Stat(filepath.Join(r.dataDir, "app.db"))
	if err != nil {
		return false, err
	}
	destPath := filepath.Join(r.destDir, "app.db")
	if destInfo, err := os.Stat(destPath); err == nil &&
		localInfo.ModTime().Before(destInfo.ModTime().Add(dbSkew)) {
		return false, nil
	}

	snap := filepath.Join(r.dataDir, fmt.Sprintf(".backup-snapshot-%d.db", time.Now().UnixNano()))
	defer os.Remove(snap)
	if err := r.store.SnapshotTo(snap); err != nil {
		return false, fmt.Errorf("snapshotting database: %w", err)
	}
	if err := copyFile(snap, destPath); err != nil {
		return false, err
	}
	return true, nil
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
