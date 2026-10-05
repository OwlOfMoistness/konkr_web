import type { CatalogEntry, CatalogReader } from '../shared/contracts.ts';
import type { StaticCatalog } from '../shared/static-catalog.ts';
import type { VisitorClient } from './ratings.ts';
import { createStaticCatalogReader } from './static-catalog.ts';

/** Explicit bearer requests avoid third-party cookies on GitHub Pages. Nothing is sent during play. */
export function createVotingClient(origin: string, catalog: StaticCatalog, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, fetcher: typeof fetch = fetch) {
  const key = `konkr.community.voter.v1:${origin}`;
  let pendingToken: Promise<string> | undefined;
  const token = (): Promise<string> => pendingToken ??= (async () => {
    let saved: string | null;
    try { saved = storage.getItem(key); } catch { throw new Error('Allow browser storage to save a rating'); }
    if (saved && /^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(saved)) return saved;
    const response = await fetcher(origin + '/v1/session', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not start voting');
    if (typeof data.token !== 'string' || !/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(data.token)) throw new Error('Invalid voting session');
    try { storage.setItem(key, data.token); } catch { throw new Error('Allow browser storage to save a rating'); }
    return data.token as string;
  })().catch(error => { pendingToken = undefined; throw error; });
  const update = (id: string, data: { revisionId: string; rating: CatalogEntry['rating'] }) => {
    const entry = catalog.entries.find(entry => entry.map.id === id && entry.revision.id === data.revisionId);
    const rating = data.rating;
    if (entry && rating && Number.isInteger(rating.count) && rating.count >= 0 && (rating.count === 0 ? rating.average === null : typeof rating.average === 'number' && rating.average >= 1 && rating.average <= 5)) entry.rating = { ...rating };
  };
  let generation = 0;
  const visitor: VisitorClient = {
    csrfToken: token,
    async request(input, init) {
      const match = /^\/api\/maps\/([A-Za-z0-9_-]{1,128})\/ratings$/.exec(String(input));
      if (!match) throw new Error('Unsupported voting request');
      const send = async () => {
        const headers = new Headers(init?.headers); headers.delete('X-CSRF-Token'); headers.set('Authorization', 'Bearer ' + await token());
        return fetcher(origin + '/v1/maps/' + match[1] + '/ratings', { ...init, headers, credentials: 'omit', signal: AbortSignal.timeout(5000) });
      };
      let response = await send();
      if (response.status === 401) {
        storage.removeItem(key); pendingToken = undefined; response = await send();
      }
      if (response.ok && init?.method === 'PUT') { generation++; update(match[1], await response.clone().json()); }
      return response;
    },
  };
  let nextRefresh = 0, refreshing: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    if (Date.now() < nextRefresh) return Promise.resolve();
    const version = generation; nextRefresh = Date.now() + 30000;
    return refreshing = (async () => {
      try {
        const response = await fetcher(origin + '/v1/ratings', { credentials: 'omit', signal: AbortSignal.timeout(2000) });
        if (!response.ok) return;
        const data = await response.json();
        if (generation === version && data.ratings && typeof data.ratings === 'object') for (const [id, rating] of Object.entries(data.ratings)) update(id, rating as Parameters<typeof update>[1]);
      } catch { /* Voting outages must not prevent browsing, previewing or playing static maps. */ }
      finally { refreshing = undefined; }
    })();
  };
  const local = createStaticCatalogReader(catalog);
  const reader: CatalogReader = { async list(query) { await refresh(); return local.list(query); }, get: id => local.get(id) };
  return { visitor, reader };
}
