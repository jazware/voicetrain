package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// Recording is one practice take.
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
	RecordedAt int64           `json:"recorded_at"`
	LocalDay   string          `json:"local_day"`
	CreatedAt  int64           `json:"created_at"`
	UpdatedAt  int64           `json:"updated_at"`

	// ScriptTitle is joined in for list/detail views.
	ScriptTitle string `json:"script_title,omitempty"`
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

// SetRecordingFilePath records where the WAV landed on disk.
func (s *Store) SetRecordingFilePath(id int64, filePath string) error {
	_, err := s.db.Exec(`UPDATE recordings SET file_path = ?, updated_at = ? WHERE id = ?`,
		filePath, time.Now().UnixMilli(), id)
	return err
}

const recordingCols = `r.id, r.script_id, r.file_path, r.duration_ms, r.sample_rate, r.channels,
	r.size_bytes, r.rating, r.notes, r.pitch_stats, r.analysis, r.analyzed_at, r.recorded_at,
	r.local_day, r.created_at, r.updated_at, s.title`

func scanRecording(row interface{ Scan(...any) error }) (*Recording, error) {
	var r Recording
	var pitchStats, analysis sql.NullString
	if err := row.Scan(&r.ID, &r.ScriptID, &r.FilePath, &r.DurationMs, &r.SampleRate, &r.Channels,
		&r.SizeBytes, &r.Rating, &r.Notes, &pitchStats, &analysis, &r.AnalyzedAt, &r.RecordedAt,
		&r.LocalDay, &r.CreatedAt, &r.UpdatedAt, &r.ScriptTitle); err != nil {
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

// RecordingFilter narrows ListRecordings.
type RecordingFilter struct {
	ScriptID *int64
	LocalDay *string
	Limit    int
	Offset   int
}

// ListRecordings returns takes newest-first with their script titles.
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

// GetRecording returns one take by id.
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
	res, err := tx.Exec(`UPDATE recordings SET analysis = ?, analyzed_at = ?, updated_at = ? WHERE id = ?`,
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

// HeatmapDay is one day's practice aggregate.
type HeatmapDay struct {
	Day             string `json:"day"`
	Count           int64  `json:"count"`
	TotalDurationMs int64  `json:"total_duration_ms"`
}

// Heatmap aggregates practice per local day, optionally for one script.
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

// ListAnnotations returns time-anchored annotations for a recording.
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

// Annotation is a time-anchored note on a recording (future: produced
// by automated analysis).
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
