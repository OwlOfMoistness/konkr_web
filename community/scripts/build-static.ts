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
export async function buildStatic(options: { votingApiOrigin?: string; basePath?: string; mapsDirectory?: string; outputDirectory?: string } = {}): Promise<string> {
  const outputRoot = options.outputDirectory ?? staticRoot;
  const basePath = options.basePath ?? '/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('STATIC_BASE_PATH must be / or a path such as /konkr_web/');
  const votingApiOrigin = options.votingApiOrigin ?? '';
  if (votingApiOrigin) {
    const url = new URL(votingApiOrigin);
    if (url.origin !== votingApiOrigin || url.protocol !== 'https:' || url.username || url.password) throw new Error('VOTING_API_ORIGIN must be an HTTPS origin without a path or trailing slash');
  }
  const manifest = JSON.parse(await readFile(path.join(communityRoot, 'runtime/manifest.json'), 'utf8'));
  const catalog = await collectMaps(options.mapsDirectory ?? path.join(communityRoot, '..', 'community maps'), manifest.files[manifest.main]);
  const catalogJSON = JSON.stringify(catalog);
  const catalogFile = `maps-${hash(catalogJSON)}.json`;
  const runtime = await prepareRuntime();
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(path.join(runtime, 'assets'), path.join(outputRoot, 'assets'), { recursive: true });
  for (const file of [manifest.main, manifest.vendor]) await cp(path.join(runtime, file), path.join(outputRoot, file));
  const bootstrap = await readFile(path.join(runtime, 'bootstrap.js'), 'utf8');
  const bootstrapFile = `bootstrap-${hash(bootstrap)}.js`;
  await writeFile(path.join(outputRoot, bootstrapFile), bootstrap);
  await writeFile(path.join(outputRoot, catalogFile), catalogJSON);
  const bundle = await build({
    entryPoints: [path.join(communityRoot, 'web/static-main.ts'), path.join(communityRoot, 'runtime/live-preview.ts')],
    outdir: outputRoot, entryNames: '[name]-[hash]', bundle: true, platform: 'browser', format: 'iife', target: 'es2023',
    external: ['/assets/*'], define: { STATIC_CATALOG_URL: JSON.stringify(basePath + catalogFile), VOTING_API_ORIGIN: JSON.stringify(votingApiOrigin) }, metafile: true,
    plugins: [{ name: 'static-asset-paths', setup(build) {
      build.onResolve({ filter: /^\/assets\// }, args => ({ path: basePath + args.path.slice(1), external: true }));
    } }],
  });
  const outputFor = (entry: string) => {
    const output = Object.entries(bundle.metafile!.outputs).find(([, info]) => info.entryPoint && path.resolve(info.entryPoint) === path.join(communityRoot, entry));
    if (!output) throw new Error(`Missing static bundle: ${entry}`);
    return { script: basePath + path.basename(output[0]), css: output[1].cssBundle ? basePath + path.basename(output[1].cssBundle) : undefined };
  };
  const player = outputFor('web/static-main.ts');
  const preview = outputFor('runtime/live-preview.ts');
  if (!player.css) throw new Error('Missing static catalogue stylesheet');
  const template = (await readFile(path.join(communityRoot, 'web/index.html'), 'utf8'))
    .replace('<head>', `<head><base href="${basePath}">`)
    .replace('<main id="admin-root" hidden></main>', '')
    .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'${votingApiOrigin ? ' ' + votingApiOrigin : ''}; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'">`);
  const scripts = (extra = '') => `<script defer src="${basePath}${bootstrapFile}"></script>${extra}<script defer src="${basePath}${manifest.vendor}"></script><script defer src="${basePath}${manifest.main}"></script>`;
  await writeFile(path.join(outputRoot, 'index.html'), template
    .replace('<!-- COMMUNITY_RUNTIME -->', scripts())
    .replace('/community.js', player.script).replace('/community.css', player.css));
  await writeFile(path.join(outputRoot, 'community-preview.html'), template
    .replace('<!-- COMMUNITY_RUNTIME -->', scripts(`<script defer src="${preview.script}"></script>`))
    .replace('<script defer src="/community.js"></script>', '')
    .replace('<link rel="stylesheet" href="/community.css">', ''));
  await writeFile(path.join(outputRoot, '.nojekyll'), '');
  return outputRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildStatic({ votingApiOrigin: process.env.VOTING_API_ORIGIN, basePath: process.env.STATIC_BASE_PATH }));
}
