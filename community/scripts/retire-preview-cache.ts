import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { ObjectStorage } from '../shared/contracts.ts';
import { LocalObjectStorage } from '../api/storage.ts';

export interface PreviewRetirementReport {
  mode: 'dry-run' | 'apply';
  examinedReferences: number;
  eligibleReferences: number;
  skippedReferences: number;
  failedReferences: number;
  missingObjects: number;
  deletedObjects: number;
  clearedReferences: number;
}
interface PreviewReference { id: string; preview_key: string; object_key: string }
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);

/** Retire only the old renderer's revision-specific PNG cache. Map files are never deleted. */
export async function retirePreviewCache(db: Pick<Pool, 'connect'>, storage: ObjectStorage, apply = false): Promise<PreviewRetirementReport> {
  const report: PreviewRetirementReport = { mode: apply ? 'apply' : 'dry-run', examinedReferences: 0, eligibleReferences: 0, skippedReferences: 0, failedReferences: 0, missingObjects: 0, deletedObjects: 0, clearedReferences: 0 };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Prevent new file/preview references appearing between validation and deletion.
    if (apply) await client.query('LOCK TABLE map_revisions IN SHARE ROW EXCLUSIVE MODE');
    const references = (await client.query<PreviewReference>('SELECT id,preview_key,object_key FROM map_revisions WHERE preview_key IS NOT NULL ORDER BY id')).rows;
    report.examinedReferences = references.length;
    const protectedObjects = new Set((await client.query<{object_key:string}>('SELECT object_key FROM map_revisions WHERE object_key = ANY($1::text[])', [references.map(row => row.preview_key)])).rows.map(row => row.object_key));
    const keyCounts = new Map<string,number>();
    for (const row of references) keyCounts.set(row.preview_key, (keyCounts.get(row.preview_key) ?? 0) + 1);
    for (const row of references) {
      const key = row.preview_key;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || key !== `previews/${row.id}.png` || key === row.object_key || protectedObjects.has(key) || keyCounts.get(key) !== 1) {
        report.skippedReferences++; continue;
      }
      let object: Awaited<ReturnType<ObjectStorage['get']>>;
      try { object = await storage.get(key); }
      catch { report.failedReferences++; continue; }
      if (object && (object.contentType !== 'image/png' || object.bytes.length < 24 || object.bytes.length > 2_000_000 || !Buffer.from(object.bytes.subarray(0,8)).equals(pngSignature))) {
        report.skippedReferences++; continue;
      }
      report.eligibleReferences++;
      if (!object) report.missingObjects++;
      if (!apply) continue;
      if (object) {
        try { await storage.delete(key); report.deletedObjects++; }
        catch { report.failedReferences++; continue; }
      }
      // Delete first: a storage failure leaves the reference available for a retry.
      // If the database commit fails, rerunning safely clears the now-missing cache reference.
      await client.query('UPDATE map_revisions SET preview_key=NULL WHERE id=$1 AND preview_key=$2', [row.id, key]);
      report.clearedReferences++;
    }
    await client.query('COMMIT');
    return report;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/retire-preview-cache.ts [--dry-run | --apply]\nUses DATABASE_URL and COMMUNITY_DATA_DIR, matching the app. Defaults to dry-run.'); return;
  }
  if (args.length > 1 || args.some(arg => !['--dry-run','--apply'].includes(arg))) throw new Error('Use --dry-run or --apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
  try {
    const storage = new LocalObjectStorage(process.env.COMMUNITY_DATA_DIR ?? fileURLToPath(new URL('../.data', import.meta.url)));
    const report = await retirePreviewCache(db, storage, args[0] === '--apply');
    console.log(JSON.stringify(report));
    if (report.failedReferences) process.exitCode = 1;
  } finally { await db.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => {
  console.error('Preview cleanup failed. Check the arguments, database and object-storage configuration.'); process.exitCode = 1;
});
