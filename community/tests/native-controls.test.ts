import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('native controls reuse atlas pixels, pressed frames and difficulty trophies with keyboard selection', async () => {
  const bundle = await build({ stdin: { contents: `
    import {initializeNativeAssets,createNativeButton,createDifficultyToggle,trophy} from './web/native-controls.ts';
    async function mount(){
      await Promise.all([initializeNativeAssets(), initializeNativeAssets()]);
      const root=document.querySelector('main');
      const back=createNativeButton('Back');back.classList.add('konkr-back');back.onclick=()=>back.dataset.clicked='yes';
      const publish=createNativeButton('Publish');publish.classList.add('konkr-primary');
      const archive=createNativeButton('Archive');archive.classList.add('konkr-danger');
      const disabled=createNativeButton('Unavailable');disabled.disabled=true;
      const toggle=createDifficultyToggle(['normal','hard'],'normal',value=>root.dataset.difficulty=value);
      const hardOnly=createDifficultyToggle(['hard'],'normal',()=>{});hardOnly.setAttribute('aria-label','Hard only');
      const empty=createDifficultyToggle([],'normal',()=>{});empty.setAttribute('aria-label','Unavailable difficulty');
      root.append(back,publish,archive,disabled,toggle,hardOnly,empty,trophy('normal','Normal victory'),trophy('hard','Hard victory'));
    }
    mount().catch(error=>{const alert=document.createElement('p');alert.setAttribute('role','alert');alert.textContent=error.message;document.body.append(alert);});
  `, loader: 'ts', resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'browser', format: 'iife' });
  const css = await readFile(new URL('../web/theme.css', import.meta.url), 'utf8');
  const atlas = JSON.parse(await readFile(new URL('../../_site/releases/2.35.30/assets/atlas.json', import.meta.url), 'utf8'));
  const image = await readFile(new URL('../../_site/releases/2.35.30/assets/atlas.png', import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === '/assets/atlas.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return; }
    if (request.url === '/assets/atlas.json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(atlas)); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(`<!doctype html><style>${css}</style><main class="konkr-ui"></main><script>${bundle.outputFiles[0].text}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const requests: string[] = []; page.on('request', request => requests.push(request.url()));
    await page.goto(origin); await page.getByRole('button', { name: 'Back', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-native-controls'), 'ready');
    assert.equal(requests.filter(url => url === origin + '/assets/atlas.json').length, 1, 'Initialization is shared');
    assert.equal(requests.filter(url => url === origin + '/assets/atlas.png').length, 1);
    assert.equal(requests.every(url => url.startsWith(origin)), true, 'All original assets are same-origin');
    const crops = await page.evaluate(async () => {
      const manifest = await (await fetch('/assets/atlas.json')).json();
      const atlas = new Image(); atlas.src = '/assets/atlas.png'; await atlas.decode();
      const styles = getComputedStyle(document.documentElement);
      const frames = [
        ['--konkr-native-button', 'ui/box/dialog-button'],
        ['--konkr-native-button-down', 'ui/box/dialog-button-down'],
        ['--konkr-native-trophy-normal', 'ui/level-icons/silver'],
        ['--konkr-native-trophy-hard', 'ui/level-icons/gold'],
        ['--konkr-native-back', 'ui/wood-icons/arrow-left'],
      ];
      return Promise.all(frames.map(async ([property, name]) => {
        const frame = manifest.textures[0].frames.find((item: { filename: string }) => item.filename === name).frame;
        const expected = document.createElement('canvas'); expected.width = frame.w; expected.height = frame.h;
        expected.getContext('2d')!.drawImage(atlas, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
        return { name, exact: styles.getPropertyValue(property).includes(expected.toDataURL('image/png')) };
      }));
    });
    assert(crops.every(crop => crop.exact), 'Buttons and trophies use the exact original atlas pixels');
    const back = page.getByRole('button', { name: 'Back', exact: true });
    const resting = await back.evaluate(node => getComputedStyle(node).borderImageSource);
    assert(resting.startsWith('url("data:image/png;base64,'));
    assert.equal(await back.evaluate(node => getComputedStyle(node).borderImageSlice), '16 fill');
    await back.hover(); assert.equal(await back.evaluate(node => getComputedStyle(node).borderImageSource), resting, 'Native BoxButton hover retains its frame');
    await page.mouse.down();
    const pressed = await back.evaluate(node => getComputedStyle(node).borderImageSource);
    assert.notEqual(pressed, resting, 'Pressing selects the original pressed texture');
    await page.mouse.up(); assert.equal(await back.getAttribute('data-clicked'), 'yes');
    assert.equal(await back.evaluate(node => getComputedStyle(node).borderImageSource), resting);
    const green = await page.getByRole('button', { name: 'Publish', exact: true }).evaluate(node => getComputedStyle(node).borderImageSource);
    const red = await page.getByRole('button', { name: 'Archive', exact: true }).evaluate(node => getComputedStyle(node).borderImageSource);
    assert.notEqual(green, resting); assert.notEqual(red, resting); assert.notEqual(green, red);
    const disabled = page.getByRole('button', { name: 'Unavailable', exact: true });
    assert.equal(await disabled.isDisabled(), true); await disabled.hover(); await page.mouse.down();
    assert.equal(await disabled.evaluate(node => getComputedStyle(node).borderImageSource), resting, 'Disabled controls retain the resting artwork');
    await page.mouse.up();
    const group = page.getByRole('radiogroup', { name: 'Play difficulty', exact: true });
    const normal = group.getByRole('radio', { name: 'Normal', exact: true });
    const hard = group.getByRole('radio', { name: 'Hard', exact: true });
    assert.equal(await normal.getAttribute('aria-checked'), 'true'); assert.equal(await hard.getAttribute('tabindex'), '-1');
    assert.deepEqual(await normal.locator('.konkr-trophy').evaluate(node => ({ width: getComputedStyle(node).width, height: getComputedStyle(node).height })), { width: '13.5px', height: '19px' });
    await normal.focus(); await normal.press('ArrowRight');
    assert.equal(await hard.getAttribute('aria-checked'), 'true'); assert.equal(await page.locator('main').getAttribute('data-difficulty'), 'hard');
    assert.equal(await group.locator('.konkr-difficulty-highlight').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(200, 55, 55)');
    await hard.press('Home'); assert.equal(await normal.getAttribute('aria-checked'), 'true');
    await normal.press('ArrowLeft'); assert.equal(await hard.getAttribute('aria-checked'), 'true', 'Keyboard selection wraps');
    await normal.click(); assert.equal(await normal.getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('radiogroup', { name: 'Hard only', exact: true }).getByRole('radio', { name: 'Hard', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('radiogroup', { name: 'Unavailable difficulty', exact: true }).getAttribute('aria-disabled'), 'true');
    assert.equal(await page.getByRole('img', { name: 'Normal victory', exact: true }).count(), 1);
    assert.equal(await page.getByRole('img', { name: 'Hard victory', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    const failed = await browser.newPage();
    await failed.route('**/assets/atlas.json', route => route.fulfill({ json: { textures: [{ image: 'atlas.png', size: atlas.textures[0].size, frames: [] }] } }));
    await failed.goto(origin); await failed.getByRole('alert').filter({ hasText: 'frame is unavailable' }).waitFor();
    assert.equal(await failed.locator('html').getAttribute('data-native-controls'), null, 'Missing assets produce an explicit error instead of a styled imitation');
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
