BEGIN;
CREATE TABLE visitors (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days'
);
CREATE TABLE visitor_limits (
  token_hash text NOT NULL REFERENCES visitors(token_hash),
  scope text NOT NULL,
  window_start bigint NOT NULL,
  used integer NOT NULL CHECK (used>0),
  PRIMARY KEY(token_hash,scope,window_start)
);
CREATE INDEX visitor_expiry ON visitors(expires_at);
COMMIT;
