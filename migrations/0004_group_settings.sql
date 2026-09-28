CREATE TABLE IF NOT EXISTS group_settings (
    group_openid TEXT PRIMARY KEY,
    replies_enabled INTEGER NOT NULL DEFAULT 1 CHECK (replies_enabled IN (0, 1)),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    display_name TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_settings_last_seen
ON group_settings (last_seen_at DESC, group_openid);

INSERT OR IGNORE INTO group_settings (group_openid, replies_enabled, first_seen_at, last_seen_at, display_name, updated_at)
SELECT group_openid, 1, MIN(first_seen_at), MAX(last_seen_at), NULL, MAX(updated_at)
FROM group_members
GROUP BY group_openid;
