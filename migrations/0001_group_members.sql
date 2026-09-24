CREATE TABLE IF NOT EXISTS group_members (
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    username TEXT NOT NULL,
    role TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_openid, member_openid)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group_username
ON group_members (group_openid, username);
