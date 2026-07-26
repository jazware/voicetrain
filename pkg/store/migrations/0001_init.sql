CREATE TABLE scripts (
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    attribution  TEXT NOT NULL DEFAULT '',
    focus_points TEXT NOT NULL DEFAULT '[]',
    is_seeded    INTEGER NOT NULL DEFAULT 0,
    seed_slug    TEXT UNIQUE,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

CREATE TABLE recordings (
    id          INTEGER PRIMARY KEY,
    script_id   INTEGER NOT NULL REFERENCES scripts(id),
    file_path   TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    sample_rate INTEGER NOT NULL DEFAULT 48000,
    channels    INTEGER NOT NULL DEFAULT 1,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
    notes       TEXT NOT NULL DEFAULT '',
    pitch_stats TEXT,
    recorded_at INTEGER NOT NULL,
    local_day   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_recordings_script_day ON recordings(script_id, local_day);
CREATE INDEX idx_recordings_day ON recordings(local_day);

CREATE TABLE annotations (
    id           INTEGER PRIMARY KEY,
    recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    start_ms     INTEGER NOT NULL,
    end_ms       INTEGER,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}',
    source       TEXT NOT NULL DEFAULT 'auto',
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_annotations_recording ON annotations(recording_id, start_ms);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
    ('target_min_hz', '165'),
    ('target_max_hz', '220');
