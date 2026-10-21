CREATE TABLE IF NOT EXISTS image_generation_requests (
    request_key TEXT PRIMARY KEY,
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    day_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'submitted', 'generated', 'succeeded', 'send_failed', 'failed', 'unknown')),
    model TEXT NOT NULL,
    size TEXT NOT NULL,
    quality TEXT NOT NULL,
    output_format TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    submitted_at INTEGER,
    completed_at INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    image_tokens INTEGER,
    text_tokens INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_generation_message
ON image_generation_requests (group_openid, message_id);

CREATE INDEX IF NOT EXISTS idx_image_generation_daily_quota
ON image_generation_requests (group_openid, member_openid, day_key, submitted_at);

CREATE INDEX IF NOT EXISTS idx_image_generation_active
ON image_generation_requests (status);
