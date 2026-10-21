CREATE TABLE IF NOT EXISTS rufa_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('employee','admin')),
  status text NOT NULL CHECK (status IN ('active','disabled','deleted')) DEFAULT 'active',
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rufa_logins (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES rufa_users(id),
  device_id uuid NOT NULL,
  device_label text NOT NULL,
  access_hash text NOT NULL UNIQUE,
  refresh_hash text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rufa_logins_user_idx ON rufa_logins(user_id);
CREATE TABLE IF NOT EXISTS rufa_spent_refresh (
  token_hash text PRIMARY KEY,
  login_id uuid NOT NULL REFERENCES rufa_logins(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rufa_sessions (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES rufa_users(id),
  title text NOT NULL,
  workspace_ref text,
  upstream_header jsonb,
  inherited_event_count bigint NOT NULL DEFAULT 0 CHECK(inherited_event_count >= 0),
  next_seq bigint NOT NULL DEFAULT 0 CHECK(next_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_login_id uuid REFERENCES rufa_logins(id),
  lease_expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS rufa_sessions_owner_idx ON rufa_sessions(owner_id,id);
CREATE TABLE IF NOT EXISTS rufa_session_events (
  session_id text NOT NULL REFERENCES rufa_sessions(id),
  seq bigint NOT NULL CHECK(seq >= 0),
  event jsonb NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY(session_id,seq)
);
CREATE TABLE IF NOT EXISTS rufa_audit (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES rufa_users(id),
  action text NOT NULL,
  target_id text,
  request_id text,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rufa_usage (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES rufa_users(id),
  login_id uuid NOT NULL REFERENCES rufa_logins(id),
  model text NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('completed','failed','cancelled')),
  created_at timestamptz NOT NULL,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint
);
CREATE TABLE IF NOT EXISTS rufa_upstream_files (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES rufa_users(id),
  metadata jsonb NOT NULL,
  contents bytea NOT NULL,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS rufa_upstream_files_owner_idx ON rufa_upstream_files(owner_id,id);
