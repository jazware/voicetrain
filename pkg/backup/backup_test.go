package backup

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/jazware/voicetrain/pkg/store"
)

func TestSyncRecordingsAndDatabase(t *testing.T) {
	dataDir := t.TempDir()
	destDir := t.TempDir()

	st, err := store.Open(filepath.Join(dataDir, "app.db"))
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	wavPath := filepath.Join(dataDir, "recordings", "2026", "07", "1.wav")
	if err := os.MkdirAll(filepath.Dir(wavPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wavPath, []byte("RIFF-fake-wav"), 0o644); err != nil {
		t.Fatal(err)
	}

	r := NewRunner(slog.Default(), st, dataDir, destDir, "")

	copied, err := r.syncRecordings()
	if err != nil || copied != 1 {
		t.Fatalf("first sync: copied=%d err=%v, want 1", copied, err)
	}
	got, err := os.ReadFile(filepath.Join(destDir, "recordings", "2026", "07", "1.wav"))
	if err != nil || string(got) != "RIFF-fake-wav" {
		t.Fatalf("backed-up wav mismatch: %q err=%v", got, err)
	}

	// Immutable file already present: second pass copies nothing.
	copied, err = r.syncRecordings()
	if err != nil || copied != 0 {
		t.Fatalf("second sync: copied=%d err=%v, want 0", copied, err)
	}

	dbCopied, err := r.syncDatabase()
	if err != nil || !dbCopied {
		t.Fatalf("first db sync: copied=%v err=%v, want true", dbCopied, err)
	}
	snap, err := os.ReadFile(filepath.Join(destDir, "app.db"))
	if err != nil || len(snap) < 16 || string(snap[:15]) != "SQLite format 3" {
		t.Fatalf("db snapshot invalid (len %d): %v", len(snap), err)
	}

	// Backup newer than local DB: skipped.
	dbCopied, err = r.syncDatabase()
	if err != nil || dbCopied {
		t.Fatalf("second db sync: copied=%v err=%v, want false", dbCopied, err)
	}

	// A nil runner (backups disabled) is a no-op everywhere.
	var disabled *Runner
	disabled.Start(t.Context())
}

func TestCopyFileLeavesNoPartial(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dest := filepath.Join(dir, "nested", "dest")
	if err := os.WriteFile(src, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dest); err != nil {
		t.Fatalf("copyFile: %v", err)
	}
	if _, err := os.Stat(dest + ".partial"); !os.IsNotExist(err) {
		t.Fatalf("partial file left behind: %v", err)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "hello" {
		t.Fatalf("dest content %q", got)
	}
}
