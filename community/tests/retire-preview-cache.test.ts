import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { ObjectStorage } from '../shared/contracts.ts';
import { retirePreviewCache } from '../scripts/retire-preview-cache.ts';

const url = process.env.CATALOG_TEST_DATABASE_URL;
describe('legacy generated preview retirement', {skip:!url}, () => {
  const schema = `retire_preview_${process.pid}`;
  let admin: Pool; let db: Pool; let failDelete = true;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]);
  const objects = new Map<string,{bytes:Uint8Array;contentType:string}>(); const deleted: string[] = [];
  const storage: ObjectStorage = {
    async get(key) { return objects.get(key) ?? null; },
    async put(key,bytes,contentType) { objects.set(key,{bytes,contentType}); },
    async delete(key) { if (key === 'previews/retry.png' && failDelete) throw new Error('Temporary storage failure'); deleted.push(key); objects.delete(key); },
  };
  before(async () => {
    admin = new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({connectionString:url,options:`-c search_path=${schema}`});
    await db.query(await readFile(new URL('../db/001-catalog.sql',import.meta.url),'utf8'));
    const fixtures = [
      ['good','previews/good.png','maps/good.konkr'],
      ['missing','previews/missing.png','maps/missing.konkr'],
      ['retry','previews/retry.png','maps/retry.konkr'],
      ['arbitrary','uploads/picture.png','maps/arbitrary.konkr'],
      ['wrong-id','previews/someone-else.png','maps/wrong-id.konkr'],
      ['same-file','previews/same-file.png','previews/same-file.png'],
      ['protected','previews/protected.png','maps/protected.konkr'],
      ['map-owner',null,'previews/protected.png'],
      ['shared','previews/shared.png','maps/shared.konkr'],
      ['other-shared','previews/shared.png','maps/other-shared.konkr'],
      ['not-png','previews/not-png.png','maps/not-png.konkr'],
    ];
    for (const [id,preview,objectKey] of fixtures) {
      await db.query('INSERT INTO maps(id,title) VALUES($1,$1)',[id]);
      await db.query('INSERT INTO map_revisions(id,map_id,revision,content_hash,object_key,engine_hash,plugins,width,height,preview_key) VALUES($1,$1,1,$1,$2,$3,$4,5,5,$5)',[id,objectKey,'engine',[],preview]);
      await storage.put(objectKey!,Buffer.from('original-map:'+id),'application/vnd.konkr.map');
      if (preview && !['missing','same-file','protected'].includes(id!)) await storage.put(preview,png,'image/png');
    }
    await storage.put('previews/not-png.png',Buffer.from('not a PNG'),'text/plain');
    await storage.put('previews/unreferenced.png',png,'image/png');
  });
  after(async()=>{await db?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  it('defaults to a dry run and leaves all objects and references untouched',async()=>{
    const before = JSON.stringify((await db.query('SELECT id,preview_key FROM map_revisions ORDER BY id')).rows);
    const report = await retirePreviewCache(db,storage);
    assert.deepEqual(report,{mode:'dry-run',examinedReferences:10,eligibleReferences:3,skippedReferences:7,failedReferences:0,missingObjects:1,deletedObjects:0,clearedReferences:0});
    assert.deepEqual(deleted,[]);
    assert.equal(JSON.stringify((await db.query('SELECT id,preview_key FROM map_revisions ORDER BY id')).rows),before);
  });
  it('deletes only exact referenced PNG caches, preserves maps and retries failed deletions',async()=>{
    const originals = (await db.query('SELECT object_key FROM map_revisions')).rows.map(row=>row.object_key);
    const originalBytes = originals.map(key=>Buffer.from(objects.get(key)!.bytes).toString('base64'));
    const report = await retirePreviewCache(db,storage,true);
    assert.equal(report.deletedObjects,1);assert.equal(report.clearedReferences,2);assert.equal(report.failedReferences,1);assert.equal(report.skippedReferences,7);
    assert.deepEqual(deleted,['previews/good.png']);
    assert.equal((await db.query("SELECT preview_key FROM map_revisions WHERE id='retry'")).rows[0].preview_key,'previews/retry.png');
    assert.deepEqual(originals.map(key=>Buffer.from(objects.get(key)!.bytes).toString('base64')),originalBytes);
    assert.ok(objects.has('previews/unreferenced.png'));assert.ok(objects.has('uploads/picture.png'));assert.ok(objects.has('previews/shared.png'));
    failDelete=false;const retried=await retirePreviewCache(db,storage,true);
    assert.equal(retried.deletedObjects,1);assert.equal(retried.clearedReferences,1);assert.equal(retried.failedReferences,0);assert.equal(retried.skippedReferences,7);
    assert.deepEqual(deleted,['previews/good.png','previews/retry.png']);
    const again=await retirePreviewCache(db,storage,true);assert.equal(again.deletedObjects,0);assert.equal(again.clearedReferences,0);assert.equal(again.skippedReferences,7);
  });
});
