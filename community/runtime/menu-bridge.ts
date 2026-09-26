import type { ReferenceModuleLoader } from './bootstrap.ts';

export async function waitForCommunityEngine(timeoutMs = 20_000): Promise<ReferenceModuleLoader> {
  const deadline = performance.now() + timeoutMs;
  while (!window.communityReference?.ready) {
    if (window.communityReference?.errors.length) throw new Error(window.communityReference.errors.at(-1));
    if (performance.now() >= deadline) throw new Error('The game could not be started. Please reload and try again.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return window.communityReference.withEngine(loader => loader);
}

/** Original calls still run; only their address-bar side effects are removed. */
export function preservePlayerUrl(loader: ReferenceModuleLoader): () => void {
  const urls = loader(71040);
  const previous = { updateUrlHash: urls.updateUrlHash, clearUrlHash: urls.clearUrlHash };
  urls.updateUrlHash = () => {};
  urls.clearUrlHash = () => {};
  return () => Object.assign(urls, previous);
}

/** Add one original-style title button, with a native keyboard/pointer target over its canvas bounds. */
export function installCustomMapsMenu(loader: ReferenceModuleLoader, onOpen: () => void): () => void {
  const { app } = loader(55151);
  const { inject } = loader(32070);
  const scene = app.scene.titleScreenUI;
  const panel = scene.buttonsPanel;
  const custom = new (loader(97623).TitleButton)(scene, {
    text: 'Custom Maps', icon: 'ui/icons/campaign', onClicked: onOpen,
    backgroundColor: inject.theme.getCurrent().oceanShades.dark1,
  });
  panel.buttons.push(custom); panel.add(custom); panel.updateLayout(); scene.preUpdate.makeDirty();
  const target = document.createElement('button');
  target.type = 'button'; target.textContent = 'Custom Maps'; target.setAttribute('aria-label', 'Custom Maps');
  target.dataset.communityMenu = 'custom-maps';
  Object.assign(target.style, { position: 'fixed', zIndex: '8', padding: '0', border: '0', background: 'transparent', color: 'transparent', cursor: 'pointer', borderRadius: '4px' });
  target.addEventListener('click', onOpen);
  target.addEventListener('focus', () => { target.style.outline = '3px solid #f4d072'; });
  target.addEventListener('blur', () => { target.style.outline = ''; });
  document.body.append(target);
  const update = () => {
    const canvas = app.game.canvas as HTMLCanvasElement;
    const shown = app.navigator.currentScreen === app.screen.title && !app.navigator.transitionInProgress && canvas.getClientRects().length > 0 && !document.getElementById('phaser-game')?.classList.contains('hidden');
    target.hidden = !shown;
    if (!shown) return;
    const bounds = custom.getBounds();
    const rect = canvas.getBoundingClientRect();
    const xScale = rect.width / app.game.scale.gameSize.width;
    const yScale = rect.height / app.game.scale.gameSize.height;
    Object.assign(target.style, { left: `${rect.left + bounds.x * xScale}px`, top: `${rect.top + bounds.y * yScale}px`, width: `${bounds.width * xScale}px`, height: `${bounds.height * yScale}px` });
  };
  app.game.events.on('poststep', update); update();
  return () => {
    app.game.events.off('poststep', update); target.remove();
    panel.buttons.splice(panel.buttons.indexOf(custom), 1); custom.destroy(); panel.updateLayout(); scene.preUpdate.makeDirty();
  };
}
