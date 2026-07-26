-- Post-hoc acoustic analysis results: the full JSON document from the
-- analysis sidecar (per-axis metrics + contour). Its time-anchored
-- events land in the existing annotations table with source='auto'.
ALTER TABLE recordings ADD COLUMN analysis TEXT;
ALTER TABLE recordings ADD COLUMN analyzed_at INTEGER;
