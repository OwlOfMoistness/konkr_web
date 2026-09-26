/** Community-owned boundary. Engine internals and uploaded snapshots are never commands. */
export type Difficulty = 'normal' | 'hard';
export type PublicationState = 'draft' | 'published' | 'archived';
export type CatalogSort = 'name' | 'rating' | 'completions' | 'newest';
export type CuratorRole = 'curator' | 'admin';

export interface MapMetadata {
  title: string;
  description: string;
  creator: string;
  tags: string[];
}

export interface MapRevision {
  id: string;
  mapId: string;
  revision: number;
  contentHash: string;
  objectKey: string;
  engineHash: string;
  plugins: string[];
  width: number;
  height: number;
  previewKey?: string;
  createdAt: string;
}

export interface MapRecord {
  id: string;
  metadata: MapMetadata;
  state: PublicationState;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface ScoreBucket {
  difficulty: Difficulty;
  engineHash: string;
  completions: number;
  bestTurns: number | null;
}

export interface CatalogEntry {
  map: MapRecord;
  revision: MapRevision;
  previewUrl: string | null;
  rating: { average: number | null; count: number };
  scores: ScoreBucket[];
}

export interface CatalogQuery {
  search?: string;
  tags?: string[];
  sort?: CatalogSort;
  difficulty?: Difficulty;
  limit?: number;
  offset?: number;
}

export interface CatalogPage { entries: CatalogEntry[]; total: number }
export interface CatalogReader {
  list(query: CatalogQuery): Promise<CatalogPage>;
  get(mapId: string): Promise<CatalogEntry | null>;
}

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/** Exact tested combinations, rather than a permissive list of individual plugins. */
export interface SupportedConfiguration {
  engineHash: string;
  difficulty: Difficulty;
  plugins: string[];
  evidence: string;
}
export interface SupportedConfigurations {
  version: 1;
  configurations: SupportedConfiguration[];
}

export interface RunBinding {
  id: string;
  mapId: string;
  revisionId: string;
  mapHash: string;
  engineHash: string;
  adapterVersion: string;
  difficulty: Difficulty;
  plugins: string[];
  issuedAt: string;
  expiresAt: string;
  seed?: number;
}

export type PlayerDecision =
  | { kind: 'move'; pawnId: number; destinationHexId: number }
  | { kind: 'buy'; pawnType: string; destinationHexId: number; buyerRegionId: number }
  | { kind: 'end-turn' }
  | { kind: 'accept-surrender' }
  | { kind: 'choose-landing'; hexId: number };

export interface ReplaySubmission {
  version: 1;
  runId: string;
  idempotencyKey: string;
  decisions: PlayerDecision[];
}

export type ValidationResult =
  | { status: 'verified'; outcome: 'victory'; turns: number; finalStateHash: string }
  | { status: 'non-winning'; outcome: 'unfinished' | 'defeat'; turns: number }
  | { status: 'invalid'; code: string; decisionIndex?: number }
  | { status: 'unsupported'; code: string }
  | { status: 'error'; code: string; retryable: boolean };

export type PublicRunStatus = { status: 'pending'; runId: string } | ValidationResult;
export interface ValidationInput {
  binding: RunBinding;
  canonicalMap: string;
  decisions: PlayerDecision[];
}
export interface SimulationAdapter {
  validate(input: ValidationInput): Promise<ValidationResult>;
}

export const LIMITS = Object.freeze({
  submissionBytes: 2_000_000,
  decisions: 25_000,
  encodedMapBytes: 500_000,
  decodedMapBytes: 4_000_000,
  titleLength: 120,
  descriptionLength: 4000,
  creatorLength: 120,
  tags: 12,
  tagLength: 32,
});

export class ContractError extends Error {
  constructor(message: string) { super(message); this.name = 'ContractError'; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('Expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ContractError('Unexpected object prototype');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ContractError('Unknown field');
  if (allowed.some(key => !Object.hasOwn(value, key))) throw new ContractError('Missing field');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new ContractError('Invalid identifier');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ContractError('Invalid integer');
  return value;
}

export function parseDecision(value: unknown): PlayerDecision {
  const v = object(value);
  switch (v.kind) {
    case 'move':
      keys(v, ['kind', 'pawnId', 'destinationHexId']);
      return { kind: 'move', pawnId: integer(v.pawnId), destinationHexId: integer(v.destinationHexId) };
    case 'buy':
      keys(v, ['kind', 'pawnType', 'destinationHexId', 'buyerRegionId']);
      return { kind: 'buy', pawnType: identifier(v.pawnType), destinationHexId: integer(v.destinationHexId), buyerRegionId: integer(v.buyerRegionId) };
    case 'end-turn': case 'accept-surrender':
      keys(v, ['kind']);
      return { kind: v.kind };
    case 'choose-landing':
      keys(v, ['kind', 'hexId']);
      return { kind: 'choose-landing', hexId: integer(v.hexId) };
    default: throw new ContractError('Unsupported player decision');
  }
}

/** Parsing is structural only; legality and victory belong to the simulation. */
export function parseSubmission(value: unknown): ReplaySubmission {
  const v = object(value);
  keys(v, ['version', 'runId', 'idempotencyKey', 'decisions']);
  if (v.version !== 1) throw new ContractError('Unsupported submission version');
  if (!Array.isArray(v.decisions) || v.decisions.length > LIMITS.decisions) throw new ContractError('Invalid decision list');
  return { version: 1, runId: identifier(v.runId), idempotencyKey: identifier(v.idempotencyKey), decisions: v.decisions.map(parseDecision) };
}

export function decodeSubmission(text: string): ReplaySubmission {
  if (new TextEncoder().encode(text).byteLength > LIMITS.submissionBytes) throw new ContractError('Submission too large');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ContractError('Invalid JSON'); }
  return parseSubmission(value);
}

export function supports(policy: SupportedConfigurations, engineHash: string, difficulty: Difficulty, plugins: string[]): boolean {
  if (new Set(plugins).size !== plugins.length) return false;
  const requested = [...plugins].sort();
  return policy.version === 1 && policy.configurations.some(config =>
    config.engineHash === engineHash && config.difficulty === difficulty &&
    config.plugins.length === requested.length && [...config.plugins].sort().every((name, index) => name === requested[index]));
}

export function normalizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags) || tags.length > LIMITS.tags) throw new ContractError('Too many tags');
  return [...new Set(tags.map(tag => {
    if (typeof tag !== 'string') throw new ContractError('Invalid tag');
    const normalized = tag.trim().replace(/^#/, '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized) || normalized.length > LIMITS.tagLength) throw new ContractError('Invalid tag');
    return normalized;
  }))];
}
