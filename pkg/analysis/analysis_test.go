package analysis

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jazware/voicetrain/pkg/store"
)

// fakeAnalyzer writes a shell script that behaves like analyze.py
// --jsonl: a document per file, an error for files named *bad.wav,
// nothing at all for *lost.wav, and it logs each invocation's file count.
func fakeAnalyzer(t *testing.T, dir string) (cmd string, calls func() []int) {
	t.Helper()
	log := filepath.Join(dir, "calls.log")
	script := filepath.Join(dir, "analyze.sh")
	body := `#!/bin/sh
if [ "$1" = "--version" ]; then echo ` + "2" + `; exit 0; fi
n=0
for a in "$@"; do case "$a" in *.wav) n=$((n+1));; esac; done
echo $n >> ` + log + `
for a in "$@"; do
  case "$a" in
    *bad.wav) printf '{"file":"%s","error":"ValueError: not a wav"}\n' "$a";;
    *lost.wav) ;;
    *.wav) printf '{"file":"%s","version":2,"pitch":{"median_hz":180},"events":[{"start_ms":10,"end_ms":20,"kind":"fry","payload":{}}]}\n' "$a";;
  esac
done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, func() []int {
		raw, _ := os.ReadFile(log)
		var out []int
		for _, l := range strings.Fields(string(raw)) {
			var n int
			_ = json.Unmarshal([]byte(l), &n)
			out = append(out, n)
		}
		return out
	}
}

func newTake(t *testing.T, st *store.Store, name string) int64 {
	t.Helper()
	scripts, _ := st.ListScripts()
	id, err := st.CreateRecording(store.NewRecording{
		ScriptID: scripts[0].ID, DurationMs: 1000, SampleRate: 48000, Channels: 1,
		SizeBytes: 1, RecordedAt: 1, LocalDay: "2026-07-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetRecordingFilePath(id, filepath.Join("recordings", name)); err != nil {
		t.Fatal(err)
	}
	return id
}

func waitIdle(t *testing.T, r *Runner) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := r.Status()
		if st.Queued == 0 && st.Running == 0 && st.Analyzed+int64(st.FailedTakes) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("runner never went idle: %+v", r.Status())
}

func TestRunnerBatchesAndRecordsFailures(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cmd, calls := fakeAnalyzer(t, dir)

	good := []int64{newTake(t, st, "1.wav"), newTake(t, st, "2.wav"), newTake(t, st, "3.wav")}
	bad := newTake(t, st, "4bad.wav")
	lost := newTake(t, st, "5lost.wav")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := NewRunner(ctx, logger, st, dir, Config{Command: cmd, Workers: 1, BatchSize: 4})
	if r == nil || r.imageVersion != 2 {
		t.Fatalf("runner not started or version not probed: %+v", r)
	}
	r.Backfill()
	waitIdle(t, r)

	if got := calls(); len(got) != 2 || got[0] != 4 || got[1] != 1 {
		t.Fatalf("expected batches of 4 then 1, got %v", got)
	}
	for _, id := range good {
		rec, _ := st.GetRecording(id)
		if rec.Analysis == nil || rec.AnalysisError != nil {
			t.Fatalf("take %d not analyzed: %+v", id, rec)
		}
		var doc map[string]any
		_ = json.Unmarshal(rec.Analysis, &doc)
		if _, ok := doc["file"]; ok {
			t.Fatalf("batch-only file key leaked into the stored document")
		}
		anns, _ := st.ListAnnotations(id)
		if len(anns) != 1 || anns[0].Kind != "fry" {
			t.Fatalf("events not stored: %+v", anns)
		}
	}
	for id, want := range map[int64]string{bad: "not a wav", lost: "no result"} {
		rec, _ := st.GetRecording(id)
		if rec.Analysis != nil || rec.AnalysisError == nil || !strings.Contains(*rec.AnalysisError, want) {
			t.Fatalf("take %d: want error containing %q, got %+v", id, want, rec)
		}
	}
	if s := r.Status(); s.Analyzed != 3 || s.FailedTakes != 2 || s.LastError == "" {
		t.Fatalf("unexpected counts: %+v", s)
	}

	// A retry that works clears the count (it's the database's, not a
	// running total).
	if err := st.SetRecordingAnalysis(bad, json.RawMessage(`{"version":2}`), nil); err != nil {
		t.Fatal(err)
	}
	if s := r.Status(); s.FailedTakes != 1 {
		t.Fatalf("failed count should follow the database: %+v", s)
	}
}

func TestRunnerPutsNewTakesBeforeBackfill(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	r := &Runner{batchSize: 2, wake: make(chan struct{}, 1), queued: map[int64]bool{}, running: map[int64]bool{}, store: st}
	r.backfill = []int64{30, 20, 10}
	for _, id := range r.backfill {
		r.queued[id] = true
	}
	r.Enqueue(99)
	r.Enqueue(20) // already queued for backfill: jumps ahead
	if b := r.next(); len(b) != 2 || b[0] != 99 || b[1] != 20 {
		t.Fatalf("urgent takes should go first, got %v", b)
	}
	if b := r.next(); len(b) != 2 || b[0] != 30 || b[1] != 10 {
		t.Fatalf("then the rest of the backfill, newest first, got %v", b)
	}
}

// slowAnalyzer is fakeAnalyzer with a pause per file and a log of each
// file's start and end, to see overlaps.
func slowAnalyzer(t *testing.T, dir string, pause string) (cmd string, events func() []string) {
	t.Helper()
	log := filepath.Join(dir, "events.log")
	script := filepath.Join(dir, "slow.sh")
	body := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 2; exit 0; fi
for a in "$@"; do
  case "$a" in
    *.wav)
      echo "start $(basename "$a")" >> ` + log + `
      sleep ` + pause + `
      echo "end $(basename "$a")" >> ` + log + `
      printf '{"file":"%s","version":2,"events":[]}\n' "$a";;
  esac
done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, func() []string {
		raw, _ := os.ReadFile(log)
		return strings.Split(strings.TrimSpace(string(raw)), "\n")
	}
}

func TestReEnqueueWhileRunningNeverOverlaps(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cmd, events := slowAnalyzer(t, dir, "0.3")
	id := newTake(t, st, "7.wav")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := NewRunner(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), st, dir, Config{Command: cmd, Workers: 3, BatchSize: 1})
	r.Enqueue(id)
	deadline := time.Now().Add(5 * time.Second)
	for r.Status().Running == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	r.Enqueue(id) // a re-listen while it runs
	r.Enqueue(id) // and an impatient second click
	for time.Now().Before(deadline) {
		if s := r.Status(); s.Queued == 0 && s.Running == 0 && s.Analyzed >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got := events()
	want := []string{"start 7.wav", "end 7.wav", "start 7.wav", "end 7.wav"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("runs overlapped or repeated: %v", got)
	}
}

func TestShutdownDoesNotMarkTakesFailed(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cmd, _ := slowAnalyzer(t, dir, "5")
	ids := []int64{newTake(t, st, "1.wav"), newTake(t, st, "2.wav")}

	ctx, cancel := context.WithCancel(context.Background())
	r := NewRunner(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), st, dir, Config{Command: cmd, Workers: 2, BatchSize: 1})
	for _, id := range ids {
		r.Enqueue(id)
	}
	deadline := time.Now().Add(5 * time.Second)
	for r.Status().Running < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel() // SIGTERM
	done := make(chan struct{})
	go func() { r.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait didn't return after shutdown")
	}
	for _, id := range ids {
		rec, _ := st.GetRecording(id)
		if rec.AnalysisError != nil {
			t.Fatalf("take %d marked failed by shutdown: %s", id, *rec.AnalysisError)
		}
	}
}
