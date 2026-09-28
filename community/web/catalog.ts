import { createNativeButton, createDifficultyToggle, trophy } from './native-controls.ts';
import type { CatalogEntry, CatalogQuery, CatalogReader, CatalogSort, Difficulty } from '../shared/contracts.ts';

export interface CatalogUiState {
  version: 1;
  search: string;
  tags: string[];
  sort: CatalogSort;
  difficulty: Difficulty | 'all';
  view: 'grid' | 'list';
  offset: number;
  scrollTop: number;
  detailId: string | null;
}
type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface CatalogMountOptions {
  reader: CatalogReader;
  /** The selected map is positioned by the main Phaser camera; animate only its surrounding UI. */
  sharedWorld?: boolean;
  onPlay: (entry: CatalogEntry, difficulty: Difficulty) => void | Promise<void>;
  onExit?: () => void;
  completedDifficulties?: (entry: CatalogEntry) => Difficulty[];
  renderPreview?: (container: HTMLElement, entry: CatalogEntry, thumbnail: boolean) => { ready: Promise<void>; destroy(): void };
  storage?: StateStorage | null;
  storageKey?: string;
  /** This flag must remain off until the validator's independent review passes. */
  verifiedResultsEnabled?: boolean;
  /** Static releases can keep all rating/count features dormant. */
  statisticsEnabled?: boolean;
  supportedDifficulties?: (entry: CatalogEntry) => Difficulty[];
  /** Optional map actions, such as resuming a saved game. */
  renderDetailActions?: (container: HTMLElement, entry: CatalogEntry) => void;
}

const SORTS: CatalogSort[] = ['name', 'rating', 'completions', 'newest'];
const PAGE_SIZE = 24;
const RATING_UPDATED = 'community:rating-updated';
const ratingText = (rating: CatalogEntry['rating']) => rating.count && rating.average !== null ? `${rating.average.toFixed(1)} / 5 · ${rating.count} ${rating.count === 1 ? 'rating' : 'ratings'}` : 'No ratings yet';

/** Update the enclosing detail aggregate without replacing its controls or unsaved edits. */
export function updateCatalogRating(container: HTMLElement, entry: CatalogEntry, rating: CatalogEntry['rating']): void {
  entry.rating = { ...rating };
  container.dispatchEvent(new CustomEvent(RATING_UPDATED, { bubbles: true, detail: entry }));
}

export function defaultCatalogState(): CatalogUiState {
  return { version: 1, search: '', tags: [], sort: 'newest', difficulty: 'all', view: 'grid', offset: 0, scrollTop: 0, detailId: null };
}

/** Browser history and the address bar deliberately play no part in catalog navigation. */
export function restoreCatalogState(serialized: string | null): CatalogUiState {
  const defaults = defaultCatalogState();
  if (!serialized) return defaults;
  try {
    const state = JSON.parse(serialized) as Partial<CatalogUiState>;
    if (!state || state.version !== 1) return defaults;
    return {
      version: 1,
      search: typeof state.search === 'string' && state.search.length <= 120 ? state.search : '',
      tags: Array.isArray(state.tags) && state.tags.length <= 12 ? [...new Set(state.tags.filter((tag): tag is string => typeof tag === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)))] : [],
      sort: SORTS.includes(state.sort as CatalogSort) ? state.sort as CatalogSort : defaults.sort,
      difficulty: state.difficulty === 'normal' || state.difficulty === 'hard' ? state.difficulty : 'all',
      view: state.view === 'list' ? 'list' : 'grid',
      offset: Number.isSafeInteger(state.offset) && state.offset! >= 0 && state.offset! <= 1_000_000 ? state.offset! : 0,
      scrollTop: typeof state.scrollTop === 'number' && Number.isFinite(state.scrollTop) && state.scrollTop >= 0 ? state.scrollTop : 0,
      detailId: typeof state.detailId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(state.detailId) ? state.detailId : null,
    };
  } catch { return defaults; }
}

export function createHttpCatalogReader(base = '/api/maps', fetcher: typeof fetch = fetch): CatalogReader {
  const read = async <T>(url: string): Promise<T | null> => {
    const response = await fetcher(url, { credentials: 'same-origin' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('The map library could not be loaded. Please try again.');
    return response.json() as Promise<T>;
  };
  return {
    async list(query: CatalogQuery) {
      const params = new URLSearchParams();
      if (query.search) params.set('search', query.search);
      for (const tag of query.tags ?? []) params.append('tag', tag);
      if (query.sort) params.set('sort', query.sort);
      if (query.difficulty) params.set('difficulty', query.difficulty);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.offset !== undefined) params.set('offset', String(query.offset));
      const page = await read<Awaited<ReturnType<CatalogReader['list']>>>(`${base}?${params}`);
      if (!page) throw new Error('The map library is unavailable. Please try again.');
      return page;
    },
    get: mapId => read<CatalogEntry>(`${base}/${encodeURIComponent(mapId)}`),
  };
}

export function mountCatalog(root: HTMLElement, options: CatalogMountOptions) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  let storage: StateStorage | null = options.storage ?? null;
  if (options.storage === undefined) { try { storage = win.sessionStorage; } catch { /* In-memory navigation still works. */ } }
  const storageKey = options.storageKey ?? 'konkr.community.catalog.v1';
  let state: CatalogUiState;
  try { state = restoreCatalogState(storage?.getItem(storageKey) ?? null); } catch { state = defaultCatalogState(); }
  if (options.statisticsEnabled === false && ['rating', 'completions'].includes(state.sort)) state.sort = 'name';
  let generation = 0;
  let destroyed = false;
  let paused = false;
  let focusedMap: string | null = null;
  let loadedEntry: CatalogEntry | null = null;
  let restoringScroll = false;
  let selectionRequest = 0;
  const previewHandles = new Set<{ destroy(): void }>();
  const clearPreviews = () => { for (const preview of previewHandles) preview.destroy(); previewHandles.clear(); };
  const motion = (node: Element | null, frames: Keyframe[], duration = 200) => {
    if (!node || win.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    return node.animate(frames, { duration, easing: 'cubic-bezier(.39,.575,.565,1)' }).finished.catch(() => {});
  };
  const selectedMotion = (frames: Keyframe[], duration = 200) => Promise.all(
    [...root.querySelectorAll(options.sharedWorld ? '.catalog-detail-title, .catalog-detail-info, .catalog-backbar' : '.catalog-selected')].map(node => motion(node, frames, duration)),
  );
  root.classList.add('community-catalog', 'konkr-ui');
  root.setAttribute('aria-label', 'Custom maps');
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const save = () => { try { storage?.setItem(storageKey, JSON.stringify(state)); } catch { /* Retain in-memory state when storage is unavailable. */ } };
  const button = (text: string, action: () => void, className = '') => {
    const node = createNativeButton(text, doc); node.classList.add('catalog-button'); for (const name of className.split(' ').filter(Boolean)) node.classList.add(name); if (['catalog-browse','catalog-clear','catalog-tag','catalog-map-title','catalog-preview-button'].some(name => node.classList.contains(name))) node.classList.add('konkr-plain'); node.addEventListener('click', action); return node;
  };
  const captureScroll = () => {
    const browser = root.querySelector<HTMLElement>('.catalog-browser-scroll');
    if (browser && !paused && !restoringScroll) { state.scrollTop = browser.scrollTop; save(); }
  };
  const updateRating = (event: Event) => {
    if (options.statisticsEnabled === false) return;
    const entry = (event as CustomEvent<CatalogEntry>).detail;
    for (const card of root.querySelectorAll<HTMLElement>('.catalog-card')) {
      if (card.dataset.entryId === entry.map.id && card.dataset.revisionId === entry.revision.id) card.querySelector('.catalog-rating')!.textContent = shortRating(entry.rating);
    }
    if (!loadedEntry || entry.map.id !== loadedEntry.map.id || entry.revision.id !== loadedEntry.revision.id) return;
    loadedEntry.rating = entry.rating;
    const aggregate = root.querySelector('.catalog-detail .catalog-rating');
    if (aggregate) aggregate.textContent = ratingText(entry.rating);
  };
  root.addEventListener(RATING_UPDATED, updateRating);
  const shortRating = (rating: CatalogEntry['rating']) => rating.count && rating.average !== null ? `★ ${rating.average.toFixed(1)} · ${rating.count} ${rating.count === 1 ? 'rating' : 'ratings'}` : 'Unrated';
  const setQuery = (patch: Partial<CatalogUiState>) => { state = { ...state, ...patch, detailId: null, offset: 0, scrollTop: 0 }; loadedEntry = null; save(); void render(); };
  const restoreScroll = (focusMap = false) => {
    const token = generation;
    win.requestAnimationFrame(() => {
      if (destroyed || paused || token !== generation) return;
      const browser = root.querySelector<HTMLElement>('.catalog-browser-scroll');
      if (browser) browser.scrollTop = state.scrollTop;
      restoringScroll = false;
      if (focusMap && focusedMap) [...root.querySelectorAll<HTMLButtonElement>('button[data-map-id]')].find(node => node.dataset.mapId === focusedMap)?.focus({ preventScroll: true });
    });
  };
  const showList = () => {
    const selected = [...root.querySelectorAll<HTMLButtonElement>('button[data-map-id]')].find(node => node.dataset.mapId === state.detailId);
    selected?.focus({ preventScroll: true });
    if (win.innerWidth < 900) root.querySelector('.catalog-browser')?.scrollIntoView({ block: 'start' });
  };
  const openDetail = (entry: CatalogEntry) => {
    captureScroll();
    const selection = ++selectionRequest;
    if (state.detailId === entry.map.id) { loadedEntry = null; void render(false, true); return; }
    const token = generation;
    void selectedMotion([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-24px)' }], 100).then(() => {
      if (selection !== selectionRequest || token !== generation || paused || destroyed) return;
      focusedMap = entry.map.id; state.detailId = entry.map.id; loadedEntry = null; save(); return render(false, true);
    });
  };
  const field = (label: string, control: HTMLElement) => { const wrap = el('label', 'catalog-field'); control.setAttribute('aria-label', label); wrap.append(el('span', '', label), control); return wrap; };
  const preview = (entry: CatalogEntry, large = false) => {
    const frame = el('div', `catalog-preview${large ? ' catalog-preview-large' : ''}`);
    frame.setAttribute('aria-label', `${entry.map.metadata.title} map preview`);
    frame.append(el('span', 'catalog-preview-label', 'Loading map…'));
    if (options.renderPreview) {
      // Mount only after the frame is in the document so the renderer can size it.
      const token = generation;
      queueMicrotask(() => {
        if (paused || destroyed || token !== generation || !frame.isConnected) return;
        const handle = options.renderPreview!(frame, entry, !large); previewHandles.add(handle);
        void handle.ready.catch(error => {
          if (!frame.isConnected || token !== generation) return;
          frame.replaceChildren(el('span', 'catalog-preview-label', error instanceof Error ? error.message : 'Preview unavailable'));
        });
      });
    } else frame.replaceChildren(el('span', 'catalog-preview-label', 'Select a map to play'));
    return frame;
  };
  const completion = (entry: CatalogEntry) => {
    const badges = el('span', 'catalog-completion');
    for (const mode of options.completedDifficulties?.(entry) ?? []) badges.append(trophy(mode, `${mode === 'hard' ? 'Hard' : 'Normal'} completed on this browser`, doc));
    return badges;
  };
  const tags = (entry: CatalogEntry) => {
    const list = el('div', 'catalog-tags');
    for (const tag of entry.map.metadata.tags) {
      const item = button(`#${tag}`, () => setQuery({ tags: [...new Set([...state.tags, tag])] }), 'catalog-tag'); item.setAttribute('aria-label', `Filter by ${tag}`); list.append(item);
    }
    return list;
  };
  const stats = (entry: CatalogEntry, detail = false) => {
    const wrap = el('div', 'catalog-stats');
    if (options.statisticsEnabled === false) { wrap.hidden = true; return wrap; }
    wrap.append(el('span', 'catalog-rating', detail ? ratingText(entry.rating) : shortRating(entry.rating)));
    if (options.verifiedResultsEnabled) {
      if (detail) {
        for (const difficulty of ['normal', 'hard'] as const) {
          const score = entry.scores.find(score => score.difficulty === difficulty);
          const label = difficulty === 'normal' ? 'Normal' : 'Hard';
          wrap.append(el('span', '', score?.completions ? `${label}: ${score.completions} ${score.completions === 1 ? 'finish' : 'finishes'} · best ${score.bestTurns} ${score.bestTurns === 1 ? 'turn' : 'turns'}` : `${label}: no verified finishes yet`));
        }
      } else {
        const completions = entry.scores.reduce((total, score) => total + score.completions, 0);
        wrap.append(el('span', '', `${completions} verified ${completions === 1 ? 'finish' : 'finishes'}`));
      }
    }
    return wrap;
  };
  const statusBox = (message: string, error = false) => { const status = el('p', `catalog-message${error ? ' catalog-error' : ''}`, message); status.setAttribute('role', error ? 'alert' : 'status'); return status; };
  const controls = () => {
    const form = el('form', 'catalog-controls'); form.setAttribute('aria-label', 'Find a map');
    const search = el('input'); search.type = 'search'; search.name = 'search'; search.placeholder = 'Find an island'; search.value = state.search; search.maxLength = 120;
    const tagInput = el('input'); tagInput.name = 'tags'; tagInput.placeholder = '#zombie, #xmas'; tagInput.value = state.tags.map(tag => `#${tag}`).join(', ');
    const searchSubmit = el('button', 'catalog-button', 'Search'); searchSubmit.type = 'submit';
    form.append(field('Map name', search), field('Tags', tagInput), searchSubmit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const selected = tagInput.value.split(/[\s,]+/).filter(Boolean).map(tag => tag.replace(/^#/, '').toLowerCase());
      if (selected.length > 12 || selected.some(tag => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag))) { tagInput.setCustomValidity('Use up to 12 tags containing letters, numbers or hyphens.'); tagInput.reportValidity(); return; }
      tagInput.setCustomValidity(''); setQuery({ search: search.value.trim(), tags: [...new Set(selected)] });
    });
    tagInput.addEventListener('input', () => tagInput.setCustomValidity(''));
    const toolbar = el('div', 'catalog-toolbar');
    const sort = el('select');
    for (const [value, label] of [['newest', 'Newest'], ['name', 'Name A–Z'], ['rating', 'Highest rating'], ['completions', 'Most finished']]) {
      if (options.statisticsEnabled === false && ['rating', 'completions'].includes(value)) continue;
      const option = el('option', '', label); option.value = value; sort.append(option);
    }
    sort.value = state.sort; sort.addEventListener('change', () => setQuery({ sort: sort.value as CatalogSort }));
    const difficulty = el('select');
    for (const [value, label] of [['all', 'All'], ['normal', 'Normal'], ['hard', 'Hard']]) { const option = el('option', '', label); option.value = value; difficulty.append(option); }
    difficulty.value = state.difficulty; difficulty.addEventListener('change', () => setQuery({ difficulty: difficulty.value as CatalogUiState['difficulty'] }));
    const views = el('div', 'catalog-view-controls'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Map layout');
    for (const view of ['grid', 'list'] as const) {
      const toggle = button(view === 'grid' ? 'Grid' : 'List', () => { captureScroll(); state.view = view; save(); void render(); });
      toggle.setAttribute('aria-pressed', String(state.view === view)); views.append(toggle);
    }
    toolbar.append(field('Sort by', sort), field('Difficulty', difficulty), views);
    if (state.tags.length || state.search || state.difficulty !== 'all') toolbar.append(button('Clear filters', () => setQuery({ search: '', tags: [], difficulty: 'all' }), 'catalog-clear'));
    const wrapper = el('div', 'catalog-filters'); wrapper.append(form, toolbar); return wrapper;
  };
  const detail = (entry: CatalogEntry, token: number, focus = false) => {
    const article = el('article', 'catalog-detail');
    const heading = el('h2', '', entry.map.metadata.title); heading.tabIndex = -1;
    const title = el('div', 'catalog-detail-title'); title.append(heading, completion(entry), el('p', 'catalog-creator', `Created by ${entry.map.metadata.creator || 'Unknown creator'}`));
    article.append(title, preview(entry, true));
    const info = el('div', 'catalog-detail-info');
    if (entry.map.metadata.description) info.append(el('p', 'catalog-description', entry.map.metadata.description));
    info.append(tags(entry), stats(entry, true));
    const modes = options.supportedDifficulties?.(entry) ?? ['normal', 'hard'];
    let chosenDifficulty = modes.includes(state.difficulty as Difficulty) ? state.difficulty as Difficulty : modes[0] ?? 'normal';
    const toggle = createDifficultyToggle(modes, chosenDifficulty, mode => { chosenDifficulty = mode; }, doc);
    const playError = statusBox(''); playError.hidden = true;
    const play = button('Play map', () => {
      const difficulty = chosenDifficulty;
      captureScroll(); play.disabled = true; play.textContent = 'Starting…'; playError.hidden = true;
      void (async () => {
        // Check current publication/revision again immediately before starting.
        const current = await options.reader.get(entry.map.id);
        if (token !== generation || paused || destroyed) return;
        if (!current) throw new Error('This map is no longer available. Choose another island.');
        if (current.revision.id !== entry.revision.id) { throw new Error('This map has changed. Select it again before playing.'); }
        const supported = options.supportedDifficulties?.(current) ?? ['normal', 'hard'];
        if (!supported.includes(difficulty)) throw new Error('This difficulty is no longer available. Select the map again.');
        await options.onPlay(current, difficulty);
      })().catch(error => {
        if (token !== generation || destroyed) return;
        playError.textContent = 'The map could not be started. ' + (error instanceof Error ? error.message : 'Please try again.');
        playError.hidden = false; playError.setAttribute('role', 'alert');
      }).finally(() => { play.disabled = modes.length === 0; play.textContent = 'Play map'; });
    }, 'catalog-primary');
    play.disabled = modes.length === 0;
    const playControls = el('div', 'catalog-play-controls'); playControls.append(toggle, play);
    info.append(playControls, playError);
    if (options.renderDetailActions) { const actions = el('div', 'catalog-detail-actions'); options.renderDetailActions(actions, entry); info.append(actions); }
    article.append(info);
    if (focus) win.requestAnimationFrame(() => {
      if (token !== generation || paused || destroyed) return;
      if (win.innerWidth < 900) root.scrollTop = 0;
      heading.focus({ preventScroll: true });
    });
    return article;
  };
  async function render(focusMap = false, focusDetail = false): Promise<void> {
    if (destroyed || paused) return;
    const token = ++generation;
    clearPreviews();
    restoringScroll = true;
    const content = el('div', 'catalog-shell');
    const stage = el('section', 'catalog-stage'); stage.setAttribute('aria-label', 'Selected map');
    const header = el('header', 'catalog-header');
    header.append(button('← All maps', showList, 'catalog-browse'));
    const selected = el('div', 'catalog-selected'); selected.append(statusBox('Choose an island to explore.'));
    stage.append(header, selected);
    if (options.onExit) { const back = el('nav', 'catalog-backbar'); back.append(button('Back', () => { captureScroll(); options.onExit!(); }, 'catalog-back konkr-back')); stage.append(back); }
    const sidebar = el('aside', 'catalog-browser'); sidebar.setAttribute('aria-label', 'Browse maps');
    const browserHeader = el('header', 'catalog-browser-header'); browserHeader.append(el('h1', '', 'Custom Maps'), el('p', '', 'Islands made by the community'));
    const browser = el('div', 'catalog-browser-scroll'); browser.addEventListener('scroll', captureScroll, { passive: true });
    const loading = statusBox('Loading maps…'); browser.append(loading); browser.setAttribute('aria-busy', 'true');
    sidebar.append(browserHeader, controls(), browser); content.append(stage, sidebar); root.replaceChildren(content);
    try {
      const page = await options.reader.list({ search: state.search, tags: state.tags, sort: state.sort, difficulty: state.difficulty === 'all' ? undefined : state.difficulty, limit: PAGE_SIZE, offset: state.offset });
      if (token !== generation || destroyed) return;
      browser.removeAttribute('aria-busy'); loading.remove();
      if (!page.entries.length && state.offset > 0 && page.total > 0) { state.offset = Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE; save(); return render(); }
      browser.append(statusBox(`${page.total} ${page.total === 1 ? 'map' : 'maps'}${state.search || state.tags.length ? ' matching your filters' : ' in the collection'}`));
      if (!page.entries.length) browser.append(el('div', 'catalog-empty', state.search || state.tags.length || state.difficulty !== 'all' ? 'No maps match these filters. Try another name or remove a tag.' : 'The collection is waiting for its first published map. Check back soon.'));
      if (!state.detailId && page.entries.length) { state.detailId = page.entries[0].map.id; save(); }
      const collection = el('ul', `catalog-entries catalog-${state.view}`);
      for (const entry of page.entries) {
        const item = el('li', 'catalog-card'); item.dataset.entryId = entry.map.id; item.dataset.revisionId = entry.revision.id;
        item.classList.toggle('catalog-card-selected', entry.map.id === state.detailId);
        const open = button(entry.map.metadata.title, () => openDetail(entry), 'catalog-map-title'); open.dataset.mapId = entry.map.id; open.setAttribute('aria-pressed', String(entry.map.id === state.detailId));
        if (state.view === 'grid') {
          const image = preview(entry); image.setAttribute('aria-hidden', 'true');
          const choose = button('', () => openDetail(entry), 'catalog-preview-button'); choose.setAttribute('aria-label', `Preview ${entry.map.metadata.title}`); choose.tabIndex = -1; choose.append(image); item.append(choose);
        }
        const details = el('div', 'catalog-card-content');
        const heading = el('div', 'catalog-card-title'); heading.append(open, completion(entry));
        details.append(heading, el('p', 'catalog-creator', `By ${entry.map.metadata.creator || 'Unknown creator'}`), stats(entry)); item.append(details); collection.append(item);
      }
      browser.append(collection);
      if (page.total > PAGE_SIZE) {
        const pagination = el('nav', 'catalog-pagination'); pagination.setAttribute('aria-label', 'Map pages');
        const move = (offset: number) => { state.offset = offset; state.scrollTop = 0; state.detailId = null; loadedEntry = null; save(); void render(); };
        const previous = button('← Previous', () => move(Math.max(0, state.offset - PAGE_SIZE))); previous.disabled = state.offset === 0;
        const next = button('Next →', () => move(state.offset + PAGE_SIZE)); next.disabled = state.offset + PAGE_SIZE >= page.total;
        pagination.append(previous, el('span', '', `Page ${Math.floor(state.offset / PAGE_SIZE) + 1} of ${Math.ceil(page.total / PAGE_SIZE)}`), next); browser.append(pagination);
      }
      restoreScroll(focusMap);
      if (!state.detailId) return;
      selected.replaceChildren(statusBox('Loading map…')); selected.setAttribute('aria-busy', 'true');
      try {
        const entry = loadedEntry?.map.id === state.detailId ? loadedEntry : await options.reader.get(state.detailId);
        if (token !== generation || destroyed) return;
        selected.removeAttribute('aria-busy'); loadedEntry = entry;
        selected.replaceChildren(entry ? detail(entry, token, focusDetail) : statusBox('This map is no longer available. Choose another map from the collection.'));
        if (focusDetail) void selectedMotion([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0)' }]);
      } catch {
        if (token !== generation || destroyed) return;
        selected.removeAttribute('aria-busy'); selected.replaceChildren(statusBox('This map could not be loaded. Please try again.', true), button('Retry map', () => { loadedEntry = null; void render(); }));
      }
    } catch {
      if (token !== generation || destroyed) return;
      browser.removeAttribute('aria-busy'); loading.remove(); browser.append(statusBox('The map library could not be loaded. Check your connection and try again.', true), button('Try again', () => { void render(); }));
      restoringScroll = false;
    }
  }
  void render();
  return {
    getState: () => structuredClone(state),
    select: (mapId: string) => { state.detailId = mapId; loadedEntry = null; save(); },
    refresh: () => { captureScroll(); loadedEntry = null; return render(); },
    animateIn: () => Promise.all([motion(root.querySelector('.catalog-browser'), [{ opacity: 0, transform: 'translateX(420px)' }, { opacity: 1, transform: 'translateX(0)' }], 300), selectedMotion([{ opacity: 0, transform: 'translateX(-60px)' }, { opacity: 1, transform: 'translateX(0)' }], 300)]),
    animateOut: () => Promise.all([motion(root.querySelector('.catalog-browser'), [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(420px)' }], 300), selectedMotion([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-60px)' }], 300)]),
    suspend: () => { captureScroll(); paused = true; generation++; clearPreviews(); save(); },
    resume: (returnToList = true) => { paused = false; loadedEntry = null; save(); return render(returnToList); },
    destroy: () => { captureScroll(); save(); destroyed = true; generation++; clearPreviews(); root.removeEventListener(RATING_UPDATED, updateRating); root.replaceChildren(); root.classList.remove('community-catalog', 'konkr-ui'); root.removeAttribute('aria-label'); },
  };
}
