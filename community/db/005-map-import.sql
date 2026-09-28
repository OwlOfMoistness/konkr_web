BEGIN;
ALTER TABLE map_revisions ADD COLUMN embedded_level_id text NOT NULL DEFAULT '';
CREATE INDEX map_revision_embedded_id ON map_revisions(embedded_level_id);
CREATE INDEX map_revision_content_hash ON map_revisions(content_hash);
COMMIT;
