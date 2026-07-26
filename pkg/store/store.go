package store

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store wraps the SQLite database for all voicetrain persistence.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the SQLite database at dbPath,
// applies pending migrations, and seeds the standard passages.
func Open(dbPath string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?%s", dbPath, url.Values{
		"_pragma": []string{
			"journal_mode(WAL)",
			"busy_timeout(5000)",
			"foreign_keys(1)",
			"synchronous(NORMAL)",
		},
	}.Encode())

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	// Single writer keeps SQLite locking trivial; this is a single-user app.
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrating database: %w", err)
	}
	if err := s.seed(); err != nil {
		db.Close()
		return nil, fmt.Errorf("seeding database: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// SnapshotTo writes a consistent copy of the database to path (which
// must not exist), safe to run while the app is writing. Used by the
// backup runner so the live WAL-mode files are never copied directly.
func (s *Store) SnapshotTo(path string) error {
	_, err := s.db.Exec(`VACUUM INTO ?`, path)
	return err
}

// migrate applies embedded migrations with a version greater than the
// current PRAGMA user_version, in filename order, each in a transaction.
func (s *Store) migrate() error {
	var current int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("reading user_version: %w", err)
	}

	entries, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)

	for _, name := range entries {
		version, err := migrationVersion(name)
		if err != nil {
			return err
		}
		if version <= current {
			continue
		}

		sqlBytes, err := migrationsFS.ReadFile(name)
		if err != nil {
			return err
		}

		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(sqlBytes)); err != nil {
			tx.Rollback()
			return fmt.Errorf("applying %s: %w", name, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
			tx.Rollback()
			return fmt.Errorf("setting user_version for %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("committing %s: %w", name, err)
		}
	}
	return nil
}

// migrationVersion extracts the numeric prefix from "migrations/0001_init.sql".
func migrationVersion(name string) (int, error) {
	base := strings.TrimPrefix(name, "migrations/")
	prefix, _, ok := strings.Cut(base, "_")
	if !ok {
		return 0, fmt.Errorf("migration %q missing NNNN_name.sql format", name)
	}
	version, err := strconv.Atoi(prefix)
	if err != nil {
		return 0, fmt.Errorf("migration %q has non-numeric version: %w", name, err)
	}
	return version, nil
}
