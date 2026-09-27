import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { communityRoot, generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';
import type {} from '../runtime/bootstrap.ts';

test('live original previews isolate storage/gameplay, reuse two engines, render thumbnails and clean up rapid selection', { timeout: 120_000 }, async () => {
  await prepareRuntime();
  const manifest = JSON.parse(await readFile(path.join(communityRoot, 'runtime/manifest.json'), 'utf8'));
  const corpus = JSON.parse(await readFile(path.join(communityRoot, 'tests/fixtures/base-cases.json'), 'utf8'));
  const maps = ['prison-first-turn-normal', 'gifts-two-turns-normal', 'tiny-win-normal'].map(id => corpus.cases.find((entry: { id: string }) => entry.id === id).encodedMap);
  maps.push('konkrreplay.v7.invalid');
  const runtime = await build({ entryPoints: [path.join(communityRoot, 'runtime/live-preview.ts')], bundle: true, platform: 'browser', format: 'iife', write: false });
  const client = await build({ stdin: { contents: `
    import { createLivePreviewPool } from './web/live-preview.ts';
    const maps=${JSON.stringify(maps)};
    let pool=createLivePreviewPool({idleThumbnailMs:60000});const handles=new Map();
    window.previewTest={mount(id,index,thumbnail=false,delay=0){handles.get(id)?.destroy();const root=document.getElementById(id);const handle=pool.mount(root,{key:String(index),title:'Map '+index,thumbnail,loadMap:async()=>{if(delay)await new Promise(r=>setTimeout(r,delay));return maps[index];}});handles.set(id,handle);handle.ready.then(()=>root.dataset.done='true',error=>root.dataset.error=error.name);return handle.ready;},destroy(id){handles.get(id)?.destroy();handles.delete(id);},reset(){pool.destroy();handles.clear();pool=createLivePreviewPool({idleThumbnailMs:60000});},close(){pool.destroy();}};
  `, resolveDir: communityRoot, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  const scripts = (preview: boolean) => `<script defer src="/bootstrap.js"></script>${preview ? '<script defer src="/live-preview-runtime.js"></script>' : ''}<script defer src="/${manifest.vendor}"></script><script defer src="/${manifest.main}"></script>${preview ? '' : '<script defer src="/preview-test.js"></script>'}`;
  const previewHTML = (await readFile(path.join(communityRoot, 'web/index.html'), 'utf8')).replace('<head>', '<head><base href="/">').replace('<script defer src="/community.js"></script>', '').replace('<!-- COMMUNITY_RUNTIME -->', scripts(true));
  const previewCSS = (await Promise.all(['theme','catalog','admin','results'].map(name => readFile(path.join(communityRoot, `web/${name}.css`), 'utf8')))).join('\n');
  const body = '<div id="loader"></div><article id="status"></article><div id="phaser-game"></div><div id="news-box"><article id="news-box-body"></article></div><div id="file-drop-zone" class="hidden"></div>';
  const mime: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.xml': 'text/xml' };
  const requests: string[] = []; let failNextPreview = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost'); requests.push(url.pathname);
    try {
      if (url.pathname === '/community.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end(previewCSS); return; }
      if (url.pathname === '/preview-boot-error.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }).end("parent.postMessage({protocol:'konkr-preview-v1',type:'error',id:''},location.origin)"); return; }
      if (url.pathname === '/community-preview' && failNextPreview) { failNextPreview = false; response.writeHead(503, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/preview-boot-error.js"></script>'); return; }
      if (url.pathname === '/live-preview-runtime.js' || url.pathname === '/preview-test.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(url.pathname === '/preview-test.js' ? client.outputFiles[0].text : runtime.outputFiles[0].text); return; }
      if (url.pathname === '/' || url.pathname === '/community-preview') {
        const preview = url.pathname === '/community-preview';
        response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:${(server.address() as { port: number }).port}/assets/; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'` }).end(preview ? previewHTML : `<!doctype html><meta charset="utf-8"><base href="/"><link rel="icon" href="data:,"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}.hidden{display:none!important}#phaser-game{width:100%;height:100%}.preview{position:absolute;background:#183c4b;z-index:20}#live{left:430px;top:30px;width:500px;height:330px}.thumb{left:20px;width:300px;height:200px}#a{top:20px}#b{top:230px}#c{top:440px}</style>${scripts(false)}${body}<div class="preview" id="live"></div><div class="preview thumb" id="a"></div><div class="preview thumb" id="b"></div><div class="preview thumb" id="c"></div>`); return;
      }
      const file = path.resolve(generatedRoot, '.' + url.pathname); if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Unknown path');
      const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }); page.setDefaultTimeout(25_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(url); await page.waitForFunction(() => window.communityReference?.ready || window.communityReference?.errors.length);
    assert.deepEqual(await page.evaluate(() => window.communityReference.errors), [], 'Parent game must boot before the preview isolation test');
    await page.evaluate(() => { localStorage.setItem('main-player-save', 'keep-local'); sessionStorage.setItem('main-session', 'keep-session'); document.cookie = 'preview-test-secret=private; SameSite=Strict'; });
    const original = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), state: JSON.stringify(window.communityReference.inspect().state), cookie: document.cookie }));
    await page.evaluate(() => { const p = (window as any).previewTest; void p.mount('live', 2); void p.mount('a', 0, true); void p.mount('b', 1, true); void p.mount('c', 2, true); });
    try { await page.waitForFunction(() => ['live','a','b','c'].every(id => document.getElementById(id)!.dataset.done === 'true')); }
    catch (error) { throw new Error(JSON.stringify({ cause: String(error), diagnostics: await page.evaluate(() => ({ boxes: ['live','a','b','c'].map(id => ({ id, text: document.getElementById(id)?.textContent, data: { ...document.getElementById(id)?.dataset } })), frames: [...document.querySelectorAll('iframe')].map(frame => ({ url: frame.src, ready: frame.contentWindow?.communityReference?.ready, errors: frame.contentWindow?.communityReference?.errors })) })) })); }
    assert.equal(await page.locator('iframe[data-community-preview]').count(), 2);
    for (const id of ['a','b','c']) assert((await page.locator(`#${id} canvas`).evaluate(canvas => {
      const data = (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 384, 256).data; const colors = new Set();
      for (let i = 0; i < data.length; i += 16) if (data[i + 3]) colors.add(`${data[i]}:${data[i+1]}:${data[i+2]}`); return colors.size;
    })) > 10, 'Thumbnail must contain actual rendered map pixels');
    const live = page.frames().find(frame => frame.url().endsWith('/community-preview') && frame !== page.mainFrame())!;
    const canvasBox = await live.locator('#phaser-game canvas').boundingBox();
    assert(canvasBox && canvasBox.width > 0 && canvasBox.height > 0, 'Ready preview must have a visible DOM canvas, not only a populated framebuffer');
    assert(await live.evaluate(() => window.communityReference.withEngine(load => new Promise<number>(resolve => {
      const { app } = load(55151); app.game.events.once('postrender', async () => {
        const bitmap = await createImageBitmap(app.game.canvas); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close(); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; const colors = new Set();
        for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 3]) colors.add(`${pixels[i]}:${pixels[i+1]}:${pixels[i+2]}`); resolve(colors.size);
      });
    }))) > 10, 'Live production preview must contain rendered map pixels, not only its ocean background');
    assert.equal(await live.evaluate(() => window.communityReference.withEngine(load => load(55151).app.scene.worldMap.mode instanceof load(28208).PreviewMode)), true);
    for (const frame of page.frames().filter(frame => frame.url().endsWith('/community-preview'))) assert.deepEqual(await frame.evaluate(() => window.communityReference.errors), []);
    if (process.env.LIVE_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.LIVE_PREVIEW_SCREENSHOT });
    assert.equal(await live.evaluate(() => window.communityReference.withEngine(load => load(32070).inject.ui.session.active)), false);
    assert.deepEqual(await live.evaluate(() => [localStorage.getItem('main-player-save'), sessionStorage.getItem('main-session'), document.cookie]), [null, null, '']);
    const snapshot = await live.evaluate(() => JSON.stringify(window.communityReference.inspect().state));
    await page.locator('#live').evaluate(node => { (node as HTMLElement).style.width = '330px'; (node as HTMLElement).style.height = '220px'; });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[data-community-preview="live"]')!.contentWindow!.innerWidth === 330);
    await live.waitForFunction(() => window.communityReference.withEngine(load => { const world = load(55151).app.scene.worldMap, view = world.cameras.main.worldView, bounds = world.cameraController.worldBounds; return view.left <= bounds.left && view.top <= bounds.top && view.right >= bounds.right && view.bottom >= bounds.bottom; }));
    assert.equal(await live.evaluate(() => JSON.stringify(window.communityReference.inspect().state)), snapshot, 'Resizing never advances gameplay');
    await page.evaluate(async () => { const p = (window as any).previewTest; void p.mount('live', 1, false, 150).catch(() => {}); await p.mount('live', 2); });
    await live.waitForFunction(() => window.communityReference.inspect().state.map.width === 6);
    assert.equal(await page.locator('iframe[data-community-preview]').count(), 2, 'Rapid selection reuses engines');
    await page.locator('#live').evaluate(node => { (node as HTMLElement).hidden = true; });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[data-community-preview="live"]')!.style.visibility === 'hidden');
    await live.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.game.loop.running));
    await page.evaluate(() => (window as any).previewTest.destroy('live'));
    const sleepingFrame = await live.evaluate(() => window.communityReference.withEngine(load => load(55151).app.game.loop.frame));
    await page.waitForTimeout(100);
    assert.equal(await live.evaluate(() => window.communityReference.withEngine(load => load(55151).app.game.loop.frame)), sleepingFrame, 'Hidden preview must not keep rendering during gameplay');
    await page.locator('#live').evaluate(node => { (node as HTMLElement).hidden = false; });
    await page.evaluate(() => (window as any).previewTest.mount('live', 0));
    await live.waitForFunction(() => window.communityReference.withEngine(load => load(55151).app.game.loop.running));
    assert.deepEqual(await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), state: JSON.stringify(window.communityReference.inspect().state), cookie: document.cookie })), original);
    assert.equal(requests.filter(path => path === '/community-preview').length, 2, 'No per-tile iframe boot or DOM reparent reload');
    assert.equal(requests.some(path => path.startsWith('/api/')), false);
    await page.evaluate(() => (window as any).previewTest.reset()); failNextPreview = true;
    await assert.rejects(page.evaluate(() => (window as any).previewTest.mount('live', 0)), /engine could not start/);
    assert.equal(await page.locator('iframe[data-community-preview]').count(), 0, 'Failed boot must retire its frame');
    await page.evaluate(() => (window as any).previewTest.mount('live', 0));
    assert.equal(await page.locator('iframe[data-community-preview="live"]').count(), 1, 'Retry creates a working replacement');
    await assert.rejects(page.evaluate(() => (window as any).previewTest.mount('live', 3)), /could not be rendered/);
    assert.equal(await page.locator('iframe[data-community-preview]').count(), 0, 'Failed render must also retire its frame');
    await page.evaluate(() => (window as any).previewTest.mount('live', 2));
    await page.evaluate(() => (window as any).previewTest.close());
    assert.equal(await page.locator('iframe[data-community-preview]').count(), 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
