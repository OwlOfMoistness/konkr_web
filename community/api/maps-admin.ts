import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LIMITS, normalizeTags } from '../shared/contracts.ts';
import type { MapMetadata, ObjectStorage } from '../shared/contracts.ts';
import { parseMap } from '../engine/map-format.ts';
import { AdminError, CuratorAuth, adminResponse, audit, errorResponse, readJson, requireFields } from './admin-auth.ts';

function string(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AdminError(400, 'Invalid metadata text');
  return value.trim();
}
export function parseMetadata(value: unknown): MapMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminError(400, 'Invalid metadata');
  const data = value as Record<string, unknown>; requireFields(data, ['title', 'description', 'creator', 'tags']);
  return { title: string(data.title, LIMITS.titleLength, true), description: string(data.description, LIMITS.descriptionLength), creator: string(data.creator, LIMITS.creatorLength), tags: normalizeTags(data.tags as string[]) };
}
export async function lockMap(client: PoolClient, id: string, expectedVersion: unknown): Promise<any> {
  if (typeof expectedVersion !== 'string' || !/^\d+$/.test(expectedVersion)) throw new AdminError(400, 'Expected map version required');
  const result = await client.query('SELECT *,xmin::text AS version FROM maps WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows.length) throw new AdminError(404, 'Map not found');
  if (result.rows[0].version !== expectedVersion) throw new AdminError(409, 'This map changed. Reload before editing.');
  return result.rows[0];
}
export async function inTransaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export class MapsAdmin {
  db: Pool;
  storage: ObjectStorage;
  auth: CuratorAuth;
  engineHash: string;
  constructor(db: Pool, storage: ObjectStorage, auth: CuratorAuth, engineHash: string) { this.db = db; this.storage = storage; this.auth = auth; this.engineHash = engineHash; }
  async detail(id: string): Promise<any> {
    const result = await this.db.query('SELECT *,xmin::text AS version FROM maps WHERE id=$1', [id]);
    if (!result.rows.length) throw new AdminError(404, 'Map not found');
    return { map: result.rows[0], revisions: (await this.db.query('SELECT * FROM map_revisions WHERE map_id=$1 ORDER BY revision DESC', [id])).rows };
  }
  async route(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = /^\/api\/admin\/maps(?:\/([A-Za-z0-9_-]{1,128})(\/revisions)?)?$/.exec(url.pathname);
    if (!match) return null;
    try {
      const actor = await this.auth.require(request, 'curator', request.method !== 'GET');
      const id = match[1]; const revisions = !!match[2];
      if (request.method === 'GET' && !revisions) {
        if (id) return adminResponse(await this.detail(id));
        const offset = url.searchParams.get('offset') ?? '0';
        if (!/^\d{1,6}$/.test(offset) || [...url.searchParams.keys()].some(key => key !== 'offset')) throw new AdminError(400, 'Invalid pagination');
        return adminResponse({ maps: (await this.db.query('SELECT id,title,state,current_revision_id,updated_at,xmin::text AS version FROM maps ORDER BY updated_at DESC,id LIMIT 50 OFFSET $1', [Number(offset)])).rows });
      }
      if (request.method === 'PATCH' && id && !revisions) {
        const data = await readJson(request); requireFields(data, ['expectedVersion', 'metadata']); const metadata = parseMetadata(data.metadata);
        await inTransaction(this.db, async client => {
          await lockMap(client, id, data.expectedVersion);
          await client.query('UPDATE maps SET title=$2,description=$3,creator=$4,tags=$5,updated_at=now() WHERE id=$1', [id, metadata.title, metadata.description, metadata.creator, metadata.tags]);
          await audit(client, actor, 'metadata-edit', id);
        });
        return adminResponse(await this.detail(id));
      }
      if (request.method === 'POST' && ((!id && !revisions) || (id && revisions))) {
        const data = await readJson(request, LIMITS.encodedMapBytes + 16_384);
        requireFields(data, id ? ['encoded', 'expectedVersion'] : ['encoded']);
        if (typeof data.encoded !== 'string') throw new AdminError(400, 'Expected a .konkr map');
        const parsed = parseMap(data.encoded);
        const mapId = id ?? randomUUID(); const revisionId = randomUUID(); const objectKey = `maps/${parsed.contentHash}.konkr`;
        const conflicts = await inTransaction(this.db, async client => {
          // Serialize equal file uploads; immutable content can be shared safely, but a duplicate is explicit.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [parsed.contentHash]);
          if (id) await lockMap(client, id, data.expectedVersion);
          const duplicate = await client.query('SELECT map_id FROM map_revisions WHERE content_hash=$1 LIMIT 1', [parsed.contentHash]);
          if (duplicate.rows.length) throw new AdminError(409, `This exact file already belongs to map ${duplicate.rows[0].map_id}`);
          if (!id) {
            const metadata = parseMetadata({ title: parsed.title || parsed.levelId, description: parsed.description, creator: parsed.creator, tags: [] });
            await client.query('INSERT INTO maps(id,title,description,creator,tags) VALUES($1,$2,$3,$4,$5)', [mapId, metadata.title, metadata.description, metadata.creator, metadata.tags]);
          }
          const revision = Number((await client.query('SELECT COALESCE(max(revision),0)+1 AS next FROM map_revisions WHERE map_id=$1', [mapId])).rows[0].next);
          // Private immutable blob precedes its database reference. A failed commit leaves only a GC-able orphan.
          await this.storage.put(objectKey, Buffer.from(parsed.encoded), 'application/vnd.konkr.map');
          await client.query(`INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height,embedded_level_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [revisionId, mapId, revision, parsed.contentHash, objectKey, this.engineHash, parsed.plugins, parsed.width, parsed.height, parsed.levelId]);
          await client.query("UPDATE maps SET current_revision_id=$2,state='draft',updated_at=now() WHERE id=$1", [mapId, revisionId]);
          await audit(client, actor, id ? 'revision-upload' : 'map-upload', mapId, { revisionId, contentHash: parsed.contentHash });
          return (await client.query('SELECT DISTINCT map_id FROM map_revisions WHERE embedded_level_id=$1 AND map_id<>$2', [parsed.levelId, mapId])).rows.map(row => row.map_id);
        });
        return adminResponse({ ...await this.detail(mapId), warnings: conflicts.length ? ['The embedded level ID is also used by another map. Community saves use the revision identity.'] : [] }, 201);
      }
      return adminResponse({ error: 'Method not allowed' }, 405);
    } catch (error) { return errorResponse(error); }
  }
}
