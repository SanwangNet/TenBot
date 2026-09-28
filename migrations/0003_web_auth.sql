CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY,
    github_user_id TEXT NOT NULL,
    github_login TEXT NOT NULL,
    github_avatar_url TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at
ON web_sessions (expires_at);
