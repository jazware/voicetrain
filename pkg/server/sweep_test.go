package server

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestSweepStaleRemovesOnlyOldLeftovers(t *testing.T) {
	data, tmp := t.TempDir(), t.TempDir()
	now := time.Now()
	write := func(path string, age time.Duration) {
		t.Helper()
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte("x"), 0o644)
		os.Chtimes(path, now.Add(-age), now.Add(-age))
	}
	rec := filepath.Join(data, "recordings", "2026", "10")
	write(filepath.Join(tmp, "multipart-111"), 2*time.Hour)
	write(filepath.Join(tmp, "multipart-222"), time.Minute) // an upload in flight
	write(filepath.Join(tmp, "unrelated"), 2*time.Hour)
	write(filepath.Join(rec, "5-aaaa.wav.partial"), 2*time.Hour)
	write(filepath.Join(rec, "6-bbbb.wav.partial"), time.Minute) // being written
	write(filepath.Join(rec, "7-cccc.wav"), 2*time.Hour)

	got := SweepStale(data, tmp, time.Hour, now)
	sort.Strings(got)
	want := []string{filepath.Join(rec, "5-aaaa.wav.partial"), filepath.Join(tmp, "multipart-111")}
	sort.Strings(want)
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("removed %v, want %v", got, want)
	}
	for _, keep := range []string{filepath.Join(tmp, "multipart-222"), filepath.Join(tmp, "unrelated"), filepath.Join(rec, "6-bbbb.wav.partial"), filepath.Join(rec, "7-cccc.wav")} {
		if _, err := os.Stat(keep); err != nil {
			t.Errorf("%s should have been kept", keep)
		}
	}
}
