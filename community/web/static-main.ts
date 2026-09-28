import './theme.css';
import './catalog.css';
import type { StaticCatalog } from '../shared/static-catalog.ts';
import { installCustomMaps } from './custom-maps.ts';
import { LocalRunStore } from './local-runs.ts';
import { initializeNativeAssets } from './native-controls.ts';
import { createLivePreviewPool } from './live-preview.ts';
import { createStaticCatalogReader } from './static-catalog.ts';

declare const STATIC_CATALOG_URL: string;

async function boot(): Promise<void> {
  // The one catalogue request includes every map; previews remain lazy.
  const [catalog] = await Promise.all([
    fetch(STATIC_CATALOG_URL).then(async response => {
      if (!response.ok) throw new Error('The community maps could not be loaded. Reload to try again.');
      const catalog = await response.json() as StaticCatalog;
      if (catalog.version !== 1 || !catalog.entries.length) throw new Error('This catalogue version is unavailable.');
      return catalog;
    }),
    initializeNativeAssets(document),
  ]);
  const previews = createLivePreviewPool({ frameUrl: '/community-preview.html', layer: 21 });
  const loadMap = async (entry: StaticCatalog['entries'][number]) => {
    const encoded = catalog.maps[entry.revision.contentHash];
    if (!encoded) throw new Error('This map is missing from the release. Reload to try again.');
    return encoded;
  };
  await installCustomMaps({
    root: document.getElementById('catalog-root')!, reader: createStaticCatalogReader(catalog),
    store: new LocalRunStore(localStorage), engineHash: catalog.engineHash, loadMap,
    statisticsEnabled: false, progressEnabled: false, verifiedResultsEnabled: false,
    supportedDifficulties: () => ['normal', 'hard'],
    async onStart(entry, difficulty) {
      // Local session binding only. Never submitted or represented as a validated result.
      return { id: 'local-' + crypto.randomUUID(), mapId: entry.map.id, revisionId: entry.revision.id,
        mapHash: entry.revision.contentHash, engineHash: entry.revision.engineHash, plugins: entry.revision.plugins,
        difficulty, adapterVersion: 'static-unverified', issuedAt: new Date().toISOString(), expiresAt: new Date(8640000000000000).toISOString() };
    },
    renderPreview: (container, entry, thumbnail) => previews.mount(container, {
      key: entry.revision.id + ':' + entry.revision.contentHash, title: entry.map.metadata.title, thumbnail, loadMap: () => loadMap(entry),
    }),
    onError: showError,
  });
}

function showError(error: unknown): void {
  const alert = document.getElementById('community-alert')!;
  alert.textContent = error instanceof Error ? error.message : 'The map could not be opened. Please try again.';
  alert.hidden = false;
}
void boot().catch(showError);
