CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO runtime_state (key, value, updated_at)
VALUES ('group_replies_enabled', '0', 0);
