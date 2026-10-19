-- D1 migration. The trigger makes the cleanup atomic with its version marker,
-- even if a migration runner does not wrap the complete SQL file in a transaction.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS apply_legacy_bot_detection_cleanup_v7
AFTER INSERT ON schema_migrations
WHEN NEW.version = 7
BEGIN
    UPDATE member_bot_state
    SET auto_bot = 0, detection_marks = 0, last_detection_at = NULL;
END;

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, 0);

DROP TRIGGER IF EXISTS apply_legacy_bot_detection_cleanup_v7;
