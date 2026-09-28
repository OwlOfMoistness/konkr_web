import type { CatalogEntry, Difficulty } from '../shared/contracts.ts';

type ProgressStorage = Pick<Storage, 'getItem' | 'setItem'>;
const keyFor = (entry: CatalogEntry) => 'konkr.community.completed.v1:' + JSON.stringify([
  entry.map.id, entry.revision.id, entry.revision.contentHash, entry.revision.engineHash,
]);

/** Personal browser progress only. This never authorizes a server score or submission. */
export class MapProgress {
  private storage: ProgressStorage;
  constructor(storage: ProgressStorage) { this.storage = storage; }
  completed(entry: CatalogEntry): Difficulty[] {
    try {
      const saved: unknown = JSON.parse(this.storage.getItem(keyFor(entry)) ?? '[]');
      return Array.isArray(saved) ? (['normal', 'hard'] as const).filter(mode => saved.includes(mode)) : [];
    } catch { return []; }
  }
  recordVictory(entry: CatalogEntry, difficulty: Difficulty): void {
    const completed = new Set(this.completed(entry)); completed.add(difficulty);
    this.storage.setItem(keyFor(entry), JSON.stringify([...completed]));
  }
}
