ALTER TABLE image_generation_requests ADD COLUMN quota_source TEXT NOT NULL DEFAULT 'base'
    CHECK (quota_source IN ('base', 'bonus'));
ALTER TABLE image_generation_requests ADD COLUMN quota_day_key TEXT NOT NULL DEFAULT '';

UPDATE image_generation_requests
SET quota_day_key = strftime('%Y-%m-%d', requested_at / 1000, 'unixepoch', '+8 hours')
WHERE quota_day_key = '';

CREATE INDEX IF NOT EXISTS idx_image_generation_quota_usage
ON image_generation_requests (group_openid, member_openid, quota_day_key, quota_source, submitted_at);

CREATE TABLE IF NOT EXISTS member_image_quotas (
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    daily_limit_override INTEGER CHECK (daily_limit_override IS NULL OR daily_limit_override >= 0),
    bonus_credits INTEGER NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_openid, member_openid)
);

CREATE TABLE IF NOT EXISTS image_generation_credit_grants (
    operation_id TEXT PRIMARY KEY,
    group_openid TEXT NOT NULL,
    member_openid TEXT NOT NULL,
    delta INTEGER NOT NULL CHECK (delta BETWEEN 1 AND 10000),
    created_at INTEGER NOT NULL,
    operator TEXT NOT NULL,
    balance_after INTEGER NOT NULL DEFAULT 0 CHECK (balance_after >= 0)
);

CREATE TRIGGER IF NOT EXISTS apply_image_generation_credit_grant
AFTER INSERT ON image_generation_credit_grants
BEGIN
    INSERT INTO member_image_quotas (group_openid, member_openid, daily_limit_override, bonus_credits, updated_at)
    VALUES (NEW.group_openid, NEW.member_openid, NULL, NEW.delta, NEW.created_at)
    ON CONFLICT (group_openid, member_openid) DO UPDATE SET
        bonus_credits = member_image_quotas.bonus_credits + NEW.delta,
        updated_at = NEW.created_at;

    UPDATE image_generation_credit_grants
    SET balance_after = (
        SELECT bonus_credits FROM member_image_quotas
        WHERE group_openid = NEW.group_openid AND member_openid = NEW.member_openid
    )
    WHERE operation_id = NEW.operation_id;
END;

CREATE TRIGGER IF NOT EXISTS consume_image_generation_bonus_credit
AFTER INSERT ON image_generation_requests
WHEN NEW.quota_source = 'bonus'
BEGIN
    UPDATE member_image_quotas
    SET bonus_credits = bonus_credits - 1
    WHERE group_openid = NEW.group_openid AND member_openid = NEW.member_openid AND bonus_credits > 0;
END;
