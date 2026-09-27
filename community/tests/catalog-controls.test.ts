import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { generatedRoot, prepareRuntime } from '../scripts/prepare-runtime.ts';

test('catalogue controls are original Phaser buttons and difficulty toggle, with native typography and accessible actions', { timeout: 120_000 }, async () => {
  await prepareRuntime();
  const bundle = await build({ stdin: { contents: `
    import {bindCatalogControls} from './runtime/catalog-controls.ts';
    import {createDifficultyToggle} from './web/native-controls.ts';
    window.mountCatalogControls = () => {
      const root = document.createElement('section'); root.id='native-catalog-fixture';
      root.style.cssText='position:fixed;inset:0;z-index:30;pointer-events:none';
      root.innerHTML='<button class="catalog-back" style="position:absolute;left:30px;bottom:20px;pointer-events:auto">Back</button><div style="position:absolute;left:180px;bottom:20px;pointer-events:auto"><div class="toggle-anchor"></div></div><button class="catalog-primary" style="position:absolute;left:420px;bottom:20px;pointer-events:auto">Play map</button><div class="catalog-detail-actions" style="position:absolute;left:620px;bottom:20px;pointer-events:auto"><button data-difficulty="hard">Resume Hard game</button></div>';
      const actions = {back:0,play:0,resume:0,difficulty:'normal'}; window.catalogActions=actions;
      root.querySelector('.catalog-back').onclick=()=>actions.back++;
      root.querySelector('.catalog-primary').onclick=()=>actions.play++;
      root.querySelector('.catalog-detail-actions button').onclick=()=>actions.resume++;
      root.querySelector('.toggle-anchor').append(createDifficultyToggle(['normal','hard'],'normal', value=>actions.difficulty=value));
      document.body.append(root);
      window.catalogControls = window.communityReference.withEngine(load=>bindCatalogControls(load, root));
    };
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.xml': 'text/xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.css': 'text/css' };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/catalog-controls-test.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].text); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.resolve(generatedRoot, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      if (!file.startsWith(generatedRoot + path.sep)) throw new Error('Invalid path');
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => window.communityReference?.ready && window.communityReference.withEngine(load => !load(55151).app.navigator.transitionInProgress));
    await page.addScriptTag({ url: '/catalog-controls-test.js' });
    await page.evaluate(() => (window as any).mountCatalogControls());
    await page.waitForFunction(() => document.querySelectorAll('.catalog-phaser-control').length === 4);
    const inspect = () => page.evaluate(() => window.communityReference.withEngine(load => {
      const scene = load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-'));
      const buttons = scene.children.list.filter((object: any) => object instanceof load(64323).BoxButton);
      const toggle = scene.children.list.find((object: any) => object instanceof load(22093).DifficultyToggle);
      return { buttons: buttons.map((object: any) => ({ label: object.content.text.text, font: object.content.text.font, size: object.content.text.fontSize, height: object.height, width: object.width, frame: object.box.frame.name, state: object.controller.getState(), x: object.x, y: object.y, visible: object.visible, icon:object.content.icon.frame.name, iconScale:object.content.icon.scaleX, textFits:object.content.text.x >= 0 && object.content.text.x + object.content.text.width <= object.width, iconFits:object.content.icon.x-object.content.icon.displayWidth/2 >= 0 && object.content.icon.x+object.content.icon.displayWidth/2 <= object.width })),
        toggle: { width: toggle.width, height: toggle.height, selected: toggle.selectedValue, fonts: toggle.buttons.map((button: any) => button.content.text.font), icons: toggle.buttons.map((button: any) => button.content.icon.frame.name) }, visible: scene.sys.isVisible() };
    }));
    const initial = await inspect();
    assert.deepEqual(initial.buttons.map((button: any) => [button.label, button.font, button.size, button.width, button.height]), [['BACK', 'Main', 24, 120, 46], ['PLAY MAP', 'Main', 24, 180, 46], ['RESUME', 'Main', 24, 180, 46]]);
    assert.equal(initial.buttons[2].icon, 'ui/level-icons/gold'); assert.equal(initial.buttons[2].iconScale, .5);
    assert(initial.buttons.every((button: any) => button.textFits && button.iconFits), 'Original bitmap captions and icons fit without clipping');
    assert.deepEqual(initial.toggle, { width: 200, height: 42, selected: 'normal', fonts: ['Mini', 'Mini'], icons: ['ui/level-icons/silver', 'ui/level-icons/gold'] });
    if (process.env.KONKR_NATIVE_CONTROL_SCREENSHOT) await page.screenshot({ path: process.env.KONKR_NATIVE_CONTROL_SCREENSHOT });
    const originalBack = await page.evaluate(() => window.communityReference.withEngine(load => {
      const button = load(55151).app.scene.menuHeaderUI.backButton.largeUI?.button;
      // The large variant is created lazily; the original factory is the shared source in either case.
      const exemplar = button ?? load(48041).UiBuilder.for(load(55151).app.scene.globalUI).wood.primaryButton({ text:'BACK',icon:'ui/wood-icons/arrow-left',iconPlacement:'left',width:120 });
      const result = {font:exemplar.content.text.font,size:exemplar.content.text.fontSize,width:exemplar.width,height:exemplar.height,frame:exemplar.box.frame.name};
      if (!button) exemplar.destroy(); return result;
    }));
    assert.deepEqual(originalBack, { font:'Main',size:24,width:120,height:46,frame:'ui/box/dialog-button' });
    const back = page.getByRole('button', { name: 'Back', exact: true });
    await back.hover(); await page.mouse.down();
    await page.waitForFunction(() => window.communityReference.withEngine(load => load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-')).children.list.some((object: any) => object.content?.text?.text === 'BACK' && object.box.frame.name === 'ui/box/dialog-button-down')));
    assert.equal((await inspect()).buttons[0].frame, 'ui/box/dialog-button-down');
    await page.mouse.up();
    assert.equal(await page.evaluate(() => (window as any).catalogActions.back), 1, 'One pointer action dispatches once');
    await back.focus(); await back.press('Enter');
    assert.equal(await page.evaluate(() => (window as any).catalogActions.back), 2, 'One keyboard action dispatches once');
    const normal = page.getByRole('radio', { name:'Normal',exact:true });
    await normal.focus(); await normal.press('ArrowRight');
    await page.waitForFunction(() => (window as any).catalogActions.difficulty === 'hard');
    await page.waitForFunction(() => window.communityReference.withEngine(load => load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-')).children.list.some((object: any) => object.selectedValue === 'hard')));
    assert.equal((await inspect()).toggle.selected, 'hard');
    const play = page.locator('.catalog-primary');
    await play.evaluate(button => { (button as HTMLButtonElement).disabled = true; button.textContent = 'Starting…'; });
    await page.waitForFunction(() => window.communityReference.withEngine(load => load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-')).children.list.some((object: any) => object.content?.text?.text === 'STARTING…' && object.controller.getState() === 'disabled')));
    await play.evaluate(button => (button as HTMLButtonElement).click());
    assert.equal(await page.evaluate(() => (window as any).catalogActions.play), 0);
    await page.getByRole('button', { name:'Resume Hard game',exact:true }).click();
    assert.equal(await page.evaluate(() => (window as any).catalogActions.resume), 1);
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForFunction(() => window.communityReference.withEngine(load => {
      const scene=load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-'));
      return scene.children.list.some((object: any) => object.content?.text?.text === 'BACK' && object.y === 634);
    }));
    assert.equal((await inspect()).buttons[0].y, 634, 'The actual native object follows its resized DOM anchor');
    await page.evaluate(() => document.querySelector('.catalog-detail-actions')!.replaceChildren());
    await page.waitForFunction(() => window.communityReference.withEngine(load => load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-')).children.list.filter((object: any) => object instanceof load(64323).BoxButton).length === 2));
    await page.evaluate(() => document.getElementById('native-catalog-fixture')!.hidden = true);
    await page.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.game.scene.getScenes(true).find((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-')).sys.isVisible()));
    await page.evaluate(() => { document.getElementById('native-catalog-fixture')!.hidden = false; (window as any).catalogControls.refresh(); });
    assert.equal((await inspect()).visible, true);
    await page.evaluate(() => (window as any).catalogControls.destroy());
    await page.waitForFunction(() => window.communityReference.withEngine(load => !load(55151).app.game.scene.getScenes(true).some((scene: any) => scene.scene.key.startsWith('CommunityCatalogControls-'))));
    assert.equal(await page.locator('.catalog-phaser-control').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.communityReference.errors), []);
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
