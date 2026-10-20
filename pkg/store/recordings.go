package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

type Recording struct {
	ID         int64           `json:"id"`
	ScriptID   int64           `json:"script_id"`
	FilePath   string          `json:"file_path"`
	DurationMs int64           `json:"duration_ms"`
	SampleRate int             `json:"sample_rate"`
	Channels   int             `json:"channels"`
	SizeBytes  int64           `json:"size_bytes"`
	Rating     *int64          `json:"rating"`
	Notes      string          `json:"notes"`
	PitchStats json.RawMessage `json:"pitch_stats,omitempty"`
	Analysis   json.RawMessage `json:"analysis,omitempty"`
	AnalyzedAt *int64          `json:"analyzed_at,omitempty"`
	// AnalysisError is why the last analysis attempt failed, if it did.
	AnalysisError   *string `json:"analysis_error,omitempty"`
	AnalysisErrorAt *int64  `json:"analysis_error_at,omitempty"`
	RecordedAt      int64   `json:"recorded_at"`
	LocalDay        string  `json:"local_day"`
	CreatedAt       int64   `json:"created_at"`
	UpdatedAt       int64   `json:"updated_at"`

	// ScriptTitle and ScriptKind are joined in for list/detail views.
	ScriptTitle string `json:"script_title,omitempty"`
	ScriptKind  string `json:"script_kind,omitempty"`
}

// NewRecording carries the metadata for an upload; file metadata comes
// from the parsed WAV header (server-derived, source of truth).
type NewRecording struct {
	ScriptID   int64
	DurationMs int64
	SampleRate int
	Channels   int
	SizeBytes  int64
	PitchStats json.RawMessage
	RecordedAt int64
	LocalDay   string
}

var localDayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// CreateRecording inserts the metadata row and returns its id. The
// caller writes the WAV file and then calls SetRecordingFilePath, or
// DeleteRecording on failure.
func (s *Store) CreateRecording(nr NewRecording) (int64, error) {
	if !localDayRe.MatchString(nr.LocalDay) {
		return 0, fmt.Errorf("%w: local_day must be YYYY-MM-DD", ErrInvalid)
	}
	if nr.RecordedAt <= 0 {
		return 0, fmt.Errorf("%w: recorded_at is required", ErrInvalid)
	}
	if len(nr.PitchStats) > 0 && !json.Valid(nr.PitchStats) {
		return 0, fmt.Errorf("%w: pitch_stats must be valid JSON", ErrInvalid)
	}
	if _, err := s.GetScript(nr.ScriptID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, fmt.Errorf("%w: script %d does not exist", ErrInvalid, nr.ScriptID)
		}
		return 0, err
	}

	var pitchStats any
	if len(nr.PitchStats) > 0 {
		pitchStats = string(nr.PitchStats)
	}
	now := time.Now().UnixMilli()
	res, err := s.db.Exec(`
		INSERT INTO recordings (script_id, duration_ms, sample_rate, channels, size_bytes,
			pitch_stats, recorded_at, local_day, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		nr.ScriptID, nr.DurationMs, nr.SampleRate, nr.Channels, nr.SizeBytes,
		pitchStats, nr.RecordedAt, nr.LocalDay, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) SetRecordingFilePath(id int64, filePath string) error {
	_, err := s.db.Exec(`UPDATE recordings SET file_path = ?, updated_at = ? WHERE id = ?`,
		filePath, time.Now().UnixMilli(), id)
	return err
}

const recordingCols = `r.id, r.script_id, r.file_path, r.duration_ms, r.sample_rate, r.channels,
	r.size_bytes, r.rating, r.notes, r.pitch_stats, r.analysis, r.analyzed_at, r.recorded_at,
	r.local_day, r.created_at, r.updated_at, s.title, s.kind, r.analysis_error, r.analysis_error_at`

func scanRecording(row interface{ Scan(...any) error }) (*Recording, error) {
	var r Recording
	var pitchStats, analysis sql.NullString
	if err := row.Scan(&r.ID, &r.ScriptID, &r.FilePath, &r.DurationMs, &r.SampleRate, &r.Channels,
		&r.SizeBytes, &r.Rating, &r.Notes, &pitchStats, &analysis, &r.AnalyzedAt, &r.RecordedAt,
		&r.LocalDay, &r.CreatedAt, &r.UpdatedAt, &r.ScriptTitle, &r.ScriptKind, &r.AnalysisError, &r.AnalysisErrorAt); err != nil {
		return nil, err
	}
	if pitchStats.Valid {
		r.PitchStats = json.RawMessage(pitchStats.String)
	}
	if analysis.Valid {
		r.Analysis = json.RawMessage(analysis.String)
	}
	return &r, nil
}

type RecordingFilter struct {
	ScriptID *int64
	LocalDay *string
	Limit    int
	Offset   int
}

func (s *Store) ListRecordings(f RecordingFilter) ([]Recording, error) {
	query := `SELECT ` + recordingCols + ` FROM recordings r JOIN scripts s ON s.id = r.script_id WHERE 1=1`
	args := []any{}
	if f.ScriptID != nil {
		query += ` AND r.script_id = ?`
		args = append(args, *f.ScriptID)
	}
	if f.LocalDay != nil {
		query += ` AND r.local_day = ?`
		args = append(args, *f.LocalDay)
	}
	query += ` ORDER BY r.recorded_at DESC, r.id DESC`
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	query += ` LIMIT ? OFFSET ?`
	args = append(args, f.Limit, f.Offset)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	recordings := []Recording{}
	for rows.Next() {
		r, err := scanRecording(rows)
		if err != nil {
			return nil, err
		}
		recordings = append(recordings, *r)
	}
	return recordings, rows.Err()
}

func (s *Store) GetRecording(id int64) (*Recording, error) {
	r, err := scanRecording(s.db.QueryRow(
		`SELECT `+recordingCols+` FROM recordings r JOIN scripts s ON s.id = r.script_id WHERE r.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

// UpdateRecording patches rating and/or notes. ratingSet distinguishes
// "clear the rating" (rating=nil, ratingSet=true) from "leave it alone".
func (s *Store) UpdateRecording(id int64, rating *int64, ratingSet bool, notes *string) (*Recording, error) {
	if rating != nil && (*rating < 1 || *rating > 5) {
		return nil, fmt.Errorf("%w: rating must be 1-5", ErrInvalid)
	}
	r, err := s.GetRecording(id)
	if err != nil {
		return nil, err
	}
	if ratingSet {
		r.Rating = rating
	}
	if notes != nil {
		r.Notes = *notes
	}
	_, err = s.db.Exec(`UPDATE recordings SET rating = ?, notes = ?, updated_at = ? WHERE id = ?`,
		r.Rating, r.Notes, time.Now().UnixMilli(), id)
	if err != nil {
		return nil, err
	}
	return s.GetRecording(id)
}

// DeleteRecording removes the row; the caller removes the file.
func (s *Store) DeleteRecording(id int64) error {
	res, err := s.db.Exec(`DELETE FROM recordings WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// NewAnnotation is a time-anchored event produced by analysis.
type NewAnnotation struct {
	StartMs int64
	EndMs   *int64
	Kind    string
	Payload json.RawMessage
}

// SetRecordingAnalysis stores the analysis document and replaces the
// recording's auto-generated annotations, atomically.
func (s *Store) SetRecordingAnalysis(id int64, analysis json.RawMessage, events []NewAnnotation) error {
	if !json.Valid(analysis) {
		return fmt.Errorf("%w: analysis must be valid JSON", ErrInvalid)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().UnixMilli()
	// Keep the document being replaced. Same-version re-runs replace in
	// place (a "re-listen" of a take), so history holds one document per
	// analyzer version: what each algorithm said.
	if _, err := tx.Exec(`
		INSERT INTO analysis_history (recording_id, version, analysis, analyzed_at, replaced_at)
		SELECT id, CAST(COALESCE(json_extract(analysis, '$.version'), 0) AS INTEGER), analysis, analyzed_at, ?
		FROM recordings
		WHERE id = ? AND analysis IS NOT NULL
		  AND CAST(COALESCE(json_extract(analysis, '$.version'), 0) AS INTEGER)
		      != CAST(COALESCE(json_extract(?, '$.version'), 0) AS INTEGER)
		  AND NOT EXISTS (
		      SELECT 1 FROM analysis_history h
		      WHERE h.recording_id = recordings.id
		        AND h.version = CAST(COALESCE(json_extract(recordings.analysis, '$.version'), 0) AS INTEGER))`,
		now, id, string(analysis)); err != nil {
		return err
	}
	res, err := tx.Exec(`UPDATE recordings SET analysis = ?, analyzed_at = ?, updated_at = ?,
		analysis_error = NULL, analysis_error_at = NULL WHERE id = ?`,
		string(analysis), now, now, id)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return ErrNotFound
	}

	if _, err := tx.Exec(`DELETE FROM annotations WHERE recording_id = ? AND source = 'auto'`, id); err != nil {
		return err
	}
	for _, e := range events {
		payload := "{}"
		if len(e.Payload) > 0 {
			if !json.Valid(e.Payload) {
				return fmt.Errorf("%w: annotation payload must be valid JSON", ErrInvalid)
			}
			payload = string(e.Payload)
		}
		if _, err := tx.Exec(`
			INSERT INTO annotations (recording_id, start_ms, end_ms, kind, payload, source, created_at)
			VALUES (?, ?, ?, ?, ?, 'auto', ?)`,
			id, e.StartMs, e.EndMs, e.Kind, payload, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetRecordingAnalysisError records why analysing a take failed. The
// take keeps any earlier analysis.
func (s *Store) SetRecordingAnalysisError(id int64, msg string) error {
	res, err := s.db.Exec(`UPDATE recordings SET analysis_error = ?, analysis_error_at = ? WHERE id = ?`,
		msg, time.Now().UnixMilli(), id)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListRecordingIDsWithAnalysisErrors() ([]int64, error) {
	rows, err := s.db.Query(`SELECT id FROM recordings WHERE analysis_error IS NOT NULL AND file_path != '' ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) CountAnalysisErrors() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM recordings WHERE analysis_error IS NOT NULL`).Scan(&n)
	return n, err
}

// ListRecordingIDsNeedingAnalysis returns takes with a stored file but
// no analysis (or one from an older analyzer version), oldest first.
func (s *Store) ListRecordingIDsNeedingAnalysis(currentVersion int) ([]int64, error) {
	rows, err := s.db.Query(`
		SELECT id FROM recordings
		WHERE file_path != ''
		  AND (analysis IS NULL
		       OR CAST(COALESCE(json_extract(analysis, '$.version'), 0) AS INTEGER) < ?)
		ORDER BY id`, currentVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

type HeatmapDay struct {
	Day             string `json:"day"`
	Count           int64  `json:"count"`
	TotalDurationMs int64  `json:"total_duration_ms"`
}

func (s *Store) Heatmap(from, to string, scriptID *int64) ([]HeatmapDay, error) {
	query := `SELECT local_day, COUNT(*), COALESCE(SUM(duration_ms), 0)
		FROM recordings WHERE local_day >= ? AND local_day <= ?`
	args := []any{from, to}
	if scriptID != nil {
		query += ` AND script_id = ?`
		args = append(args, *scriptID)
	}
	query += ` GROUP BY local_day ORDER BY local_day`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	days := []HeatmapDay{}
	for rows.Next() {
		var d HeatmapDay
		if err := rows.Scan(&d.Day, &d.Count, &d.TotalDurationMs); err != nil {
			return nil, err
		}
		days = append(days, d)
	}
	return days, rows.Err()
}

// Nothing writes annotations yet; this locks the read contract for the
// future automated-analysis feature.
func (s *Store) ListAnnotations(recordingID int64) ([]Annotation, error) {
	rows, err := s.db.Query(`
		SELECT id, recording_id, start_ms, end_ms, kind, payload, source, created_at
		FROM annotations WHERE recording_id = ? ORDER BY start_ms`, recordingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	annotations := []Annotation{}
	for rows.Next() {
		var a Annotation
		var payload string
		if err := rows.Scan(&a.ID, &a.RecordingID, &a.StartMs, &a.EndMs, &a.Kind, &payload,
			&a.Source, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.Payload = json.RawMessage(payload)
		annotations = append(annotations, a)
	}
	return annotations, rows.Err()
}

type Annotation struct {
	ID          int64           `json:"id"`
	RecordingID int64           `json:"recording_id"`
	StartMs     int64           `json:"start_ms"`
	EndMs       *int64          `json:"end_ms"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
	Source      string          `json:"source"`
	CreatedAt   int64           `json:"created_at"`
}

type ArchivedAnalysis struct {
	Version    int             `json:"version"`
	Analysis   json.RawMessage `json:"analysis"`
	AnalyzedAt *int64          `json:"analyzed_at,omitempty"`
	ReplacedAt int64           `json:"replaced_at"`
}

func (s *Store) ListAnalysisHistory(recordingID int64) ([]ArchivedAnalysis, error) {
	rows, err := s.db.Query(`
		SELECT version, analysis, analyzed_at, replaced_at FROM analysis_history
		WHERE recording_id = ? ORDER BY version, id`, recordingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ArchivedAnalysis{}
	for rows.Next() {
		var a ArchivedAnalysis
		var doc string
		if err := rows.Scan(&a.Version, &doc, &a.AnalyzedAt, &a.ReplacedAt); err != nil {
			return nil, err
		}
		a.Analysis = json.RawMessage(doc)
		out = append(out, a)
	}
	return out, rows.Err()
}

type TrendPoint struct {
	ID           int64    `json:"id"`
	ScriptID     int64    `json:"script_id"`
	RecordedAt   int64    `json:"recorded_at"`
	LocalDay     string   `json:"local_day"`
	DurationMs   int64    `json:"duration_ms"`
	MedianHz     *float64 `json:"median_hz"`
	PctInBand    *float64 `json:"pct_in_band"`
	FryPct       *float64 `json:"fry_pct"`
	VtlCm        *float64 `json:"vtl_cm"`
	SemitoneSD   *float64 `json:"semitone_sd"`
	LiveMedianHz *float64 `json:"live_median_hz"`
	// Kind is the script's kind, so passage and exercise trends stay apart.
	Kind string `json:"kind"`
	// Exercise measures, from the live tracker (pitch_stats).
	RangeSt   *float64 `json:"range_st"`
	HoldS     *float64 `json:"hold_s"`
	HoldCents *float64 `json:"hold_cents"`
	StreakS   *float64 `json:"streak_s"`
}

// Trends returns every take's headline numbers, oldest first, pulled
// out of the analysis documents so the client never downloads contours.
func (s *Store) Trends(scriptID *int64) ([]TrendPoint, error) {
	query := `SELECT r.id, r.script_id, r.recorded_at, r.local_day, r.duration_ms,
			json_extract(r.analysis, '$.pitch.median_hz'),
			json_extract(r.analysis, '$.pitch.pct_in_band'),
			json_extract(r.analysis, '$.pitch.fry_pct'),
			json_extract(r.analysis, '$.resonance.estimated_vtl_cm'),
			json_extract(r.analysis, '$.melody.semitone_sd'),
			json_extract(r.pitch_stats, '$.median_hz'),
			s.kind,
			json_extract(r.pitch_stats, '$.range_st'),
			json_extract(r.pitch_stats, '$.longest_hold_s'),
			json_extract(r.pitch_stats, '$.hold_sd_cents'),
			json_extract(r.pitch_stats, '$.longest_in_band_s')
		FROM recordings r JOIN scripts s ON s.id = r.script_id`
	args := []any{}
	if scriptID != nil {
		query += ` WHERE r.script_id = ?`
		args = append(args, *scriptID)
	}
	query += ` ORDER BY r.recorded_at, r.id`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrendPoint{}
	for rows.Next() {
		var p TrendPoint
		if err := rows.Scan(&p.ID, &p.ScriptID, &p.RecordedAt, &p.LocalDay, &p.DurationMs,
			&p.MedianHz, &p.PctInBand, &p.FryPct, &p.VtlCm, &p.SemitoneSD, &p.LiveMedianHz,
			&p.Kind, &p.RangeSt, &p.HoldS, &p.HoldCents, &p.StreakS); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
