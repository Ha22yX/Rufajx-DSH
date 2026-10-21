ALTER TABLE rufa_users ADD COLUMN job_title text NOT NULL DEFAULT '' CHECK (char_length(job_title) <= 100);
