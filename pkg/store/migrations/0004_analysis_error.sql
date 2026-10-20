-- Why the last analysis attempt failed, so the UI can say so instead
-- of waiting forever. Cleared when an analysis lands.
ALTER TABLE recordings ADD COLUMN analysis_error TEXT;
ALTER TABLE recordings ADD COLUMN analysis_error_at INTEGER;
