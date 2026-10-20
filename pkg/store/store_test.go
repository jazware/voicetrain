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

func TestAnalysisHistoryKeepsEachVersion(t *testing.T) {
	s := testStore(t)
	scripts, err := s.ListScripts()
	if err != nil || len(scripts) == 0 {
		t.Fatalf("listing scripts: %v", err)
	}
	id, err := s.CreateRecording(NewRecording{
		ScriptID: scripts[0].ID, DurationMs: 1000, SampleRate: 48000,
		Channels: 1, SizeBytes: 96000, RecordedAt: 1700000000000, LocalDay: "2026-07-19",
	})
	if err != nil {
		t.Fatalf("creating recording: %v", err)
	}

	set := func(doc string) {
		t.Helper()
		if err := s.SetRecordingAnalysis(id, json.RawMessage(doc), nil); err != nil {
			t.Fatalf("setting %s: %v", doc, err)
		}
	}
	versions := func() []int {
		t.Helper()
		hist, err := s.ListAnalysisHistory(id)
		if err != nil {
			t.Fatalf("listing history: %v", err)
		}
		out := []int{}
		for _, h := range hist {
			out = append(out, h.Version)
		}
		return out
	}

	set(`{"version":1,"pitch":{"median_hz":150}}`)
	set(`{"version":1,"pitch":{"median_hz":151}}`) // re-listen: replaced in place
	if v := versions(); len(v) != 0 {
		t.Fatalf("same-version re-run should not archive, got %v", v)
	}

	set(`{"version":2,"pitch":{"median_hz":152}}`)
	set(`{"version":2,"pitch":{"median_hz":153}}`)
	set(`{"version":3}`)
	if v := versions(); len(v) != 2 || v[0] != 1 || v[1] != 2 {
		t.Fatalf("expected archived versions [1 2], got %v", v)
	}
	hist, _ := s.ListAnalysisHistory(id)
	if string(hist[0].Analysis) != `{"version":1,"pitch":{"median_hz":151}}` {
		t.Fatalf("archived v1 should be the last v1 document, got %s", hist[0].Analysis)
	}

	// Going back to an older analyzer (an older binary) keeps the newer
	// document too, and never archives a version twice.
	set(`{"version":2}`)
	set(`{"version":3}`)
	if v := versions(); len(v) != 3 || v[2] != 3 {
		t.Fatalf("expected archived versions [1 2 3], got %v", v)
	}

	if err := s.DeleteRecording(id); err != nil {
		t.Fatalf("deleting: %v", err)
	}
	if v := versions(); len(v) != 0 {
		t.Fatalf("history should go with the take, got %v", v)
	}
}

func TestTrendsPullHeadlineNumbers(t *testing.T) {
	s := testStore(t)
	scripts, _ := s.ListScripts()
	mk := func(at int64, day string, stats string) int64 {
		id, err := s.CreateRecording(NewRecording{
			ScriptID: scripts[0].ID, DurationMs: 60000, SampleRate: 48000, Channels: 1,
			SizeBytes: 1, RecordedAt: at, LocalDay: day, PitchStats: json.RawMessage(stats),
		})
		if err != nil {
			t.Fatalf("creating: %v", err)
		}
		return id
	}
	late := mk(2000, "2026-07-02", `{"median_hz":171.5,"pct_in_band":0.5}`)
	early := mk(1000, "2026-07-01", "")
	if err := s.SetRecordingAnalysis(late, json.RawMessage(
		`{"version":2,"pitch":{"median_hz":170.2,"pct_in_band":48.0,"fry_pct":1.5},"resonance":{"estimated_vtl_cm":17.9},"melody":{"semitone_sd":2.4},"contour":[{"t":0,"hz":170}]}`), nil); err != nil {
		t.Fatalf("analysis: %v", err)
	}
	pts, err := s.Trends(nil)
	if err != nil {
		t.Fatalf("trends: %v", err)
	}
	if len(pts) != 2 || pts[0].ID != early || pts[1].ID != late {
		t.Fatalf("expected oldest first, got %+v", pts)
	}
	if pts[0].MedianHz != nil || pts[0].LiveMedianHz != nil {
		t.Fatalf("unanalyzed take should have null metrics: %+v", pts[0])
	}
	p := pts[1]
	if *p.MedianHz != 170.2 || *p.PctInBand != 48 || *p.FryPct != 1.5 || *p.VtlCm != 17.9 || *p.SemitoneSD != 2.4 || *p.LiveMedianHz != 171.5 {
		t.Fatalf("unexpected metrics: %+v", p)
	}
	other := scripts[1].ID
	if pts, _ := s.Trends(&other); len(pts) != 0 {
		t.Fatalf("script filter ignored: %+v", pts)
	}
}

func TestAnalysisErrorIsKeptUntilAnalysisLands(t *testing.T) {
	s := testStore(t)
	scripts, _ := s.ListScripts()
	id, err := s.CreateRecording(NewRecording{
		ScriptID: scripts[0].ID, DurationMs: 1000, SampleRate: 48000, Channels: 1,
		SizeBytes: 1, RecordedAt: 1, LocalDay: "2026-07-01",
	})
	if err != nil {
		t.Fatalf("creating: %v", err)
	}
	if err := s.SetRecordingAnalysisError(id, "sidecar exploded"); err != nil {
		t.Fatalf("setting error: %v", err)
	}
	rec, _ := s.GetRecording(id)
	if rec.AnalysisError == nil || *rec.AnalysisError != "sidecar exploded" || rec.AnalysisErrorAt == nil {
		t.Fatalf("error not stored: %+v", rec)
	}
	if err := s.SetRecordingAnalysis(id, json.RawMessage(`{"version":2}`), nil); err != nil {
		t.Fatalf("setting analysis: %v", err)
	}
	rec, _ = s.GetRecording(id)
	if rec.AnalysisError != nil || rec.AnalysisErrorAt != nil {
		t.Fatalf("error should clear when analysis lands: %+v", rec)
	}
	if err := s.SetRecordingAnalysisError(9999, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestListRecordingIDsWithAnalysisErrors(t *testing.T) {
	s := testStore(t)
	scripts, _ := s.ListScripts()
	mk := func() int64 {
		id, err := s.CreateRecording(NewRecording{ScriptID: scripts[0].ID, DurationMs: 1, SampleRate: 48000,
			Channels: 1, SizeBytes: 1, RecordedAt: 1, LocalDay: "2026-07-01"})
		if err != nil {
			t.Fatal(err)
		}
		_ = s.SetRecordingFilePath(id, "recordings/x.wav")
		return id
	}
	a, b, _ := mk(), mk(), mk()
	_ = s.SetRecordingAnalysisError(a, "boom")
	_ = s.SetRecordingAnalysisError(b, "boom")
	_ = s.SetRecordingAnalysis(b, json.RawMessage(`{"version":2}`), nil)
	ids, err := s.ListRecordingIDsWithAnalysisErrors()
	if err != nil || len(ids) != 1 || ids[0] != a {
		t.Fatalf("expected only %d, got %v (%v)", a, ids, err)
	}
}

func TestExercisesAreSeededWithKinds(t *testing.T) {
	s := testStore(t)
	scripts, err := s.ListScripts()
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, sc := range scripts {
		kinds[sc.Title] = sc.Kind
	}
	for title, want := range map[string]string{
		"The Rainbow Passage": KindPassage, "Sirens": KindSiren,
		"Sustained “ah”": KindSustain, "Hold the band": KindHold,
	} {
		if kinds[title] != want {
			t.Errorf("%s: kind %q, want %q", title, kinds[title], want)
		}
	}
	created, err := s.CreateScript(ScriptParams{Title: strPtr("Mine"), Body: strPtr("words")})
	if err != nil || created.Kind != KindPassage {
		t.Fatalf("a new script is a passage: %+v %v", created, err)
	}

	// Exercise measures come back in the trends, with the kind.
	var siren int64
	for _, sc := range scripts {
		if sc.Kind == KindSiren {
			siren = sc.ID
		}
	}
	id, err := s.CreateRecording(NewRecording{
		ScriptID: siren, DurationMs: 20000, SampleRate: 48000, Channels: 1, SizeBytes: 1,
		RecordedAt: 1, LocalDay: "2026-10-13",
		PitchStats: json.RawMessage(`{"median_hz":200,"pct_in_band":0.4,"range_st":14.5,"longest_hold_s":3.2,"hold_sd_cents":22,"longest_in_band_s":5}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	pts, _ := s.Trends(nil)
	if len(pts) != 1 || pts[0].ID != id || pts[0].Kind != KindSiren || *pts[0].RangeSt != 14.5 ||
		*pts[0].HoldS != 3.2 || *pts[0].HoldCents != 22 || *pts[0].StreakS != 5 {
		t.Fatalf("unexpected trend point: %+v", pts)
	}
}
