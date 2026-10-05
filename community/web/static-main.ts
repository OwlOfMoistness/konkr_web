import './theme.css';
import './catalog.css';
import type { StaticCatalog } from '../shared/static-catalog.ts';
import { installCustomMaps } from './custom-maps.ts';
import { LocalRunStore } from './local-runs.ts';
import { initializeNativeAssets } from './native-controls.ts';
import { createLivePreviewPool } from './live-preview.ts';
import { createStaticCatalogReader } from './static-catalog.ts';
import { createVotingClient } from './voting-client.ts';
import { ratingControls } from './ratings.ts';

declare const STATIC_CATALOG_URL: string;
declare const VOTING_API_ORIGIN: string;

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
  const previews = createLivePreviewPool({ frameUrl: new URL('community-preview.html', document.baseURI).href, layer: 21 });
  const loadMap = async (entry: StaticCatalog['entries'][number]) => {
    const encoded = catalog.maps[entry.revision.contentHash];
    if (!encoded) throw new Error('This map is missing from the release. Reload to try again.');
    return encoded;
  };
  const voting = VOTING_API_ORIGIN ? createVotingClient(VOTING_API_ORIGIN, catalog, localStorage) : undefined;
  await installCustomMaps({
    root: document.getElementById('catalog-root')!, reader: voting?.reader ?? createStaticCatalogReader(catalog),
    store: new LocalRunStore(localStorage), engineHash: catalog.engineHash, loadMap,
    statisticsEnabled: !!voting, completionSortEnabled: false, progressEnabled: false, verifiedResultsEnabled: false,
    renderPostPlay: voting ? ratingControls(voting.visitor) : undefined,
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
