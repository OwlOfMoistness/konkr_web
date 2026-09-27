import type { Pool } from 'pg';
import { ContractError, normalizeTags, supports } from '../shared/contracts.ts';
import { nativePlaybackPlugins, supportsPlayback } from '../shared/native-playback.ts';
import type { NativePlaybackPolicy } from '../shared/native-playback.ts';
import type { CatalogEntry, CatalogPage, CatalogQuery, CatalogReader, CatalogSort, SupportedConfigurations } from '../shared/contracts.ts';

export const CATALOG_SORTS: CatalogSort[] = ['name', 'rating', 'completions', 'newest'];
export interface CatalogOptions {
  /** Enable only after the independent validator gate passes. */
  verifiedResultsEnabled?: boolean;
  previewUrl?: (key: string) => string | null;
  nativePlayback?: NativePlaybackPolicy;
}

export function normalizeCatalogQuery(query: CatalogQuery): Required<Pick<CatalogQuery, 'search' | 'tags' | 'sort' | 'limit' | 'offset'>> & Pick<CatalogQuery, 'difficulty'> {
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 120)) throw new ContractError('Search must be at most 120 characters');
  if (query.sort !== undefined && !CATALOG_SORTS.includes(query.sort)) throw new ContractError('Unknown catalog sort');
  if (query.difficulty !== undefined && !['normal', 'hard'].includes(query.difficulty)) throw new ContractError('Unknown difficulty');
  const limit = query.limit ?? 24;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ContractError('Limit must be between 1 and 100');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new ContractError('Offset is out of range');
  return { search: query.search?.trim() ?? '', tags: normalizeTags(query.tags ?? []), sort: query.sort ?? 'newest', difficulty: query.difficulty, limit, offset };
}

export function parseCatalogQuery(params: URLSearchParams): CatalogQuery {
  const allowed = ['search', 'tag', 'sort', 'difficulty', 'limit', 'offset'];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || (key !== 'tag' && params.getAll(key).length > 1)) throw new ContractError('Unknown or repeated query parameter');
  }
  const integer = (name: string): number | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    if (!/^\d+$/.test(value)) throw new ContractError(`Invalid ${name}`);
    return Number(value);
  };
  return normalizeCatalogQuery({ search: params.get('search') ?? undefined, tags: params.getAll('tag'), sort: (params.get('sort') ?? undefined) as CatalogSort | undefined, difficulty: (params.get('difficulty') ?? undefined) as CatalogQuery['difficulty'], limit: integer('limit'), offset: integer('offset') });
}

function visible(entry: CatalogEntry, policy: SupportedConfigurations, difficulty?: CatalogQuery['difficulty'], nativePlayback?: NativePlaybackPolicy): boolean {
  return entry.map.state === 'published' && entry.map.currentRevisionId === entry.revision.id && entry.map.id === entry.revision.mapId &&
    (difficulty ? [difficulty] : ['normal', 'hard'] as const).some(mode => supportsPlayback(policy, entry.revision.engineHash, mode, entry.revision.plugins, nativePlayback));
}

function publicEntry(entry: CatalogEntry, policy: SupportedConfigurations, options: CatalogOptions, difficulty?: CatalogQuery['difficulty']): CatalogEntry {
  const copy = structuredClone(entry);
  copy.scores = options.verifiedResultsEnabled ? copy.scores.filter(score => score.engineHash === copy.revision.engineHash && (!difficulty || score.difficulty === difficulty) && supports(policy, score.engineHash, score.difficulty, copy.revision.plugins)) : [];
  if (options.previewUrl) copy.previewUrl = copy.revision.previewKey ? options.previewUrl(copy.revision.previewKey) : null;
  return copy;
}

/** A deterministic fixture repository; production uses the parameterized PostgreSQL reader. */
export class InMemoryCatalogReader implements CatalogReader {
  private entries: CatalogEntry[];
  private policy: SupportedConfigurations;
  private options: CatalogOptions;
  constructor(entries: CatalogEntry[], policy: SupportedConfigurations, options: CatalogOptions = {}) {
    this.entries = structuredClone(entries); this.policy = policy; this.options = options;
  }
  async list(query: CatalogQuery): Promise<CatalogPage> {
    const q = normalizeCatalogQuery(query);
    const entries = this.entries.filter(entry => visible(entry, this.policy, q.difficulty, this.options.nativePlayback) && entry.map.metadata.title.toLowerCase().includes(q.search.toLowerCase()) && q.tags.every(tag => entry.map.metadata.tags.includes(tag)))
      .map(entry => publicEntry(entry, this.policy, this.options, q.difficulty));
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const completions = (entry: CatalogEntry) => entry.scores.reduce((sum, score) => sum + score.completions, 0);
    entries.sort((a, b) => {
      let order = 0;
      if (q.sort === 'name') order = compare(a.map.metadata.title.toLowerCase(), b.map.metadata.title.toLowerCase());
      if (q.sort === 'newest') order = compare(b.map.publishedAt ?? '', a.map.publishedAt ?? '');
      if (q.sort === 'rating') order = (b.rating.average ?? -1) - (a.rating.average ?? -1) || b.rating.count - a.rating.count;
      if (q.sort === 'completions') order = completions(b) - completions(a);
      return order || compare(a.map.id, b.map.id);
    });
    return { entries: entries.slice(q.offset, q.offset + q.limit), total: entries.length };
  }
  async get(mapId: string): Promise<CatalogEntry | null> {
    const entry = this.entries.find(entry => entry.map.id === mapId && visible(entry, this.policy, undefined, this.options.nativePlayback));
    return entry ? publicEntry(entry, this.policy, this.options) : null;
  }
}

const ORDER_BY: Record<CatalogSort, string> = {
  name: 'lower(title) COLLATE "C" ASC, id COLLATE "C" ASC',
  rating: 'rating_average DESC NULLS LAST, rating_count DESC, id COLLATE "C" ASC',
  completions: 'completions DESC, id COLLATE "C" ASC',
  newest: 'published_at DESC, id COLLATE "C" ASC',
};

/** Both detail and listing share the same publication/support predicate. Policy defaults belong to the composition root. */
export class PostgresCatalogReader implements CatalogReader {
  private db: Pick<Pool, 'query'>;
  private policy: SupportedConfigurations;
  private options: CatalogOptions;
  constructor(db: Pick<Pool, 'query'>, policy: SupportedConfigurations, options: CatalogOptions = {}) { this.db = db; this.policy = policy; this.options = options; }

  private async query(query: CatalogQuery, mapId: string | null): Promise<CatalogPage> {
    const q = normalizeCatalogQuery(query);
    const configurations = this.policy.version === 1 ? this.policy.configurations.filter(config => new Set(config.plugins).size === config.plugins.length) : [];
    // JSON parameters carry data only. The sole SQL fragment is an internal enum lookup.
    const result = await this.db.query<{ total: string; rows: CatalogEntry[] }>(`
      WITH support AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS c("engineHash" text, difficulty text, plugins jsonb)
      ), catalog AS (
        SELECT m.id, m.title, m.published_at, ratings.average AS rating_average, ratings.count AS rating_count,
          COALESCE(scores.completions, 0) AS completions,
          jsonb_build_object(
            'map', jsonb_build_object('id', m.id, 'metadata', jsonb_build_object('title', m.title, 'description', m.description, 'creator', m.creator, 'tags', m.tags),
              'state', m.state, 'currentRevisionId', m.current_revision_id, 'createdAt', m.created_at, 'updatedAt', m.updated_at, 'publishedAt', m.published_at),
            'revision', jsonb_build_object('id', r.id, 'mapId', r.map_id, 'revision', r.revision, 'contentHash', r.content_hash, 'objectKey', r.object_key,
              'engineHash', r.engine_hash, 'plugins', r.plugins, 'width', r.width, 'height', r.height, 'previewKey', r.preview_key, 'createdAt', r.created_at),
            'previewUrl', NULL, 'rating', jsonb_build_object('average', ratings.average, 'count', ratings.count), 'scores', COALESCE(scores.buckets, '[]'::jsonb)
          ) AS entry
        FROM maps m JOIN map_revisions r ON r.id = m.current_revision_id AND r.map_id = m.id
        CROSS JOIN LATERAL (SELECT avg(rating)::float8 AS average, count(*)::integer AS count FROM map_ratings WHERE revision_id = r.id) ratings
        LEFT JOIN LATERAL (
          SELECT sum(b.completions) AS completions, jsonb_agg(jsonb_build_object('difficulty', b.difficulty, 'engineHash', b.engine_hash, 'completions', b.completions, 'bestTurns', b.best_turns) ORDER BY b.difficulty) AS buckets
          FROM map_score_buckets b WHERE $7::boolean AND b.revision_id = r.id AND b.engine_hash = r.engine_hash AND ($4::text IS NULL OR b.difficulty = $4)
            AND EXISTS (SELECT 1 FROM support c WHERE c."engineHash" = r.engine_hash AND c.difficulty = b.difficulty
              AND ARRAY(SELECT p FROM jsonb_array_elements_text(c.plugins) WITH ORDINALITY AS plugins(p, ordinal) ORDER BY ordinal) = r.plugins)
        ) scores ON true
        WHERE m.state = 'published' AND ($8::text IS NULL OR m.id = $8)
          AND position(lower($2::text) in lower(m.title)) > 0 AND m.tags @> $3::text[]
          AND (EXISTS (SELECT 1 FROM support c WHERE c."engineHash" = r.engine_hash AND ($4::text IS NULL OR c.difficulty = $4)
            AND c.difficulty IN ('normal', 'hard')
            AND ARRAY(SELECT p FROM jsonb_array_elements_text(c.plugins) WITH ORDINALITY AS plugins(p, ordinal) ORDER BY ordinal) = r.plugins)
            OR (r.engine_hash = $9::text AND r.plugins <@ $10::text[]
              AND cardinality(r.plugins) = (SELECT count(DISTINCT plugin) FROM unnest(r.plugins) AS plugin)))
      )
      SELECT count(*)::text AS total, COALESCE((SELECT jsonb_agg(page.entry ORDER BY page.ordinal) FROM
        (SELECT entry, row_number() OVER (ORDER BY ${ORDER_BY[q.sort]}) AS ordinal FROM catalog ORDER BY ${ORDER_BY[q.sort]} LIMIT $5 OFFSET $6) page), '[]'::jsonb) AS rows
      FROM catalog`, [JSON.stringify(configurations), q.search, q.tags, q.difficulty ?? null, q.limit, q.offset, this.options.verifiedResultsEnabled === true, mapId, this.options.nativePlayback?.engineHash || null, nativePlaybackPlugins(this.options.nativePlayback)]);
    const row = result.rows[0];
    return { total: Number(row.total), entries: row.rows.map(entry => {
      if (entry.revision.previewKey === null) delete entry.revision.previewKey;
      return publicEntry(entry, this.policy, this.options, q.difficulty);
    }) };
  }
  list(query: CatalogQuery): Promise<CatalogPage> { return this.query(query, null); }
  async get(mapId: string): Promise<CatalogEntry | null> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mapId)) return null;
    return (await this.query({ limit: 1 }, mapId)).entries[0] ?? null;
  }
}

/** Compose with other Fetch-compatible routes; null means this route did not match. */
export function createCatalogRoute(reader: CatalogReader): (request: Request) => Promise<Response | null> {
  return async request => {
    const url = new URL(request.url);
    const match = /^\/api\/maps(?:\/([a-zA-Z0-9_-]{1,128}))?\/?$/.exec(url.pathname);
    if (!match) return null;
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    try {
      if (match[1]) { const entry = await reader.get(match[1]); return entry ? json(entry) : json({ error: 'Map not found' }, 404); }
      return json(await reader.list(parseCatalogQuery(url.searchParams)));
    } catch (error) {
      if (error instanceof ContractError) return json({ error: error.message }, 400);
      // Infrastructure failures remain failures. The host logs them without leaking SQL or credentials.
      throw error;
    }
  };
}
