import type { CatalogReader } from '../shared/contracts.ts';
import { normalizeTags } from '../shared/contracts.ts';
import type { StaticCatalog } from '../shared/static-catalog.ts';

/** Search the downloaded release catalogue; this reader makes no network requests. */
export function createStaticCatalogReader(catalog: StaticCatalog): CatalogReader {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return {
    async list(query) {
      const search = query.search?.trim().toLowerCase() ?? '';
      const tags = normalizeTags(query.tags ?? []);
      const entries = catalog.entries.filter(entry => entry.map.metadata.title.toLowerCase().includes(search) && tags.every(tag => entry.map.metadata.tags.includes(tag)));
      entries.sort((a, b) => (query.sort === 'rating' ? (b.rating.average ?? -1) - (a.rating.average ?? -1) || b.rating.count - a.rating.count : 0)
        || (query.sort === 'newest' ? compare(b.map.publishedAt ?? '', a.map.publishedAt ?? '') : 0)
        || compare(a.map.metadata.title.toLowerCase(), b.map.metadata.title.toLowerCase()) || compare(a.map.id, b.map.id));
      return { entries: structuredClone(entries.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 24))), total: entries.length };
    },
    async get(id) { return structuredClone(catalog.entries.find(entry => entry.map.id === id) ?? null); },
  };
}
