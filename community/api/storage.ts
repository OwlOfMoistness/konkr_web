import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage } from '../shared/contracts.ts';

const MAGIC = 'KONKR-OBJECT-v1\n';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validType = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]{1,100}$/.test(value);

/** Private blob store. Only authorized API handlers decide which objects can be served. */
export class LocalObjectStorage implements ObjectStorage {
  private root: Promise<string>;
  private maxBytes: number;
  constructor(directory: string, maxBytes = 4_000_000) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_000_000) throw new Error('Invalid object size limit');
    const absolute = path.resolve(directory);
    this.root = mkdir(absolute, { recursive: true, mode: 0o700 }).then(() => realpath(absolute));
    this.maxBytes = maxBytes;
  }
  private async filename(key: string, create: boolean): Promise<string> {
    if (typeof key !== 'string' || key.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(key)) throw new Error('Invalid object key');
    const segments = key.split('/');
    if (segments.some(segment => !segment || segment.startsWith('.') || segment.length > 128)) throw new Error('Invalid object key');
    let parent = await this.root;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      if (create) await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      try { if (!(await lstat(parent)).isDirectory()) throw new Error('Object parent must be a real directory'); }
      catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return path.join(await this.root, ...segments); throw error; }
    }
    return path.join(parent, segments.at(-1)!);
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (bytes.byteLength > this.maxBytes || !validType(contentType)) throw new Error('Invalid object size or content type');
    const filename = await this.filename(key, true);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const header = Buffer.from(MAGIC + JSON.stringify({ contentType, length: bytes.byteLength, sha256: digest(bytes) }) + '\n');
      await file.writeFile(Buffer.concat([header, bytes])); await file.sync(); await file.close();
      await rename(temporary, filename);
      const directory = await open(path.dirname(filename), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }
  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const filename = await this.filename(key, false);
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.maxBytes + 512) throw new Error('Invalid stored object size');
      const data = await file.readFile();
      const end = data.indexOf(10, Buffer.byteLength(MAGIC));
      if (!data.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC)) || end < MAGIC.length || end > 512) throw new Error('Invalid stored object header');
      const header = JSON.parse(data.subarray(MAGIC.length, end).toString('utf8'));
      const bytes = data.subarray(end + 1);
      if (!validType(header.contentType) || header.length !== bytes.byteLength || digest(bytes) !== header.sha256) throw new Error('Stored object integrity check failed');
      return { bytes, contentType: header.contentType };
    } finally { await file.close(); }
  }
  async delete(key: string): Promise<void> {
    await unlink(await this.filename(key, false)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
