package store

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func strPtr(v string) *string { return &v }

func rawPtr(v string) *json.RawMessage {
	r := json.RawMessage(v)
	return &r
}

func TestMigrateAndSeedIdempotent(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	scripts, err := s.ListScripts()
	if err != nil {
		t.Fatalf("listing scripts: %v", err)
	}
	seeded := len(scripts)
	if seeded != len(seedScripts) {
		t.Fatalf("expected %d seeded scripts, got %d", len(seedScripts), seeded)
	}
	s.Close()

	// Re-open: migrations and seeds must be no-ops.
	s2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer s2.Close()
	scripts, err = s2.ListScripts()
	if err != nil {
		t.Fatalf("listing scripts after reopen: %v", err)
	}
	if len(scripts) != seeded {
		t.Fatalf("expected %d scripts after reopen, got %d", seeded, len(scripts))
	}
}

func TestScriptCRUD(t *testing.T) {
	s := testStore(t)

	created, err := s.CreateScript(ScriptParams{
		Title:       strPtr("My Passage"),
		Body:        strPtr("Hello world."),
		FocusPoints: rawPtr(`["pitch","resonance"]`),
	})
	if err != nil {
		t.Fatalf("creating script: %v", err)
	}
	if created.IsSeeded {
		t.Error("user script must not be seeded")
	}

	updated, err := s.UpdateScript(created.ID, ScriptParams{Title: strPtr("Renamed")})
	if err != nil {
		t.Fatalf("updating script: %v", err)
	}
	if updated.Title != "Renamed" || updated.Body != "Hello world." {
		t.Errorf("partial update wrong: title=%q body=%q", updated.Title, updated.Body)
	}
	if string(updated.FocusPoints) != `["pitch","resonance"]` {
		t.Errorf("focus_points not preserved: %s", updated.FocusPoints)
	}

	if err := s.DeleteScript(created.ID); err != nil {
		t.Fatalf("deleting script: %v", err)
	}
	scripts, err := s.ListScripts()
	if err != nil {
		t.Fatalf("listing scripts: %v", err)
	}
	for _, sc := range scripts {
		if sc.ID == created.ID {
			t.Error("soft-deleted script still listed")
		}
	}
	// Soft-deleted scripts stay fetchable for old takes.
	got, err := s.GetScript(created.ID)
	if err != nil {
		t.Fatalf("getting soft-deleted script: %v", err)
	}
	if got.DeletedAt == nil {
		t.Error("expected deleted_at to be set")
	}

	if err := s.DeleteScript(created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("double delete: want ErrNotFound, got %v", err)
	}
}

func TestScriptValidation(t *testing.T) {
	s := testStore(t)

	if _, err := s.CreateScript(ScriptParams{Title: strPtr("no body")}); !errors.Is(err, ErrInvalid) {
		t.Errorf("missing body: want ErrInvalid, got %v", err)
	}
	if _, err := s.CreateScript(ScriptParams{
		Title:       strPtr("t"),
		Body:        strPtr("b"),
		FocusPoints: rawPtr(`{"not":"an array"}`),
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("bad focus_points: want ErrInvalid, got %v", err)
	}
	if _, err := s.GetScript(99999); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing script: want ErrNotFound, got %v", err)
	}
}

func TestSettings(t *testing.T) {
	s := testStore(t)

	settings, err := s.GetSettings()
	if err != nil {
		t.Fatalf("getting settings: %v", err)
	}
	if settings.TargetMinHz != 165 || settings.TargetMaxHz != 220 {
		t.Errorf("defaults wrong: %+v", settings)
	}

	if err := s.PutSettings(Settings{TargetMinHz: 175, TargetMaxHz: 235}); err != nil {
		t.Fatalf("putting settings: %v", err)
	}
	settings, err = s.GetSettings()
	if err != nil {
		t.Fatalf("re-getting settings: %v", err)
	}
	if settings.TargetMinHz != 175 || settings.TargetMaxHz != 235 {
		t.Errorf("update not persisted: %+v", settings)
	}

	if err := s.PutSettings(Settings{TargetMinHz: 300, TargetMaxHz: 200}); !errors.Is(err, ErrInvalid) {
		t.Errorf("inverted band: want ErrInvalid, got %v", err)
	}
}

func TestRecordingAnalysis(t *testing.T) {
	s := testStore(t)
	scripts, err := s.ListScripts()
	if err != nil || len(scripts) == 0 {
		t.Fatalf("listing scripts: %v", err)
	}

	newRec := func() int64 {
		id, err := s.CreateRecording(NewRecording{
			ScriptID: scripts[0].ID, DurationMs: 1000, SampleRate: 48000,
			Channels: 1, SizeBytes: 96000, RecordedAt: 1700000000000, LocalDay: "2026-07-19",
		})
		if err != nil {
			t.Fatalf("creating recording: %v", err)
		}
		if err := s.SetRecordingFilePath(id, "recordings/2026/07/test.wav"); err != nil {
			t.Fatalf("setting file path: %v", err)
		}
		return id
	}
	id1, id2 := newRec(), newRec()

	// Both need analysis initially.
	ids, err := s.ListRecordingIDsNeedingAnalysis(1)
	if err != nil {
		t.Fatalf("listing needing analysis: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 needing analysis, got %v", ids)
	}

	endMs := int64(2000)
	err = s.SetRecordingAnalysis(id1, json.RawMessage(`{"version":1,"pitch":{"median_hz":180}}`),
		[]NewAnnotation{
			{StartMs: 100, EndMs: &endMs, Kind: "fry", Payload: json.RawMessage(`{"median_hz":80}`)},
			{StartMs: 500, Kind: "monotone"},
		})
	if err != nil {
		t.Fatalf("setting analysis: %v", err)
	}

	rec, err := s.GetRecording(id1)
	if err != nil {
		t.Fatalf("getting recording: %v", err)
	}
	if rec.Analysis == nil || rec.AnalyzedAt == nil {
		t.Fatalf("analysis not stored: %+v", rec)
	}
	anns, err := s.ListAnnotations(id1)
	if err != nil || len(anns) != 2 {
		t.Fatalf("expected 2 annotations, got %v err %v", anns, err)
	}
	if anns[0].Kind != "fry" || anns[0].EndMs == nil || *anns[0].EndMs != 2000 {
		t.Fatalf("unexpected first annotation: %+v", anns[0])
	}

	// Re-analysis replaces auto annotations rather than stacking them.
	if err := s.SetRecordingAnalysis(id1, json.RawMessage(`{"version":1}`),
		[]NewAnnotation{{StartMs: 1, Kind: "long_phrase"}}); err != nil {
		t.Fatalf("re-setting analysis: %v", err)
	}
	anns, _ = s.ListAnnotations(id1)
	if len(anns) != 1 || anns[0].Kind != "long_phrase" {
		t.Fatalf("expected replaced annotations, got %+v", anns)
	}

	// Version-aware backfill selection (exercises json_extract).
	ids, err = s.ListRecordingIDsNeedingAnalysis(1)
	if err != nil {
		t.Fatalf("listing after analysis: %v", err)
	}
	if len(ids) != 1 || ids[0] != id2 {
		t.Fatalf("expected only unanalyzed recording, got %v", ids)
	}
	ids, err = s.ListRecordingIDsNeedingAnalysis(2)
	if err != nil {
		t.Fatalf("listing with newer version: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("version bump should re-select all, got %v", ids)
	}

	if err := s.SetRecordingAnalysis(9999, json.RawMessage(`{}`), nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for missing recording, got %v", err)
	}
}
