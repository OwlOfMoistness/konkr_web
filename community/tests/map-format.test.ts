import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContractError, LIMITS } from '../shared/contracts.ts';
import { decodeKonkrData, parseMap } from '../engine/map-format.ts';

const map = () => ({ version: 7, map: { width: 5, height: 5, levelId: 'test-map', name: 'Map', plugins: [] as string[] }, regions: [{ id: 1, hexes: [101, 102] }], factions: [{ id: 0, controller: 'none', themeIndex: 0, regions: [] }, { id: 1, controller: 'local-user', themeIndex: 0, regions: [1] }], pawns: [{ id: 1, type: 'town', hex: 101 }], currentPhase: { type: 'faction-turn', turnNumber: 1, faction: 1, tappedUnits: [] }, hexHistory: {} });
const encode = (value: unknown) => 'konkrmap.v7.' + Buffer.from(JSON.stringify(value)).toString('base64');

test('parses bounded data while preserving the exact file and plugin order', () => {
  const data = map();
  data.map.plugins = ['spawn-gifts', 'buy-gifts'];
  const encoded = encode(data);
  const parsed = parseMap(encoded);
  assert.equal(parsed.encoded, encoded);
  assert.deepEqual(parsed.plugins, data.map.plugins);
  assert.equal(parsed.contentHash.length, 64);
  assert.deepEqual(parsed.state, data);
  const unicode = map(); unicode.map.name = 'Étoile 雪';
  assert.equal(parseMap(encode(unicode)).title, unicode.map.name);
});

test('invalid references, controllers, duplicates and executable additions fail before runtime', () => {
  const variants = [
    { ...map(), map: { ...map().map, script: 'fetch("https://example.invalid")' } },
    { ...map(), pawns: [{ id: 1, type: 'town', hex: 404 }] },
    { ...map(), regions: [{ id: 1, hexes: [101] }, { id: 2, hexes: [101] }] },
    { ...map(), currentPhase: { ...map().currentPhase, turnNumber: 10 } },
    { ...map(), factions: [{ id: 1, controller: 'remote', regions: [1] }] },
    { ...map(), map: { ...map().map, plugins: ['load-external-code'] } },
    { ...map(), hexHistory: { 101: [2] } },
    { ...map(), map: { ...map().map, fixedAIDifficulty: 'hard' } },
    { ...map(), regions: [{ id: 1, hexes: [101], attrition: 'wrong-type' }] },
  ];
  for (const value of variants) assert.throws(() => parseMap(encode(value)), ContractError);
});

test('rejects malformed encoding, truncation, nesting and resource exhaustion', () => {
  assert.throws(() => decodeKonkrData('konkrmap.v7.%%%='), ContractError);
  assert.throws(() => decodeKonkrData('konkrmap.v7.' + Buffer.from([0xc4, 1]).toString('base64')), ContractError);
  assert.throws(() => decodeKonkrData(encode(map()), 'konkrmap.v7.', 20), /too large/);
  assert.throws(() => decodeKonkrData('x'.repeat(LIMITS.encodedMapBytes + 1)), /too large/);
  assert.throws(() => decodeKonkrData('konkrmap.v7.' + Buffer.from('{"__proto__":{}}').toString('base64')), /Unsafe/);
  let value: unknown = null;
  for (let index = 0; index < 40; index++) value = [value];
  assert.throws(() => decodeKonkrData(encode(value)), /nesting/);
});

test('user-supplied sample maps decode when a fixture directory is explicitly supplied', async t => {
  const directory = process.env.KONKR_FIXTURE_DIR;
  if (!directory) { t.skip('Set KONKR_FIXTURE_DIR to the local supplied map directory'); return; }
  const prison = parseMap(await readFile(resolve(directory, 'prison.konkr'), 'utf8'));
  const gifts = parseMap(await readFile(resolve(directory, 'escalating-quickly.konkr'), 'utf8'));
  assert.deepEqual([prison.title, prison.width, prison.height], ['Prison', 24, 25]);
  assert.deepEqual(gifts.plugins, ['spawn-gifts', 'buy-gifts']);
});
