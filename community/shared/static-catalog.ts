import type { CatalogEntry } from './contracts.ts';

/** Build output: immutable map bytes and their PR-reviewed catalogue metadata. */
export interface StaticCatalog {
  version: 1;
  engineHash: string;
  entries: CatalogEntry[];
  maps: Record<string, string>;
}
