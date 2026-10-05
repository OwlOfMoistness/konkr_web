import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectMaps } from './collect-maps.ts';
import type { VotingManifest } from '../voting/manifest.ts';

/** Shares the static site's parser/IDs; map bytes and original game code never enter the API image. */
export async function buildVotingManifest(): Promise<VotingManifest> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const release = JSON.parse(await readFile(path.join(root, 'runtime/manifest.json'), 'utf8'));
  const catalog = await collectMaps(path.join(root, '..', 'community maps'), release.files[release.main]);
  return { version: 1, maps: catalog.entries.map(entry => ({ id: entry.map.id, revisionId: entry.revision.id })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass the output manifest filename');
  await writeFile(process.argv[2], JSON.stringify(await buildVotingManifest()));
}
