import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Difficulty } from '../shared/contracts.ts';
import { parseMap } from '../engine/map-format.ts';
import { generatedRoot } from '../scripts/prepare-runtime.ts';
import type {} from './bootstrap.ts';

export interface PreviewRenderer { render(encoded: string, difficulty: Difficulty): Promise<Uint8Array> }
/** One isolated browser per job, only curated data and the checksum-pinned local runtime. */
export class BrowserPreviewRenderer implements PreviewRenderer {
  private active = false;
  private directory: string;
  private timeoutMs: number;
  constructor(directory = generatedRoot, timeoutMs = 20_000) { this.directory = path.resolve(directory); this.timeoutMs = timeoutMs; }
  async render(encoded: string, difficulty: Difficulty): Promise<Uint8Array> {
    parseMap(encoded);
    if (this.active) throw new Error('Preview renderer busy; retry shortly');
    this.active = true;
    const mime: Record<string,string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
    const server = createServer((request, response) => {
      void (async () => {
        const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
        const filename = path.resolve(this.directory, relative);
        if (!filename.startsWith(this.directory + path.sep)) { response.writeHead(404).end(); return; }
        try { const bytes = await readFile(filename); response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes); }
        catch { response.writeHead(404).end(); }
      })().catch(() => response.writeHead(400).end());
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true, timeout: this.timeoutMs });
      const page = await browser.newPage({ viewport: { width: 900, height: 675 }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(this.timeoutMs);
      const external: string[] = []; const errors: string[] = [];
      await page.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
      page.on('pageerror', error => errors.push(error.message));
      const job = (async () => {
        await page.goto(origin);
        await page.waitForFunction(() => window.communityReference?.ready);
        const result = await page.evaluate(async ({ encoded, difficulty }) => window.communityReference.importMap(encoded, difficulty), { encoded, difficulty });
        if (result.difficulty !== difficulty || result.screen !== 'Play') throw new Error('Preview import did not enter the requested game');
        await page.evaluate(() => window.communityReference.withEngine(async requireModule => {
          const { app } = requireModule(55151);
          const world = app.scene.worldMap;
          // Hide presentation scenes only, then frame the complete board using the
          // original camera controller (30306) and its bounds (94586).
          for (const scene of app.game.scene.getScenes(true)) if (scene !== world) scene.scene.setVisible(false);
          world.cameraController.setViewportMargins({});
          world.cameraController.updateBounds();
          const bounds = world.cameraController.worldBounds;
          const camera = world.cameras.main;
          const inverseZoom = Math.max(bounds.width / camera.width, bounds.height / camera.height) * 1.08;
          // Module 11537 maps camera distance through this quadratic before
          // applying zoom. Invert that presentation transform for a full-board fit.
          const distance = (0.0952381 + Math.sqrt(0.0952381 ** 2 - 4 * 0.0654762 * (0.357143 - inverseZoom))) / (2 * 0.0654762);
          world.cameraController.zoomController.zoomTo(distance, 'instant');
          await world.cameraController.center(0);
        }));
        // Let the original renderer finish its first frame; gameplay state is untouched.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const framed = await page.evaluate(() => window.communityReference.withEngine(requireModule => {
          const world = requireModule(55151).app.scene.worldMap;
          const bounds = world.cameraController.worldBounds;
          const view = world.cameras.main.worldView;
          return view.left <= bounds.left && view.right >= bounds.right && view.top <= bounds.top && view.bottom >= bounds.bottom;
        }));
        if (!framed) throw new Error('Preview does not include the entire map');
        const unchanged = await page.evaluate(state => JSON.stringify(window.communityReference.inspect().state) === JSON.stringify(state), result.state);
        if (!unchanged) throw new Error('Preview presentation changed game state');
        const bytes = await page.locator('#phaser-game canvas').screenshot({ animations: 'disabled' });
        const diagnostic = await page.evaluate(() => ({ errors: window.communityReference.errors, blocked: window.communityReference.blockedRequests }));
        if (external.length || errors.length || diagnostic.errors.length || diagnostic.blocked.length) throw new Error('Preview runtime isolation or rendering failed');
        if (bytes.length > 2_000_000) throw new Error('Preview exceeds size limit');
        return new Uint8Array(bytes);
      })();
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { void browser?.close(); reject(new Error('Preview timed out')); }, this.timeoutMs); });
      return await Promise.race([job, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      await browser?.close(); server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      this.active = false;
    }
  }
}
