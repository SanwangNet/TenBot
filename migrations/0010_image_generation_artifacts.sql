CREATE TABLE IF NOT EXISTS image_generation_artifacts (
    request_key TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    actual_size TEXT NOT NULL,
    actual_format TEXT NOT NULL,
    image_path TEXT NOT NULL,
    generation_status TEXT NOT NULL CHECK (generation_status IN ('succeeded', 'size_mismatch')),
    send_status TEXT NOT NULL CHECK (send_status IN ('pending', 'quoted', 'unquoted', 'failed', 'unknown', 'not_attempted')),
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_generation_artifact_request_id
ON image_generation_artifacts (request_id);
