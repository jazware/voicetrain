package server

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SweepStale removes what a crash can leave behind, once it's older than
// olderThan so nothing in use is touched: Go's multipart spill files in
// the temp dir and half-written takes (*.wav.partial) under recordings/.
// It returns what it removed.
func SweepStale(dataDir, tempDir string, olderThan time.Duration, now time.Time) []string {
	var removed []string
	old := func(path string) bool {
		info, err := os.Lstat(path)
		return err == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > olderThan
	}
	if spills, err := filepath.Glob(filepath.Join(tempDir, "multipart-*")); err == nil {
		for _, f := range spills {
			if old(f) && os.Remove(f) == nil {
				removed = append(removed, f)
			}
		}
	}
	_ = filepath.WalkDir(filepath.Join(dataDir, "recordings"), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(d.Name(), ".wav.partial") && old(path) && os.Remove(path) == nil {
			removed = append(removed, path)
		}
		return nil
	})
	return removed
}
