import type { CatalogEntry, CatalogReader, Difficulty } from '../shared/contracts.ts';
import { createCatalogBridge } from '../runtime/catalog-bridge.ts';
import type { CatalogBridgeOptions, CatalogSave, CatalogSaveStore } from '../runtime/catalog-bridge.ts';
import { installCustomMapsMenu, preservePlayerUrl, waitForCommunityEngine } from '../runtime/menu-bridge.ts';
import { mountCatalog } from './catalog.ts';

export function createCatalogSaveStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): CatalogSaveStore {
  const key = (value: string) => `konkr.community.save.v1:${value}`;
  return {
    get(value) {
      const stored = storage.getItem(key(value));
      if (!stored) return null;
      try { const save = JSON.parse(stored) as CatalogSave; if (save.version !== 1 || !save.context || !save.state) throw new Error(); return save; }
      catch { throw new Error('The saved game is damaged. Your other map saves are unchanged.'); }
    },
    put(value, save) {
      try { storage.setItem(key(value), JSON.stringify(save)); }
      catch { throw new Error('Your browser could not save this run. Free some storage before leaving.'); }
    },
    remove(value) { storage.removeItem(key(value)); },
  };
}

export interface CustomMapsOptions extends Omit<CatalogBridgeOptions, 'loader' | 'onReturn' | 'onError'> {
  reader: CatalogReader;
  root: HTMLElement;
  onError?: (error: Error) => void;
  supportedDifficulties?: (entry: CatalogEntry) => Difficulty[];
  verifiedResultsEnabled?: boolean;
  renderDetailActions?: (container: HTMLElement, entry: CatalogEntry) => void;
  renderExtras?: (container: HTMLElement) => { refresh?(): void; destroy?(): void } | void;
}

/** The composition root mounts this beside the original canvas, on the same page and URL. */
export async function installCustomMaps(options: CustomMapsOptions) {
  const loader = await waitForCommunityEngine();
  const { app } = loader(55151);
  const gameRoot = document.getElementById('phaser-game')!;
  const root = options.root;
  Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '20' });
  root.hidden = true;
  let extras: { refresh?(): void; destroy?(): void } | void;
  const catalogRoot = options.renderExtras ? document.createElement('div') : root;
  if (options.renderExtras) {
    const extraRoot = document.createElement('section');
    root.replaceChildren(extraRoot, catalogRoot); root.style.gridTemplateRows = 'auto minmax(0, 1fr)';
    catalogRoot.style.height = '100%'; catalogRoot.style.minHeight = '0';
    extras = options.renderExtras(extraRoot);
  }
  let catalog: ReturnType<typeof mountCatalog>;
  const error = (failure: Error) => {
    options.onError?.(failure);
    if (root.hidden) app.notifications.warning('Custom Maps', failure.message);
    let status = catalogRoot.querySelector<HTMLElement>('[data-community-error]');
    if (!status) { status = document.createElement('p'); status.dataset.communityError = 'true'; status.setAttribute('role', 'alert'); catalogRoot.prepend(status); }
    status.textContent = failure.message;
  };
  const show = () => {
    root.hidden = false; if (options.renderExtras) root.style.display = 'grid'; gameRoot.classList.add('hidden');
    app.game.input.enabled = false; app.game.input.keyboard.enabled = false;
    extras?.refresh?.(); void catalog.resume();
  };
  const hide = () => {
    catalog.suspend(); root.hidden = true; if (options.renderExtras) root.style.display = 'none'; gameRoot.classList.remove('hidden');
    app.game.input.enabled = true; app.game.input.keyboard.enabled = true;
  };
  const bridge = createCatalogBridge({ ...options, loader, onReturn: show, onError: error });
  catalog = mountCatalog(catalogRoot, {
    reader: options.reader, supportedDifficulties: options.supportedDifficulties, verifiedResultsEnabled: options.verifiedResultsEnabled,
    onPlay: async (entry, difficulty) => { await bridge.start(entry, difficulty); hide(); },
    onExit: hide,
    renderDetailActions(container, entry) {
      const modes = options.supportedDifficulties?.(entry) ?? ['normal', 'hard'];
      for (const mode of modes) {
        let saved = false; try { saved = bridge.hasSave(entry, mode); } catch (failure) { error(failure as Error); }
        if (!saved) continue;
        const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'catalog-button'; resume.textContent = `Resume ${mode === 'normal' ? 'Normal' : 'Hard'} game`;
        resume.addEventListener('click', () => { resume.disabled = true; void bridge.resume(entry, mode).then(hide).catch(error).finally(() => { resume.disabled = false; }); });
        container.append(resume);
      }
      options.renderDetailActions?.(container, entry);
    },
  });
  catalog.suspend();
  const restoreUrl = preservePlayerUrl(loader);
  const removeMenu = installCustomMapsMenu(loader, show);
  const inactive = () => { try { bridge.save(); } catch (failure) { error(failure as Error); } };
  window.addEventListener('pagehide', inactive);
  return {
    bridge, catalog, open: show,
    async resumeSaved(save: CatalogSave) { await bridge.resume(save.context.entry, save.context.difficulty); hide(); },
    destroy() { window.removeEventListener('pagehide', inactive); bridge.destroy(); catalog.destroy(); extras?.destroy?.(); removeMenu(); restoreUrl(); },
  };
}
