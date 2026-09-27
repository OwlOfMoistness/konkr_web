import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MapProgress } from '../web/map-progress.ts';
import type { CatalogEntry } from '../shared/contracts.ts';

test('personal trophies persist per revision/engine and difficulty without claiming verified results', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const entry = { map: { id: 'island' }, revision: { id: 'revision', contentHash: 'hash', engineHash: 'engine' } } as CatalogEntry;
  const progress = new MapProgress(storage);
  assert.deepEqual(progress.completed(entry), []);
  progress.recordVictory(entry, 'hard'); progress.recordVictory(entry, 'hard');
  assert.deepEqual(new MapProgress(storage).completed(entry), ['hard']);
  progress.recordVictory(entry, 'normal');
  assert.deepEqual(progress.completed(entry), ['normal', 'hard']);
  for (const field of ['id', 'contentHash', 'engineHash'] as const) assert.deepEqual(progress.completed({ ...entry, revision: { ...entry.revision, [field]: 'different' } }), []);
  assert.deepEqual(progress.completed({ ...entry, map: { ...entry.map, id: 'different' } }), []);
  assert.equal([...values.keys()].some(key => key.includes('pending') || key.includes('issued')), false);
  values.set([...values.keys()][0], 'broken JSON');
  assert.deepEqual(progress.completed(entry), []);
});
