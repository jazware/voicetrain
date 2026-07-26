package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrNotFound is returned when a requested row does not exist.
var ErrNotFound = errors.New("not found")

// Script is a practice passage.
type Script struct {
	ID          int64           `json:"id"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	Attribution string          `json:"attribution"`
	FocusPoints json.RawMessage `json:"focus_points"`
	IsSeeded    bool            `json:"is_seeded"`
	CreatedAt   int64           `json:"created_at"`
	UpdatedAt   int64           `json:"updated_at"`
	DeletedAt   *int64          `json:"deleted_at,omitempty"`

	// Aggregates populated by ListScripts.
	TakeCount        int64   `json:"take_count"`
	LastPracticedDay *string `json:"last_practiced_day,omitempty"`
}

// ScriptParams are the user-settable fields of a script.
type ScriptParams struct {
	Title       *string          `json:"title"`
	Body        *string          `json:"body"`
	Attribution *string          `json:"attribution"`
	FocusPoints *json.RawMessage `json:"focus_points"`
}

const scriptCols = "id, title, body, attribution, focus_points, is_seeded, created_at, updated_at, deleted_at"

func scanScript(row interface{ Scan(...any) error }, sc *Script) error {
	var focusPoints string
	if err := row.Scan(&sc.ID, &sc.Title, &sc.Body, &sc.Attribution, &focusPoints,
		&sc.IsSeeded, &sc.CreatedAt, &sc.UpdatedAt, &sc.DeletedAt); err != nil {
		return err
	}
	sc.FocusPoints = json.RawMessage(focusPoints)
	return nil
}

// ListScripts returns all non-deleted scripts with practice aggregates,
// most recently created first.
func (s *Store) ListScripts() ([]Script, error) {
	rows, err := s.db.Query(`
		SELECT ` + scriptCols + `,
			(SELECT COUNT(*) FROM recordings r WHERE r.script_id = scripts.id) AS take_count,
			(SELECT MAX(r.local_day) FROM recordings r WHERE r.script_id = scripts.id) AS last_practiced_day
		FROM scripts
		WHERE deleted_at IS NULL
		ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	scripts := []Script{}
	for rows.Next() {
		var sc Script
		var focusPoints string
		if err := rows.Scan(&sc.ID, &sc.Title, &sc.Body, &sc.Attribution, &focusPoints,
			&sc.IsSeeded, &sc.CreatedAt, &sc.UpdatedAt, &sc.DeletedAt,
			&sc.TakeCount, &sc.LastPracticedDay); err != nil {
			return nil, err
		}
		sc.FocusPoints = json.RawMessage(focusPoints)
		scripts = append(scripts, sc)
	}
	return scripts, rows.Err()
}

// GetScript returns a script by id, including soft-deleted ones so old
// takes can still resolve their script.
func (s *Store) GetScript(id int64) (*Script, error) {
	var sc Script
	err := scanScript(s.db.QueryRow(`SELECT `+scriptCols+` FROM scripts WHERE id = ?`, id), &sc)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sc, nil
}

// CreateScript inserts a new user script and returns it.
func (s *Store) CreateScript(p ScriptParams) (*Script, error) {
	title, body := "", ""
	if p.Title != nil {
		title = *p.Title
	}
	if p.Body != nil {
		body = *p.Body
	}
	if title == "" || body == "" {
		return nil, fmt.Errorf("%w: title and body are required", ErrInvalid)
	}
	attribution := ""
	if p.Attribution != nil {
		attribution = *p.Attribution
	}
	focusPoints, err := normalizeFocusPoints(p.FocusPoints)
	if err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	res, err := s.db.Exec(`
		INSERT INTO scripts (title, body, attribution, focus_points, is_seeded, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, ?, ?)`,
		title, body, attribution, focusPoints, now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.GetScript(id)
}

// UpdateScript applies the non-nil fields of p to an existing script.
func (s *Store) UpdateScript(id int64, p ScriptParams) (*Script, error) {
	sc, err := s.GetScript(id)
	if err != nil {
		return nil, err
	}

	title, body, attribution := sc.Title, sc.Body, sc.Attribution
	focusPoints := string(sc.FocusPoints)
	if p.Title != nil {
		title = *p.Title
	}
	if p.Body != nil {
		body = *p.Body
	}
	if p.Attribution != nil {
		attribution = *p.Attribution
	}
	if p.FocusPoints != nil {
		focusPoints, err = normalizeFocusPoints(p.FocusPoints)
		if err != nil {
			return nil, err
		}
	}
	if title == "" || body == "" {
		return nil, fmt.Errorf("%w: title and body must not be empty", ErrInvalid)
	}

	_, err = s.db.Exec(`
		UPDATE scripts SET title = ?, body = ?, attribution = ?, focus_points = ?, updated_at = ?
		WHERE id = ?`,
		title, body, attribution, focusPoints, time.Now().UnixMilli(), id)
	if err != nil {
		return nil, err
	}
	return s.GetScript(id)
}

// DeleteScript soft-deletes a script; its recordings remain.
func (s *Store) DeleteScript(id int64) error {
	res, err := s.db.Exec(`UPDATE scripts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
		time.Now().UnixMilli(), id)
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

// normalizeFocusPoints validates that the raw JSON is an array of strings
// and returns its canonical encoding ("[]" when nil).
func normalizeFocusPoints(raw *json.RawMessage) (string, error) {
	if raw == nil || len(*raw) == 0 {
		return "[]", nil
	}
	var points []string
	if err := json.Unmarshal(*raw, &points); err != nil {
		return "", fmt.Errorf("%w: focus_points must be an array of strings", ErrInvalid)
	}
	encoded, err := json.Marshal(points)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
