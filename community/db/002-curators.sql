BEGIN;
CREATE TABLE curators (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  role text NOT NULL CHECK (role IN ('curator','admin')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE curator_sessions (
  token_hash text PRIMARY KEY,
  curator_id text NOT NULL REFERENCES curators(id),
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX curator_session_expiry ON curator_sessions(expires_at);
CREATE TABLE curator_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL REFERENCES curators(id),
  action text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
