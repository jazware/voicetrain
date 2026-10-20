-- What a script is practised as: a passage to read, or one of the
-- exercises (siren, sustain, hold), whose body is its instructions.
ALTER TABLE scripts ADD COLUMN kind TEXT NOT NULL DEFAULT 'passage';
