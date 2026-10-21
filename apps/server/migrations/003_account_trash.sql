ALTER TABLE rufa_users ADD COLUMN deleted_at timestamptz;
ALTER TABLE rufa_users ADD COLUMN purge_after timestamptz;
ALTER TABLE rufa_users ADD COLUMN purged_at timestamptz;
-- Legacy soft-deleted accounts receive one recovery window when this migration runs.
UPDATE rufa_users SET deleted_at=now(),purge_after=now()+interval '7 days' WHERE status='deleted';
