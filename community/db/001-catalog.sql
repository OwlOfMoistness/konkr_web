BEGIN;

CREATE TABLE maps (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  creator text NOT NULL DEFAULT '' CHECK (char_length(creator) <= 120),
  tags text[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'archived')),
  current_revision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (cardinality(tags) <= 12),
  CHECK (state <> 'published' OR (current_revision_id IS NOT NULL AND published_at IS NOT NULL))
);

CREATE TABLE map_revisions (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  map_id text NOT NULL REFERENCES maps(id),
  revision integer NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL,
  object_key text NOT NULL,
  engine_hash text NOT NULL,
  plugins text[] NOT NULL DEFAULT '{}',
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  preview_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (map_id, revision),
  UNIQUE (map_id, id)
);

ALTER TABLE maps ADD CONSTRAINT maps_current_revision
  FOREIGN KEY (id, current_revision_id) REFERENCES map_revisions(map_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- A preview is derived media; changing it must never change challenge identity.
CREATE FUNCTION protect_map_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Map revisions are retained; archive their map instead';
  END IF;
  IF (to_jsonb(NEW) - 'preview_key') IS DISTINCT FROM (to_jsonb(OLD) - 'preview_key') THEN
    RAISE EXCEPTION 'Gameplay revisions are immutable; create a new revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_map_revision BEFORE UPDATE OR DELETE ON map_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_map_revision();

-- Writers are supplied by the ratings/results slices. Public clients cannot write these directly.
CREATE TABLE map_ratings (
  revision_id text NOT NULL REFERENCES map_revisions(id),
  browser_token_hash text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id, browser_token_hash)
);

CREATE TABLE map_score_buckets (
  revision_id text NOT NULL REFERENCES map_revisions(id),
  difficulty text NOT NULL CHECK (difficulty IN ('normal', 'hard')),
  engine_hash text NOT NULL,
  completions bigint NOT NULL DEFAULT 0 CHECK (completions BETWEEN 0 AND 9007199254740991),
  best_turns integer CHECK (best_turns >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id, difficulty, engine_hash),
  CHECK ((completions = 0 AND best_turns IS NULL) OR (completions > 0 AND best_turns IS NOT NULL))
);

CREATE INDEX maps_publication ON maps (state, published_at DESC, id);
CREATE INDEX maps_title ON maps (lower(title), id) WHERE state = 'published';
CREATE INDEX maps_tags ON maps USING gin (tags);

COMMIT;
