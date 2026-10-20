-- Earlier analysis documents, kept when a newer analyzer replaces one.
-- Analysis is derived data, but re-analysis should never silently
-- discard what a take was measured as before.
CREATE TABLE analysis_history (
    id           INTEGER PRIMARY KEY,
    recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    analysis     TEXT NOT NULL,
    analyzed_at  INTEGER,
    replaced_at  INTEGER NOT NULL
);
CREATE INDEX idx_analysis_history_recording ON analysis_history(recording_id, version);
