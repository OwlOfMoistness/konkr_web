BEGIN;

-- A run keeps its original revision and anonymous owner even after publication changes.
CREATE TABLE runs (
  id text PRIMARY KEY,
  browser_token_hash text NOT NULL REFERENCES visitors(token_hash),
  revision_id text NOT NULL REFERENCES map_revisions(id),
  binding jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','queued','running','complete')),
  idempotency_key text,
  submission_hash text,
  submission_key text,
  submitted_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token text,
  lease_until timestamptz,
  result jsonb,
  completed_at timestamptz,
  counted boolean NOT NULL DEFAULT false,
  UNIQUE (browser_token_hash,idempotency_key),
  CHECK ((state='issued') = (submission_key IS NULL)),
  CHECK ((submission_key IS NULL) = (submission_hash IS NULL)),
  CHECK ((submission_key IS NULL) = (idempotency_key IS NULL)),
  CHECK ((state='complete') = (result IS NOT NULL)),
  CHECK ((state='running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (NOT counted OR (state='complete' AND result->>'status'='verified'))
);
CREATE INDEX runs_queue ON runs (available_at,submitted_at,id) WHERE state IN ('queued','running');
CREATE INDEX runs_owner ON runs (browser_token_hash,created_at DESC);

CREATE FUNCTION protect_run_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.browser_token_hash,NEW.revision_id,NEW.binding,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.browser_token_hash,OLD.revision_id,OLD.binding,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'Issued run bindings are immutable';
  END IF;
  IF OLD.submission_key IS NOT NULL AND
      (NEW.idempotency_key,NEW.submission_hash,NEW.submission_key,NEW.submitted_at)
      IS DISTINCT FROM (OLD.idempotency_key,OLD.submission_hash,OLD.submission_key,OLD.submitted_at) THEN
    RAISE EXCEPTION 'Accepted submissions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_run_binding BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION protect_run_binding();

COMMIT;
