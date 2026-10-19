CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_bot_detection_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_bot_detection_active
ON member_bot_detection_events (group_openid, member_openid, expires_at);

CREATE INDEX IF NOT EXISTS idx_member_bot_detection_expiry
ON member_bot_detection_events (expires_at);
