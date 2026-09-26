import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalObjectStorage } from '../api/storage.ts';

test('local storage preserves private bytes atomically and detects corrupt objects', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'konkr-objects-')); t.after(() => rm(root, { recursive:true,force:true }));
  const storage = new LocalObjectStorage(root);
  assert.equal(await storage.get('missing/object'), null);
  const versions = ['first', 'second', 'third'].map(value => Buffer.from(value.repeat(50_000)));
  await Promise.all(versions.map(bytes => storage.put('maps/map.konkr', bytes, 'application/vnd.konkr.map')));
  const stored = await storage.get('maps/map.konkr'); assert.ok(stored);
  assert.ok(versions.some(bytes => bytes.equals(stored.bytes))); assert.equal(stored.contentType, 'application/vnd.konkr.map');
  const filename = path.join(root,'maps/map.konkr'); const raw = await readFile(filename); raw[raw.length-1] ^= 1; await writeFile(filename,raw);
  await assert.rejects(storage.get('maps/map.konkr'), /integrity/);
  await storage.delete('maps/map.konkr'); assert.equal(await storage.get('maps/map.konkr'),null); await storage.delete('missing/object');
});

test('local storage rejects traversal, symlinks and oversized writes', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'konkr-objects-')); const outside=await mkdtemp(path.join(tmpdir(),'konkr-outside-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
  const storage = new LocalObjectStorage(root,100);
  for(const key of ['../secret','/absolute','a/../b','.hidden','a//b','a/%2e%2e/b','a\\b']) await assert.rejects(storage.put(key,Buffer.from('x'),'text/plain'),/key/);
  await assert.rejects(storage.put('too-large',Buffer.alloc(101),'text/plain'),/size/);
  await assert.rejects(storage.put('type',Buffer.from('x'),'text/html\r\nX: bad'),/type/);
  await symlink(outside,path.join(root,'escape'));
  await assert.rejects(storage.put('escape/file',Buffer.from('x'),'text/plain'),/directory/);
  await writeFile(path.join(outside,'secret'),'private'); await symlink(path.join(outside,'secret'),path.join(root,'link'));
  await assert.rejects(storage.get('link'));
});
