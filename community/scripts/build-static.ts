import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { communityRoot, prepareRuntime } from './prepare-runtime.ts';
import { collectMaps } from './collect-maps.ts';

export const staticRoot = path.join(communityRoot, 'dist');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Only public, generated files are copied. No server, admin, database or profiles. */
export async function buildStatic(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(communityRoot, 'runtime/manifest.json'), 'utf8'));
  const catalog = await collectMaps(path.join(communityRoot, '..', 'community maps'), manifest.files[manifest.main]);
  const catalogJSON = JSON.stringify(catalog);
  const catalogFile = `maps-${hash(catalogJSON)}.json`;
  const runtime = await prepareRuntime();
  await rm(staticRoot, { recursive: true, force: true });
  await mkdir(staticRoot, { recursive: true });
  await cp(path.join(runtime, 'assets'), path.join(staticRoot, 'assets'), { recursive: true });
  for (const file of [manifest.main, manifest.vendor]) await cp(path.join(runtime, file), path.join(staticRoot, file));
  const bootstrap = await readFile(path.join(runtime, 'bootstrap.js'), 'utf8');
  const bootstrapFile = `bootstrap-${hash(bootstrap)}.js`;
  await writeFile(path.join(staticRoot, bootstrapFile), bootstrap);
  await writeFile(path.join(staticRoot, catalogFile), catalogJSON);
  const bundle = await build({
    entryPoints: [path.join(communityRoot, 'web/static-main.ts'), path.join(communityRoot, 'runtime/live-preview.ts')],
    outdir: staticRoot, entryNames: '[name]-[hash]', bundle: true, platform: 'browser', format: 'iife', target: 'es2023',
    external: ['/assets/*'], define: { STATIC_CATALOG_URL: JSON.stringify('/' + catalogFile) }, metafile: true,
  });
  const outputFor = (entry: string) => {
    const output = Object.entries(bundle.metafile!.outputs).find(([, info]) => info.entryPoint && path.resolve(info.entryPoint) === path.join(communityRoot, entry));
    if (!output) throw new Error(`Missing static bundle: ${entry}`);
    return { script: '/' + path.basename(output[0]), css: output[1].cssBundle ? '/' + path.basename(output[1].cssBundle) : undefined };
  };
  const player = outputFor('web/static-main.ts');
  const preview = outputFor('runtime/live-preview.ts');
  if (!player.css) throw new Error('Missing static catalogue stylesheet');
  const template = (await readFile(path.join(communityRoot, 'web/index.html'), 'utf8'))
    .replace('<main id="admin-root" hidden></main>', '')
    .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'">`);
  const scripts = (extra = '') => `<script defer src="/${bootstrapFile}"></script>${extra}<script defer src="/${manifest.vendor}"></script><script defer src="/${manifest.main}"></script>`;
  await writeFile(path.join(staticRoot, 'index.html'), template
    .replace('<!-- COMMUNITY_RUNTIME -->', scripts())
    .replace('/community.js', player.script).replace('/community.css', player.css));
  await writeFile(path.join(staticRoot, 'community-preview.html'), template
    .replace('<!-- COMMUNITY_RUNTIME -->', scripts(`<script defer src="${preview.script}"></script>`))
    .replace('<script defer src="/community.js"></script>', '')
    .replace('<link rel="stylesheet" href="/community.css">', ''));
  await writeFile(path.join(staticRoot, '.nojekyll'), '');
  return staticRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildStatic());
}
