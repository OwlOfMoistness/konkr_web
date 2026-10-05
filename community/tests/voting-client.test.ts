import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVotingClient } from '../web/voting-client.ts';
import type { StaticCatalog } from '../shared/static-catalog.ts';

const origin = 'https://votes.example';
const token = 'v1.' + 'a'.repeat(43) + '.' + 'b'.repeat(43);
const catalog = () => ({ version: 1, engineHash: '', maps: {}, entries: [
  { map: { id: 'map', metadata: { title: 'Alpha', tags: [] } }, revision: { id: 'r1' }, rating: { average: null, count: 0 }, scores: [] },
  { map: { id: 'other', metadata: { title: 'Beta', tags: [] } }, revision: { id: 'r2' }, rating: { average: null, count: 0 }, scores: [] },
] }) as unknown as StaticCatalog;
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
test('the voting client reuses a browser identity without cookies and preserves a newer vote over stale totals', async () => {
  const data = catalog(), saved = storage(); let sessions = 0, deliver!: (response: Response) => void;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.credentials, 'omit');
    if (String(input).endsWith('/session')) { sessions++; return Response.json({ token }); }
    if (String(input).endsWith('/v1/ratings')) return new Promise(resolve => { deliver = resolve; });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + token);
    assert.equal(new Headers(init?.headers).has('x-csrf-token'), false);
    return Response.json({ revisionId: 'r1', rating: { average: 5, count: 1 }, mine: 5 });
  };
  const client = createVotingClient(origin, data, saved, fetcher);
  const listing = client.reader.list({ sort: 'rating' });
  await client.visitor.request!('/api/maps/map/ratings', { method: 'PUT', headers: { 'X-CSRF-Token': token } });
  deliver(Response.json({ ratings: { map: { revisionId: 'r1', rating: { average: 1, count: 1 } } } }));
  assert.equal((await listing).entries[0].rating.average, 5);
  await createVotingClient(origin, data, saved, fetcher).visitor.csrfToken(); assert.equal(sessions, 1);
});
test('rating summaries sort locally, ignore stale revisions, and outages leave maps playable', async () => {
  const client = createVotingClient(origin, catalog(), storage(), async () => Response.json({ ratings: {
    map: { revisionId: 'old', rating: { average: 5, count: 30 } },
    other: { revisionId: 'r2', rating: { average: 4, count: 2 } },
  } }));
  assert.deepEqual((await client.reader.list({ sort: 'rating' })).entries.map(entry => entry.map.id), ['other', 'map']);
  assert.equal((await client.reader.get('map'))!.rating.average, null);
  const offline = createVotingClient(origin, catalog(), storage(), async () => { throw new Error('Offline'); });
  assert.equal((await offline.reader.list({})).total, 2);
  assert.equal((await offline.reader.get('map'))!.map.id, 'map');
});
test('session failures can retry and a revoked identity is replaced once', async () => {
  let calls = 0, reads = 0;
  const client = createVotingClient(origin, catalog(), storage(), async input => {
    if (String(input).endsWith('/session')) { if (++calls === 1) throw new Error('Offline'); return Response.json({ token }); }
    return ++reads === 1 ? Response.json({}, { status: 401 }) : Response.json({ mine: null });
  });
  await assert.rejects(client.visitor.csrfToken(), /Offline/);
  assert.equal((await client.visitor.request!('/api/maps/map/ratings')).status, 200);
  assert.equal(calls, 3); assert.equal(reads, 2);
});
