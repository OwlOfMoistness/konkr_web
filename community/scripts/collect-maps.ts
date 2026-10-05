import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseCuratedMap } from '../engine/map-format.ts';
import { LIMITS, normalizeTags } from '../shared/contracts.ts';
import type { StaticCatalog } from '../shared/static-catalog.ts';

/** A flat folder deliberately keeps curator PRs simple: one map, optional matching JSON. */
export async function collectMaps(directory: string, engineHash: string): Promise<StaticCatalog> {
  const catalog: StaticCatalog = { version: 1, engineHash, entries: [], maps: {} };
  const files = await readdir(directory, { withFileTypes: true });
  const names = new Set(files.filter(file => file.isFile()).map(file => file.name));
  const ids = new Set<string>();
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (file.isSymbolicLink()) throw new Error(`Symlinks are not catalogue inputs: ${file.name}`);
    if (!file.name.endsWith('.konkr') || !file.isFile()) continue;
    try {
      const sidecar = file.name.slice(0, -6) + '.json';
      const metadata = names.has(sidecar) ? JSON.parse(await readFile(path.join(directory, sidecar), 'utf8')) : {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(key => !['id', 'title', 'creator', 'description', 'tags', 'added', 'draft', 'draftReason'].includes(key))) throw new Error('Unknown metadata field');
      if (metadata.draft !== undefined && typeof metadata.draft !== 'boolean') throw new Error('Invalid metadata draft flag');
      if (metadata.draft) {
        if (typeof metadata.draftReason !== 'string' || !metadata.draftReason.trim() || metadata.draftReason.length > 1000) throw new Error('Drafts need a brief draftReason');
        continue;
      }
      if (metadata.draftReason !== undefined) throw new Error('Remove draftReason when publishing a draft');
      const encoded = await readFile(path.join(directory, file.name), 'utf8');
      const map = parseCuratedMap(encoded);
      const string = (key: string, fallback: string, max: number): string => {
        const value = metadata[key] ?? fallback;
        if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid metadata ${key}`);
        return value;
      };
      const id = string('id', map.levelId, 128);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate map ID; assign a unique id in its JSON metadata');
      ids.add(id);
      const added = string('added', '1970-01-01', 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(added) || !Number.isFinite(Date.parse(added)) || new Date(added).toISOString().slice(0, 10) !== added) throw new Error('Invalid metadata added date (YYYY-MM-DD)');
      const date = added + 'T00:00:00.000Z';
      const revisionId = 'r-' + map.contentHash;
      const title = string('title', map.title === map.levelId ? file.name.slice(0, -6).replaceAll('-', ' ') : map.title, LIMITS.titleLength);
      if (!title.trim()) throw new Error('Map title cannot be empty');
      catalog.entries.push({
        map: { id, metadata: { title, creator: string('creator', map.creator, LIMITS.creatorLength), description: string('description', map.description, LIMITS.descriptionLength), tags: normalizeTags(metadata.tags ?? map.plugins) },
          state: 'published', currentRevisionId: revisionId, createdAt: date, updatedAt: date, publishedAt: date },
        revision: { id: revisionId, mapId: id, revision: 1, contentHash: map.contentHash, objectKey: map.contentHash,
          engineHash, plugins: map.plugins, width: map.width, height: map.height, createdAt: date },
        previewUrl: null, rating: { average: null, count: 0 }, scores: [],
      });
      catalog.maps[map.contentHash] = encoded;
    } catch (error) { throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!catalog.entries.length) throw new Error('The community maps folder contains no maps');
  for (const name of names) if (name.endsWith('.json') && !names.has(name.slice(0, -5) + '.konkr')) throw new Error(`Metadata has no matching map: ${name}`);
  return catalog;
}
