import type { Pool, PoolClient } from 'pg';

export interface Rating { average: number | null; count: number }
export class VotingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** This service has its own tables/database; it never migrates the dormant community backend. */
export async function initializeVoting(db: Pool): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS voting_votes (
    map_id text NOT NULL, revision_id text NOT NULL, voter_hash text NOT NULL,
    rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(map_id,revision_id,voter_hash)
  );
  CREATE TABLE IF NOT EXISTS voting_limits (
    key text NOT NULL, scope text NOT NULL, hour bigint NOT NULL,
    used integer NOT NULL CHECK(used>0), PRIMARY KEY(key,scope,hour)
  );
  CREATE INDEX IF NOT EXISTS voting_limits_hour ON voting_limits(hour);`);
}

export async function quota(db: Pick<PoolClient, 'query'>, key: string, scope: string, maximum: number): Promise<void> {
  const result = await db.query(`INSERT INTO voting_limits(key,scope,hour,used)
    VALUES($1,$2,floor(extract(epoch FROM now())/3600)::bigint,1)
    ON CONFLICT(key,scope,hour) DO UPDATE SET used=voting_limits.used+1
    WHERE voting_limits.used<$3 RETURNING used`, [key, scope, maximum]);
  if (!result.rowCount) throw new VotingError(429, 'Too many requests. Please try again later.');
}

export class VotingStore {
  private readonly db: Pool;
  constructor(db: Pool) { this.db = db; }
  async vote(map: string, revision: string, voter: string, rating: number, ip: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await quota(client, ip, 'votes-ip', 120);
      await quota(client, voter, 'votes-browser', 30);
      await client.query(`INSERT INTO voting_votes(map_id,revision_id,voter_hash,rating) VALUES($1,$2,$3,$4)
        ON CONFLICT(map_id,revision_id,voter_hash) DO UPDATE SET rating=$4,updated_at=now()`, [map, revision, voter, rating]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async rating(map: string, revision: string, voter: string): Promise<{ rating: Rating; mine: number | null }> {
    const { rows } = await this.db.query(`SELECT avg(rating)::float8 AS average,count(*)::integer AS count,
      max(rating) FILTER(WHERE voter_hash=$3)::integer AS mine FROM voting_votes WHERE map_id=$1 AND revision_id=$2`, [map, revision, voter]);
    return { rating: { average: rows[0].average, count: rows[0].count }, mine: rows[0].mine };
  }
  async summaries(maps: Map<string, string>): Promise<Record<string, { revisionId: string; rating: Rating }>> {
    const entries = [...maps];
    const { rows } = await this.db.query(`SELECT v.map_id,v.revision_id,avg(v.rating)::float8 AS average,count(*)::integer AS count
      FROM voting_votes v JOIN unnest($1::text[],$2::text[]) AS allowed(map_id,revision_id)
      ON v.map_id=allowed.map_id AND v.revision_id=allowed.revision_id GROUP BY v.map_id,v.revision_id`,
    [entries.map(([id]) => id), entries.map(([, revision]) => revision)]);
    return Object.fromEntries(entries.map(([id, revisionId]) => {
      const row = rows.find(row => row.map_id === id);
      return [id, { revisionId, rating: { average: row?.average ?? null, count: row?.count ?? 0 } }];
    }));
  }
}
