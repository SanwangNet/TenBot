CREATE TABLE IF NOT EXISTS member_bot_detection_observations (
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (group_openid, member_openid, message_id)
);

CREATE INDEX IF NOT EXISTS idx_member_bot_detection_observations_window
ON member_bot_detection_observations (group_openid, member_openid, observed_at);

CREATE INDEX IF NOT EXISTS idx_member_bot_detection_observations_expiry
ON member_bot_detection_observations (expires_at);
