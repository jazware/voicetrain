package backup

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jazware/voicetrain/pkg/store"
)

func setup(t *testing.T, cfg Config) (*Runner, *store.Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	st, err := store.Open(filepath.Join(dataDir, "app.db"))
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	addTake(t, st, dataDir, "recordings/2026/07/1-aaaa.wav", "RIFF-take-one")
	if cfg.Dir == "" {
		cfg.Dir = t.TempDir()
	}
	r := NewRunner(slog.New(slog.NewTextHandler(io.Discard, nil)), st, dataDir, cfg)
	return r, st, dataDir
}

// addTake records a take row and writes its file, as the server does.
func addTake(t *testing.T, st *store.Store, dataDir, rel, body string) int64 {
	t.Helper()
	scripts, _ := st.ListScripts()
	id, err := st.CreateRecording(store.NewRecording{
		ScriptID: scripts[0].ID, DurationMs: 1000, SampleRate: 48000, Channels: 1,
		SizeBytes: int64(len(body)), RecordedAt: 1, LocalDay: "2026-07-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dataDir, rel), body)
	if err := st.SetRecordingFilePath(id, rel); err != nil {
		t.Fatal(err)
	}
	return id
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func list(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func snapshots(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	for _, f := range list(t, dir) {
		if strings.HasPrefix(f, "db/") {
			out = append(out, f)
		}
	}
	return out
}

func TestBackupMirrorsTakesAndSnapshotsChanges(t *testing.T) {
	r, st, _ := setup(t, Config{})
	clock := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return clock }

	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatalf("first run: %v", err)
	}
	got := list(t, r.cfg.Dir)
	want := []string{"app.db", "db/app-20261013T090000Z.db", "recordings/2026/07/1-aaaa.wav"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("after first run: %v, want %v", got, want)
	}
	snap, _ := os.ReadFile(filepath.Join(r.cfg.Dir, "app.db"))
	if !strings.HasPrefix(string(snap), "SQLite format 3") {
		t.Fatalf("app.db isn't a database")
	}
	if s := r.Status(); s.LastSuccessAt == nil || s.LastError != "" || s.Recordings != 1 || s.Snapshots != 1 {
		t.Fatalf("status after success: %+v", s)
	}

	// Nothing changed: no new snapshot.
	clock = clock.Add(time.Hour)
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := len(snapshots(t, r.cfg.Dir)); n != 1 {
		t.Fatalf("unchanged database made a snapshot: %d", n)
	}

	// A write lands in the WAL, not app.db's mtime: still snapshotted.
	scripts, _ := st.ListScripts()
	title := "Renamed"
	if _, err := st.UpdateScript(scripts[0].ID, store.ScriptParams{Title: &title}); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Hour)
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := len(snapshots(t, r.cfg.Dir)); n != 2 {
		t.Fatalf("a changed database wasn't snapshotted: %v", snapshots(t, r.cfg.Dir))
	}

	// A fresh runner (a restart) recognizes the newest snapshot.
	r2 := NewRunner(r.logger, st, r.dataDir, r.cfg)
	r2.now = func() time.Time { return clock.Add(time.Hour) }
	if err := r2.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := len(snapshots(t, r.cfg.Dir)); n != 2 {
		t.Fatalf("a restart re-snapshotted an unchanged database: %v", snapshots(t, r.cfg.Dir))
	}
}

func TestUnmountedShareIsRefusedAndNothingWritten(t *testing.T) {
	// The bare mount point: an empty local directory with no marker.
	bare := t.TempDir()
	r, _, _ := setup(t, Config{Dir: bare, RequireMarker: true})
	err := r.RunOnce(t.Context())
	if err == nil || !strings.Contains(err.Error(), Marker) {
		t.Fatalf("expected a refusal naming %s, got %v", Marker, err)
	}
	if files := list(t, bare); len(files) != 0 {
		t.Fatalf("wrote into an unmounted share: %v", files)
	}
	s := r.Status()
	if s.LastError == "" || s.LastSuccessAt != nil || s.LastAttemptAt == nil {
		t.Fatalf("status should show the failure: %+v", s)
	}

	// The real share has the marker.
	writeFile(t, filepath.Join(bare, Marker), "voicetrain backups\n")
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatalf("with the marker: %v", err)
	}
	if s := r.Status(); s.LastError != "" || s.LastSuccessAt == nil {
		t.Fatalf("status after recovery: %+v", s)
	}
}

func TestMissingDestinationFails(t *testing.T) {
	r, _, _ := setup(t, Config{Dir: filepath.Join(t.TempDir(), "not-there")})
	if err := r.RunOnce(t.Context()); err == nil {
		t.Fatal("a missing destination should fail the run")
	}
}

func TestTakesAreNeverOverwritten(t *testing.T) {
	r, _, _ := setup(t, Config{})
	// Another server's file, of a different size, already has the name.
	writeFile(t, filepath.Join(r.cfg.Dir, "recordings", "2026", "07", "1-aaaa.wav"), "RIFF-someone-else")
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(filepath.Join(r.cfg.Dir, "recordings", "2026", "07", "1-aaaa.wav"))
	if string(old) != "RIFF-someone-else" {
		t.Fatalf("an existing file was overwritten: %q", old)
	}
	if n := len(list(t, filepath.Join(r.cfg.Dir, "recordings"))); n != 2 {
		t.Fatalf("this server's take should be kept beside it: %v", list(t, r.cfg.Dir))
	}
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := len(list(t, filepath.Join(r.cfg.Dir, "recordings"))); n != 2 {
		t.Fatalf("expected 2 files, got %d", n)
	}
}

func TestBrokenTakeIsSkippedButTheDatabaseStillBacksUp(t *testing.T) {
	r, st, dataDir := setup(t, Config{})
	id := addTake(t, st, dataDir, "recordings/2026/07/2-bbbb.wav", "RIFF-the-whole-take")
	addTake(t, st, dataDir, "recordings/2026/07/3-cccc.wav", "RIFF-take-three")
	// Take 2's file is shorter than its row says: damaged.
	writeFile(t, filepath.Join(dataDir, "recordings", "2026", "07", "2-bbbb.wav"), "RIFF-the")
	err := r.RunOnce(t.Context())
	if err == nil || !strings.Contains(err.Error(), "2-bbbb.wav") {
		t.Fatalf("expected the run to fail naming take %d, got %v", id, err)
	}
	if _, err := os.Stat(filepath.Join(r.cfg.Dir, "recordings", "2026", "07", "2-bbbb.wav")); err == nil {
		t.Fatal("a damaged file reached the backup under the take's name")
	}
	for _, good := range []string{"1-aaaa.wav", "3-cccc.wav"} {
		if _, err := os.Stat(filepath.Join(r.cfg.Dir, "recordings", "2026", "07", good)); err != nil {
			t.Fatalf("the healthy take %s wasn't backed up", good)
		}
	}
	if n := len(snapshots(t, r.cfg.Dir)); n != 1 {
		t.Fatal("one damaged take must not stop the database backup")
	}
	s := r.Status()
	if len(s.BadTakes) != 1 || s.BadTakes[0] != id || s.LastError == "" || s.LastSuccessAt != nil {
		t.Fatalf("status should list the bad take and count the run failed: %+v", s)
	}
}

// Every snapshot on the backup must restore: each of its rows has its
// take in the backup, at the row's size. Covers reused ids too: SQLite
// hands a deleted newest id to the next take, which now gets its own
// file name.
func TestEverySnapshotRestores(t *testing.T) {
	r, st, dataDir := setup(t, Config{})
	clock := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return clock }
	id := addTake(t, st, dataDir, "recordings/2026/07/2-bbbb.wav", "RIFF-take-two")
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteRecording(id); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(dataDir, "recordings", "2026", "07", "2-bbbb.wav"))
	reused := addTake(t, st, dataDir, "recordings/2026/07/2-cccc.wav", "RIFF-a-new-take-two")
	if reused != id {
		t.Logf("SQLite didn't reuse id %d (got %d); the test still checks the restore", id, reused)
	}
	clock = clock.Add(time.Hour)
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}

	snaps := snapshots(t, r.cfg.Dir)
	if len(snaps) != 2 {
		t.Fatalf("expected 2 snapshots, got %v", snaps)
	}
	for _, snap := range snaps {
		// Restore it: a fresh data dir with the backup's takes and the snapshot.
		restored := t.TempDir()
		raw, _ := os.ReadFile(filepath.Join(r.cfg.Dir, snap))
		writeFile(t, filepath.Join(restored, "app.db"), string(raw))
		for _, f := range list(t, filepath.Join(r.cfg.Dir, "recordings")) {
			body, _ := os.ReadFile(filepath.Join(r.cfg.Dir, "recordings", f))
			writeFile(t, filepath.Join(restored, "recordings", f), string(body))
		}
		rst, err := store.Open(filepath.Join(restored, "app.db"))
		if err != nil {
			t.Fatalf("%s doesn't open: %v", snap, err)
		}
		recs, err := rst.ListRecordings(store.RecordingFilter{Limit: 500})
		rst.Close()
		if err != nil || len(recs) != 2 {
			t.Fatalf("%s: %d takes, %v", snap, len(recs), err)
		}
		for _, rec := range recs {
			info, err := os.Stat(filepath.Join(restored, rec.FilePath))
			if err != nil || info.Size() != rec.SizeBytes {
				t.Fatalf("%s: take %d (%s) has no matching file in the backup", snap, rec.ID, rec.FilePath)
			}
		}
		rep, err := Verify(filepath.Join(restored, "app.db"), restored, "", false)
		if err != nil || len(rep.Problems) != 0 || rep.OK != 2 {
			t.Fatalf("%s: verify: %+v %v", snap, rep, err)
		}
	}
}

func TestVerifyFindsAndFixesFromTheBackup(t *testing.T) {
	r, _, dataDir := setup(t, Config{})
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	// Lose the take locally, and leave a stray file nothing names.
	os.Remove(filepath.Join(dataDir, "recordings", "2026", "07", "1-aaaa.wav"))
	writeFile(t, filepath.Join(dataDir, "recordings", "2026", "07", "9-zzzz.wav"), "RIFF-stray")
	rep, err := Verify(filepath.Join(dataDir, "app.db"), dataDir, r.cfg.Dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Problems) != 1 || rep.Problems[0].Got != -1 || rep.Problems[0].Candidate == "" {
		t.Fatalf("expected one missing take with a backup candidate: %+v", rep)
	}
	if len(rep.Orphans) != 1 || rep.Orphans[0] != "recordings/2026/07/9-zzzz.wav" {
		t.Fatalf("expected the stray file as an orphan: %+v", rep.Orphans)
	}
	rep, err = Verify(filepath.Join(dataDir, "app.db"), dataDir, r.cfg.Dir, true)
	if err != nil || rep.Fixed != 1 || len(rep.Problems) != 0 {
		t.Fatalf("fix: %+v %v", rep, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "recordings", "2026", "07", "9-zzzz.wav")); err != nil {
		t.Fatal("verify must never delete an orphan")
	}
}

func TestVerifyFixKeepsTheFileItReplaces(t *testing.T) {
	r, _, dataDir := setup(t, Config{})
	if err := r.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(dataDir, "recordings", "2026", "07", "1-aaaa.wav")
	writeFile(t, live, "RIFF-damaged-longer-than-it-should-be")
	now = func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) }
	defer func() { now = time.Now }()
	rep, err := Verify(filepath.Join(dataDir, "app.db"), dataDir, r.cfg.Dir, true)
	if err != nil || rep.Fixed != 1 || len(rep.MovedAside) != 1 {
		t.Fatalf("fix: %+v %v", rep, err)
	}
	if got, _ := os.ReadFile(live); string(got) != "RIFF-take-one" {
		t.Fatalf("the backup's copy wasn't restored: %q", got)
	}
	aside, err := os.ReadFile(live + ".replaced-20261013T120000Z")
	if err != nil || string(aside) != "RIFF-damaged-longer-than-it-should-be" {
		t.Fatalf("the replaced file wasn't kept: %q %v", aside, err)
	}
}

func TestLeftoverTempSnapshotsAreCleaned(t *testing.T) {
	dataDir := t.TempDir()
	st, err := store.Open(filepath.Join(dataDir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	writeFile(t, filepath.Join(dataDir, ".backup-snapshot-123.db"), "left by a crash")
	NewRunner(slog.New(slog.NewTextHandler(io.Discard, nil)), st, dataDir, Config{Dir: t.TempDir()})
	if _, err := os.Stat(filepath.Join(dataDir, ".backup-snapshot-123.db")); err == nil {
		t.Fatal("leftover snapshot not removed")
	}
}

func TestRetentionKeepsRecentDailyMonthly(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	name := func(t time.Time) string { return "app-" + t.Format(snapshotLayout) + ".db" }
	var names []string
	// Every 6 hours for 400 days.
	for at := now; at.After(now.AddDate(0, 0, -400)); at = at.Add(-6 * time.Hour) {
		names = append(names, name(at))
	}
	names = append(names, "app-not-a-time.db")
	keep := Keep(names, now, DefaultRetention)

	recent, daily, monthly := 0, 0, 0
	for n := range keep {
		if n == "app-not-a-time.db" {
			continue
		}
		at, _ := time.Parse(snapshotLayout, strings.TrimSuffix(strings.TrimPrefix(n, "app-"), ".db"))
		switch age := now.Sub(at); {
		case age <= 24*time.Hour:
			recent++
		case age <= 30*24*time.Hour:
			daily++
		default:
			monthly++
		}
	}
	if recent != 5 || daily < 29 || daily > 31 || monthly < 11 || monthly > 12 {
		t.Fatalf("kept recent=%d daily=%d monthly=%d", recent, daily, monthly)
	}
	if !keep["app-not-a-time.db"] {
		t.Fatal("an unknown file must never be deleted")
	}
	if !keep[name(now)] {
		t.Fatal("the newest snapshot must be kept")
	}
	// Only one, very old: still kept.
	old := []string{name(now.AddDate(-3, 0, 0))}
	if !Keep(old, now, DefaultRetention)[old[0]] {
		t.Fatal("the only snapshot must be kept however old")
	}
}

func TestDisabledRunnerIsANoOp(t *testing.T) {
	var disabled *Runner
	disabled.Start(t.Context())
	if s := disabled.Status(); s.Enabled {
		t.Fatalf("nil runner reports enabled: %+v", s)
	}
}
