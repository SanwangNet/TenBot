CREATE TABLE IF NOT EXISTS member_bot_state (
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    platform_bot INTEGER NOT NULL DEFAULT 0 CHECK (platform_bot IN (0, 1)),
    manual_bot INTEGER NOT NULL DEFAULT 0 CHECK (manual_bot IN (0, 1)),
    auto_bot INTEGER NOT NULL DEFAULT 0 CHECK (auto_bot IN (0, 1)),
    detection_marks INTEGER NOT NULL DEFAULT 0 CHECK (detection_marks >= 0),
    last_detection_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_openid, member_openid)
);

CREATE INDEX IF NOT EXISTS idx_member_bot_state_marked
ON member_bot_state (group_openid, platform_bot, manual_bot, auto_bot);

INSERT OR IGNORE INTO member_bot_state (
    group_openid, member_openid, platform_bot, manual_bot, auto_bot, detection_marks,
    last_detection_at, created_at, updated_at
)
SELECT group_openid, member_openid, 0, 0, 0, 0, NULL, first_seen_at, updated_at
FROM group_members;

INSERT OR IGNORE INTO runtime_state (key, value, updated_at)
VALUES ('legacy_automated_peer_ids_imported', '0', 0);
