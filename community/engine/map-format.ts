import { createHash } from 'node:crypto';
import { ContractError, LIMITS } from '../shared/contracts.ts';

type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
type ObjectData = { [key: string]: Data };
export interface ParsedMap {
  encoded: string;
  contentHash: string;
  state: ObjectData;
  width: number;
  height: number;
  plugins: string[];
  levelId: string;
  title: string;
  description: string;
  creator: string;
}

const PLUGINS = new Set(['always-retreat', 'buy-gifts', 'buy-towns', 'capture-towns', 'low-upkeep', 'pick-landing-spot', 'spawn-gifts', 'zombies']);
const PAWNS = new Set(['bandit', 'bunny', 'camp', 'castle', 'chest', 'coins', 'dread-knight', 'forest', 'gold-mine', 'haunted-town', 'hero', 'knight', 'ladder-zombie', 'mana', 'pikeman', 'present', 'refuge', 'spawner', 'swamp', 'town', 'town-ruins', 'unique-hero', 'villager', 'zombie']);

function fail(message: string): never { throw new ContractError(message); }
function record(value: Data | undefined, name: string): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${name}`);
  return value;
}
function array(value: Data | undefined, name: string, max = 10_000): Data[] {
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${name}`);
  return value;
}
function integer(value: Data | undefined, name: string, min = 0, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function text(value: Data | undefined, name: string, max: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`Invalid ${name}`);
  return value;
}
function allowed(value: ObjectData, names: string[], label: string): void {
  for (const key of Object.keys(value)) if (!names.includes(key)) fail(`Unsupported ${label} field: ${key}`);
}
function dataOnly(value: unknown, depth = 0): asserts value is Data {
  if (depth > 32) fail('Map nesting too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Non-finite map number'); return; }
  if (Array.isArray(value)) { for (const item of value) dataOnly(item, depth + 1); return; }
  if (!value || typeof value !== 'object') fail('Invalid map data');
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe map field');
    dataOnly(item, depth + 1);
  }
}

/** LZUTF8 framing used by the pinned release; no game code is executed. */
export function decodeKonkrData(encoded: string, prefix: 'konkrmap.v7.' | 'konkrreplay.v7.' = 'konkrmap.v7.', maxOutput: number = LIMITS.decodedMapBytes): Data {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > LIMITS.encodedMapBytes) fail('Encoded data too large');
  if (!encoded.startsWith(prefix)) fail('Unsupported Konkr format');
  const payload = encoded.slice(prefix.length);
  if (!payload || payload.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) fail('Invalid base64');
  const input = Buffer.from(payload, 'base64');
  if (input.toString('base64') !== payload) fail('Noncanonical base64');
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > LIMITS.decodedMapBytes) fail('Invalid decoder limit');
  const output = new Uint8Array(maxOutput);
  let length = 0;
  for (let index = 0; index < input.length;) {
    const byte = input[index++];
    if (byte >>> 6 === 3 && index < input.length && input[index] >>> 7 === 0) {
      const count = byte & 31;
      let distance = input[index++];
      if (byte >>> 5 !== 6) {
        if (index >= input.length) fail('Truncated compression pointer');
        distance = (distance << 8) | input[index++];
      }
      if (count === 0 || distance === 0 || distance > length) fail('Invalid compression pointer');
      if (length + count > maxOutput) fail('Decompressed data too large');
      for (let offset = 0; offset < count; offset++) { output[length] = output[length - distance]; length++; }
    } else {
      if (length >= maxOutput) fail('Decompressed data too large');
      output[length++] = byte;
    }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, length))); }
  catch { fail('Invalid UTF-8 or JSON'); }
  dataOnly(value);
  return value;
}

export function parseMap(encoded: string): ParsedMap {
  const state = record(decodeKonkrData(encoded), 'map state');
  allowed(state, ['version', 'map', 'regions', 'factions', 'pawns', 'currentPhase', 'hexHistory'], 'state');
  if (state.version !== 7) fail('Unsupported map schema');
  const map = record(state.map, 'map');
  // Scripts, custom win conditions and arbitrary rule overrides require a separate
  // reviewed schema/support extension; accepting JSON alone does not make them safe.
  allowed(map, ['width', 'height', 'plugins', 'levelId', 'name', 'author', 'description', 'introduction', 'theme', 'fixedAIDifficulty'], 'map');
  const width = integer(map.width, 'width', 3, 99);
  const height = integer(map.height, 'height', 3, 99);
  const levelId = text(map.levelId, 'level ID', 128);
  if (!/^[A-Za-z0-9_-]+$/.test(levelId)) fail('Invalid level ID');
  if (map.fixedAIDifficulty !== undefined && !['normal', 'hard'].includes(map.fixedAIDifficulty as string)) fail('Invalid fixed difficulty');
  if (map.theme !== undefined && !['default', 'winter'].includes(map.theme as string)) fail('Unsupported theme');
  text(map.introduction, 'introduction', LIMITS.descriptionLength);
  const plugins = array(map.plugins ?? [], 'plugins', PLUGINS.size).map(value => text(value, 'plugin', 64));
  if (new Set(plugins).size !== plugins.length || plugins.some(plugin => !PLUGINS.has(plugin))) fail('Unsupported plugin');
  const regions = array(state.regions, 'regions', width * height);
  const factions = array(state.factions, 'factions', 7);
  const pawns = array(state.pawns, 'pawns', width * height * 4);
  const regionIds = new Set<number>();
  const hexes = new Set<number>();
  for (const value of regions) {
    const region = record(value, 'region');
    allowed(region, ['id', 'name', 'hexes'], 'region');
    const id = integer(region.id, 'region ID');
    if (regionIds.has(id)) fail('Duplicate region ID');
    regionIds.add(id);
    text(region.name, 'region name', 256);
    for (const value of array(region.hexes, 'region hexes', width * height)) {
      const hex = integer(value, 'hex', 0, 9999);
      if (Math.floor(hex / 100) >= height || hex % 100 >= width || hexes.has(hex)) fail('Invalid or overlapping hex');
      hexes.add(hex);
    }
  }
  if (hexes.size === 0) fail('Map has no land');
  const factionIds = new Set<number>();
  const ownedRegions = new Set<number>();
  let localPlayers = 0;
  for (const value of factions) {
    const faction = record(value, 'faction');
    allowed(faction, ['id', 'name', 'themeIndex', 'controller', 'approval', 'credit', 'regions', 'aiPersonality', 'persona'], 'faction');
    const id = integer(faction.id, 'faction ID', 0, 6);
    if (factionIds.has(id)) fail('Duplicate faction ID');
    factionIds.add(id);
    if (!['local-user', 'ai', 'none'].includes(faction.controller as string)) fail('Unsupported controller');
    if (id === 0 && faction.controller !== 'none') fail('Nature must use the neutral controller');
    if (id > 1 && faction.controller !== 'ai') fail('Opponents must use the AI controller');
    if (faction.controller === 'local-user') { localPlayers++; if (id !== 1) fail('Unsupported player faction'); }
    text(faction.name, 'faction name', 256);
    integer(faction.themeIndex, 'faction theme', 0, 64);
    for (const value of array(faction.regions, 'faction regions', regions.length)) {
      const regionId = integer(value, 'owned region');
      if (!regionIds.has(regionId) || ownedRegions.has(regionId)) fail('Invalid region ownership');
      ownedRegions.add(regionId);
    }
    for (const field of ['approval', 'credit']) {
      if (faction[field] !== undefined && faction[field] !== null) {
        const values = record(faction[field], field);
        for (const [target, amount] of Object.entries(values))
          if (!/^\d+$/.test(target) || Number(target) > 6 || typeof amount !== 'number' || Math.abs(amount) > 1_000_000) fail(`Invalid ${field}`);
      }
    }
    if (faction.aiPersonality !== undefined || faction.persona !== undefined) fail('Custom AI personalities require support review');
  }
  if (localPlayers !== 1 || !factionIds.has(0) || ownedRegions.size !== regionIds.size) fail('Invalid faction setup');
  const pawnIds = new Set<number>();
  for (const value of pawns) {
    const pawn = record(value, 'pawn');
    allowed(pawn, ['id', 'type', 'hex', 'count', 'name'], 'pawn');
    const id = integer(pawn.id, 'pawn ID');
    if (pawnIds.has(id)) fail('Duplicate pawn ID');
    pawnIds.add(id);
    if (!PAWNS.has(pawn.type as string)) fail('Unsupported pawn type');
    if (!hexes.has(integer(pawn.hex, 'pawn hex', 0, 9999))) fail('Pawn outside land');
    if (pawn.count !== undefined) integer(pawn.count, 'pawn count', 1, 1_000_000);
    text(pawn.name, 'pawn name', 256);
  }
  const phase = record(state.currentPhase, 'current phase');
  allowed(phase, ['type', 'turnNumber', 'faction', 'tappedUnits'], 'phase');
  if (phase.type !== 'faction-turn' || phase.turnNumber !== 1 || phase.faction !== 1) fail('A published map must start on player turn 1');
  for (const value of array(phase.tappedUnits ?? [], 'tapped units', pawns.length)) if (!pawnIds.has(integer(value, 'tapped unit'))) fail('Unknown tapped unit');
  if (Object.keys(record(state.hexHistory, 'hex history')).length) fail('A published map must have empty play history');
  return {
    encoded, state, contentHash: createHash('sha256').update(encoded).digest('hex'), width, height, plugins, levelId,
    title: text(map.name, 'title', LIMITS.titleLength, levelId),
    description: text(map.description ?? map.introduction, 'description', LIMITS.descriptionLength),
    creator: text(map.author, 'creator', LIMITS.creatorLength),
  };
}
