import { createHash } from 'node:crypto';
import { ContractError, LIMITS } from '../shared/contracts.ts';
import { HEX_GRID_AREA, MAX_HEX_ID } from './hex-grid.ts';

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
function factionAmounts(value: Data, label: string, maxFactionId: number): void {
  for (const [target, amount] of Object.entries(record(value, label)))
    if (!/^\d+$/.test(target) || Number(target) > maxFactionId || typeof amount !== 'number' || Math.abs(amount) > 1_000_000) fail(`Invalid ${label}`);
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
  return parseMapData(encoded, false);
}

/** PR-reviewed static maps use native browser rules, never the public replay validator. */
export function parseCuratedMap(encoded: string): ParsedMap {
  return parseMapData(encoded, true);
}

function parseMapData(encoded: string, curated: boolean): ParsedMap {
  const state = record(decodeKonkrData(encoded), 'map state');
  allowed(state, ['version', 'map', 'regions', 'factions', 'pawns', 'currentPhase', 'hexHistory'], 'state');
  if (state.version !== 7) fail('Unsupported map schema');
  const map = record(state.map, 'map');
  // This is the PR-reviewed browser catalogue, not the public replay validator.
  // Named scripts below resolve only to built-in modules in pinned release 2.35.30.
  const annotations = ['louder than gods revolver', 'manditory-joke', 'gabagabagoolll', 'gekription'];
  allowed(map, ['width', 'height', 'plugins', 'levelId', 'name', 'author', 'description', 'introduction', 'theme', ...(curated ? ['descriptor', 'winConditions', 'pluginOptions', 'script', 'fixedAIDifficulty', 'id', 'created', ...annotations] : [])], 'map');
  if (curated) {
    text(map.descriptor, 'descriptor', LIMITS.descriptionLength);
    text(map.id, 'legacy map ID', 128);
    for (const key of annotations) text(map[key], 'map annotation', LIMITS.descriptionLength);
    if (map.created !== undefined) integer(map.created, 'creation time', 0, Number.MAX_SAFE_INTEGER);
    if (map.script !== undefined && !['deadIslands1', 'deadIslands2'].includes(map.script as string)) fail('Unsupported map field: script');
    if (map.fixedAIDifficulty !== undefined && !['normal', 'hard'].includes(map.fixedAIDifficulty as string)) fail('Unsupported fixed AI difficulty');
    if (map.pluginOptions !== undefined) {
      const options = record(map.pluginOptions, 'plugin options');
      allowed(options, ['initialTreasury', 'landingSpotPicked'], 'plugin options');
      if (options.initialTreasury !== undefined) integer(options.initialTreasury, 'initial treasury');
      if (options.landingSpotPicked !== undefined && typeof options.landingSpotPicked !== 'boolean') fail('Invalid landing spot flag');
    }
    if (map.winConditions !== undefined) for (const value of array(map.winConditions, 'win conditions', 2)) {
      const condition = record(value, 'win condition');
      allowed(condition, condition.type === 'defeat-rival' ? ['type', 'factionId'] : ['type'], 'win condition');
      if (!['destroy-haunted-towns', 'defeat-all-rivals', 'defeat-rival'].includes(condition.type as string)) fail('Unsupported native win condition');
      if (condition.type === 'defeat-rival') integer(condition.factionId, 'rival faction', 1, 7);
    }
  }
  const width = integer(map.width, 'width', 3, 99);
  const height = integer(map.height, 'height', 3, 99);
  const levelId = text(map.levelId, 'level ID', 128);
  if (!levelId || (!curated && !/^[A-Za-z0-9_-]+$/.test(levelId))) fail('Invalid level ID');
  if (map.theme !== undefined && !['default', 'winter'].includes(map.theme as string)) fail('Unsupported theme');
  text(map.introduction, 'introduction', LIMITS.descriptionLength);
  const plugins = array(map.plugins ?? [], 'plugins', PLUGINS.size).map(value => text(value, 'plugin', 64));
  if (new Set(plugins).size !== plugins.length || plugins.some(plugin => !PLUGINS.has(plugin))) fail('Unsupported plugin');
  const regions = array(state.regions, 'regions', HEX_GRID_AREA);
  const maxFactionId = curated ? 7 : 6;
  const factions = array(state.factions, 'factions', maxFactionId + 1);
  const pawns = array(state.pawns, 'pawns', HEX_GRID_AREA * 4);
  const regionIds = new Set<number>();
  const hexes = new Set<number>();
  for (const value of regions) {
    const region = record(value, 'region');
    allowed(region, ['id', 'name', 'hexes', ...(curated ? ['attrition', 'description', 'introduction'] : [])], 'region');
    if (curated) {
      for (const key of ['description', 'introduction']) text(region[key], 'region annotation', LIMITS.descriptionLength);
      if (region.attrition !== undefined) factionAmounts(region.attrition, 'region attrition', maxFactionId);
    }
    const id = integer(region.id, 'region ID');
    if (regionIds.has(id)) fail('Duplicate region ID');
    regionIds.add(id);
    text(region.name, 'region name', 256);
    for (const value of array(region.hexes, 'region hexes', HEX_GRID_AREA)) {
      // The original importer retains land outside the nominal dimensions.
      // Preserve the file and its rules; bound coordinates by the native grid.
      const hex = integer(value, 'hex', 0, MAX_HEX_ID);
      if (hexes.has(hex)) fail('Overlapping hex');
      hexes.add(hex);
    }
  }
  if (hexes.size === 0) fail('Map has no land');
  const factionIds = new Set<number>();
  const ownedRegions = new Set<number>();
  let localPlayers = 0;
  for (const value of factions) {
    const faction = record(value, 'faction');
    allowed(faction, ['id', 'name', 'themeIndex', 'controller', 'approval', 'credit', 'regions', 'aiPersonality', 'persona', ...(curated ? ['attrition'] : [])], 'faction');
    const id = integer(faction.id, 'faction ID', 0, maxFactionId);
    if (factionIds.has(id)) fail('Duplicate faction ID');
    factionIds.add(id);
    if (!['local-user', 'ai', 'none'].includes(faction.controller as string)) fail('Unsupported controller');
    if (id === 0 && faction.controller !== 'none') fail('Nature must use the neutral controller');
    if (id > 1 && faction.controller !== 'ai') fail('Opponents must use the AI controller');
    if (faction.controller === 'local-user') { localPlayers++; if (id !== 1) fail('Unsupported player faction'); }
    text(faction.name, 'faction name', 256);
    integer(faction.themeIndex, 'faction theme', 0, curated ? 100 : 64);
    for (const value of array(faction.regions, 'faction regions', regions.length)) {
      const regionId = integer(value, 'owned region');
      if (!regionIds.has(regionId) || ownedRegions.has(regionId)) fail('Invalid region ownership');
      ownedRegions.add(regionId);
    }
    for (const field of ['approval', 'credit', ...(curated ? ['attrition'] : [])]) {
      if (faction[field] !== undefined && faction[field] !== null) {
        factionAmounts(faction[field], field, maxFactionId);
      }
    }
    if (faction.aiPersonality !== undefined) {
      if (!curated) fail('Custom AI personalities require support review');
      const personality = record(faction.aiPersonality, 'AI personality');
      allowed(personality, ['combative', 'daring', 'honorable', 'thrifty', 'ambitious', 'attackSkill', 'defenseSkill'], 'AI personality');
      for (const value of Object.values(personality)) if (typeof value !== 'number' || value < 0 || value > 100) fail('Invalid AI personality');
    }
    if (faction.persona !== undefined && (!curated || !['king', 'goose', 'lich'].includes(faction.persona as string))) fail('Custom AI personalities require support review');
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
    if (!hexes.has(integer(pawn.hex, 'pawn hex', 0, MAX_HEX_ID))) fail('Pawn outside land');
    if (pawn.count !== undefined) integer(pawn.count, 'pawn count', 1, 1_000_000);
    text(pawn.name, 'pawn name', 256);
  }
  const phase = record(state.currentPhase, 'current phase');
  allowed(phase, ['type', 'turnNumber', 'faction', 'tappedUnits'], 'phase');
  if (phase.type !== 'faction-turn' || phase.turnNumber !== 1 || phase.faction !== 1) fail('A published map must start on player turn 1');
  for (const value of array(phase.tappedUnits ?? [], 'tapped units', pawns.length)) if (!pawnIds.has(integer(value, 'tapped unit'))) fail('Unknown tapped unit');
  const history = record(state.hexHistory, 'hex history');
  if (!curated && Object.keys(history).length) fail('A published map must have empty play history');
  if (curated) for (const [hex, value] of Object.entries(history)) {
    if (!/^\d+$/.test(hex) || Number(hex) > MAX_HEX_ID) fail('Invalid history hex');
    const item = record(value, 'hex history entry');
    allowed(item, ['capturedAt', 'spoils', 'previousFactionId'], 'hex history');
    integer(item.capturedAt, 'hex capture turn');
    integer(item.previousFactionId, 'previous faction', 0, maxFactionId);
    if (!['liveHex', 'deadHex', ...PAWNS].includes(item.spoils as string)) fail('Invalid hex spoils');
  }
  return {
    encoded, state, contentHash: createHash('sha256').update(encoded).digest('hex'), width, height, plugins, levelId,
    title: text(map.name, 'title', LIMITS.titleLength, levelId),
    description: text(map.description ?? map.introduction, 'description', LIMITS.descriptionLength),
    creator: text(map.author, 'creator', LIMITS.creatorLength),
  };
}
