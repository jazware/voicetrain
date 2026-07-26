package store

import (
	"errors"
	"fmt"
	"strconv"
)

// ErrInvalid is returned for validation failures; handlers map it to 400.
var ErrInvalid = errors.New("invalid")

// Settings holds the user-tunable preferences.
type Settings struct {
	TargetMinHz float64 `json:"target_min_hz"`
	TargetMaxHz float64 `json:"target_max_hz"`
}

// GetSettings reads all settings rows into a Settings struct.
func (s *Store) GetSettings() (*Settings, error) {
	rows, err := s.db.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	settings := &Settings{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		switch key {
		case "target_min_hz":
			settings.TargetMinHz, err = strconv.ParseFloat(value, 64)
		case "target_max_hz":
			settings.TargetMaxHz, err = strconv.ParseFloat(value, 64)
		}
		if err != nil {
			return nil, fmt.Errorf("parsing setting %s: %w", key, err)
		}
	}
	return settings, rows.Err()
}

// PutSettings validates and stores the full settings object.
func (s *Store) PutSettings(settings Settings) error {
	if settings.TargetMinHz <= 0 || settings.TargetMaxHz <= settings.TargetMinHz {
		return fmt.Errorf("%w: target band must satisfy 0 < min < max", ErrInvalid)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for key, value := range map[string]float64{
		"target_min_hz": settings.TargetMinHz,
		"target_max_hz": settings.TargetMaxHz,
	} {
		if _, err := tx.Exec(`
			INSERT INTO settings (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key, strconv.FormatFloat(value, 'f', -1, 64)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
