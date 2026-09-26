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
  onPlay: (entry: CatalogEntry, difficulty: Difficulty) => void | Promise<void>;
  onExit?: () => void;
  storage?: StateStorage | null;
  storageKey?: string;
  /** This flag must remain off until the validator's independent review passes. */
  verifiedResultsEnabled?: boolean;
  supportedDifficulties?: (entry: CatalogEntry) => Difficulty[];
  /** Integration point for anonymous rating controls. Text and event handling belong to that slice. */
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
  let generation = 0;
  let destroyed = false;
  let paused = false;
  let focusedMap: string | null = null;
  let loadedEntry: CatalogEntry | null = null;
  let restoringScroll = false;
  root.classList.add('community-catalog');
  root.setAttribute('aria-label', 'Custom maps');
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const save = () => { try { storage?.setItem(storageKey, JSON.stringify(state)); } catch { /* Storage may be full or disabled; retain in-memory state. */ } };
  const button = (text: string, action: () => void, className = '') => {
    const node = el('button', `catalog-button ${className}`, text); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const captureScroll = () => { if (!state.detailId && !paused && !restoringScroll) { state.scrollTop = root.scrollTop; save(); } };
  root.addEventListener('scroll', captureScroll, { passive: true });
  const updateRating = (event: Event) => {
    const entry = (event as CustomEvent<CatalogEntry>).detail;
    if (!loadedEntry || entry.map.id !== loadedEntry.map.id || entry.revision.id !== loadedEntry.revision.id) return;
    loadedEntry.rating = entry.rating;
    const aggregate = root.querySelector('.catalog-detail .catalog-rating');
    if (aggregate) aggregate.textContent = ratingText(entry.rating);
  };
  root.addEventListener(RATING_UPDATED, updateRating);
  const setQuery = (patch: Partial<CatalogUiState>) => { state = { ...state, ...patch, detailId: null, offset: 0, scrollTop: 0 }; save(); void render(); };
  const restoreScroll = (focusMap = false) => {
    win.requestAnimationFrame(() => {
      if (destroyed || state.detailId) return;
      root.scrollTop = state.scrollTop;
      restoringScroll = false;
      if (focusMap && focusedMap) [...root.querySelectorAll<HTMLButtonElement>('button[data-map-id]')].find(node => node.dataset.mapId === focusedMap)?.focus({ preventScroll: true });
    });
  };
  const showList = () => { state.detailId = null; loadedEntry = null; save(); void render(true); };
  const openDetail = (entry: CatalogEntry) => {
    // List scores may be filtered to one difficulty. Fetch complete details and recheck publication.
    captureScroll(); focusedMap = entry.map.id; state.detailId = entry.map.id; loadedEntry = null; save(); void render();
  };
  const field = (label: string, control: HTMLElement) => { const wrap = el('label', 'catalog-field'); control.setAttribute('aria-label', label); wrap.append(el('span', '', label), control); return wrap; };
  const preview = (entry: CatalogEntry, large = false) => {
    const frame = el('div', `catalog-preview${large ? ' catalog-preview-large' : ''}`);
    if (entry.previewUrl) {
      let safe = false;
      try { const url = new URL(entry.previewUrl, win.location.href); safe = ['https:', 'http:'].includes(url.protocol); } catch { /* Show placeholder for malformed URLs. */ }
      if (safe) {
        const image = el('img'); image.src = entry.previewUrl; image.alt = `${entry.map.metadata.title} map preview`; image.loading = large ? 'eager' : 'lazy';
        image.addEventListener('error', () => { frame.replaceChildren(el('span', '', 'Preview unavailable')); }, { once: true }); frame.append(image);
      }
    }
    if (!frame.childNodes.length) frame.append(el('span', 'catalog-preview-label', 'Preview coming soon'));
    return frame;
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
    wrap.append(el('span', 'catalog-rating', ratingText(entry.rating)));
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
    } else if (detail) wrap.append(el('span', '', 'Finish records are not available yet.'));
    return wrap;
  };
  const shell = (detail: boolean) => {
    const content = el('div', 'catalog-shell');
    const header = el('header', 'catalog-header');
    const intro = el('div'); intro.append(el('p', 'catalog-eyebrow', 'COMMUNITY COLLECTION'), el('h1', '', 'Custom Maps'));
    header.append(intro);
    if (detail) header.append(button('← All maps', showList, 'catalog-back'));
    else if (options.onExit) header.append(button('← Main menu', () => { captureScroll(); options.onExit!(); }, 'catalog-back'));
    content.append(header); root.replaceChildren(content); return content;
  };
  const statusBox = (message: string, error = false) => { const status = el('p', `catalog-message${error ? ' catalog-error' : ''}`, message); status.setAttribute('role', error ? 'alert' : 'status'); return status; };
  const controls = () => {
    const form = el('form', 'catalog-controls'); form.setAttribute('aria-label', 'Find a map');
    const search = el('input'); search.type = 'search'; search.name = 'search'; search.placeholder = 'Find a map by name'; search.value = state.search; search.maxLength = 120;
    const tagInput = el('input'); tagInput.name = 'tags'; tagInput.placeholder = 'e.g. #zombie, #xmas'; tagInput.value = state.tags.map(tag => `#${tag}`).join(', ');
    const tagHint = el('span', 'catalog-hint', 'Match all tags; separate with commas.');
    const tagField = field('Tags', tagInput); tagField.append(tagHint);
    const searchSubmit = el('button', 'catalog-button catalog-primary', 'Search'); searchSubmit.type = 'submit';
    form.append(field('Map name', search), tagField, searchSubmit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const selected = tagInput.value.split(/[\s,]+/).filter(Boolean).map(tag => tag.replace(/^#/, '').toLowerCase());
      if (selected.length > 12 || selected.some(tag => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag))) { tagInput.setCustomValidity('Use up to 12 tags containing letters, numbers or hyphens.'); tagInput.reportValidity(); return; }
      tagInput.setCustomValidity(''); setQuery({ search: search.value.trim(), tags: [...new Set(selected)] });
    });
    tagInput.addEventListener('input', () => tagInput.setCustomValidity(''));
    const toolbar = el('div', 'catalog-toolbar');
    const sort = el('select');
    for (const [value, label] of [['newest', 'Newest'], ['name', 'Name A–Z'], ['rating', 'Highest rating'], ['completions', 'Most finished']]) { const option = el('option', '', label); option.value = value; sort.append(option); }
    sort.value = state.sort; sort.addEventListener('change', () => setQuery({ sort: sort.value as CatalogSort }));
    const difficulty = el('select');
    for (const [value, label] of [['all', 'All difficulties'], ['normal', 'Normal'], ['hard', 'Hard']]) { const option = el('option', '', label); option.value = value; difficulty.append(option); }
    difficulty.value = state.difficulty; difficulty.addEventListener('change', () => setQuery({ difficulty: difficulty.value as CatalogUiState['difficulty'] }));
    const views = el('div', 'catalog-view-controls'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Map layout');
    for (const view of ['grid', 'list'] as const) {
      const toggle = button(view === 'grid' ? 'Grid' : 'List', () => { captureScroll(); state.view = view; save(); void render(); });
      toggle.setAttribute('aria-pressed', String(state.view === view)); views.append(toggle);
    }
    toolbar.append(field('Sort by', sort), field('Difficulty', difficulty), views);
    if (state.tags.length || state.search || state.difficulty !== 'all') toolbar.append(button('Clear filters', () => setQuery({ search: '', tags: [], difficulty: 'all' })));
    const wrapper = el('div', 'catalog-filters'); wrapper.append(form, toolbar); return wrapper;
  };
  async function render(focusMap = false): Promise<void> {
    if (destroyed || paused) return;
    const token = ++generation;
    restoringScroll = true;
    const detailId = state.detailId;
    const content = shell(!!detailId);
    if (!detailId) content.append(controls());
    const loading = statusBox(detailId ? 'Loading map…' : 'Loading maps…'); content.append(loading); content.setAttribute('aria-busy', 'true');
    try {
      if (detailId) {
        const entry = loadedEntry?.map.id === detailId ? loadedEntry : await options.reader.get(detailId);
        if (token !== generation || destroyed) return;
        content.removeAttribute('aria-busy'); loading.remove(); root.scrollTop = 0;
        if (!entry) { content.append(statusBox('This map is no longer available. Choose another map from the collection.')); return; }
        loadedEntry = entry;
        const article = el('article', 'catalog-detail'); article.append(preview(entry, true));
        const info = el('div', 'catalog-detail-info');
        const heading = el('h2', '', entry.map.metadata.title); heading.tabIndex = -1;
        info.append(heading, el('p', 'catalog-creator', `Created by ${entry.map.metadata.creator || 'Unknown creator'}`), el('p', 'catalog-description', entry.map.metadata.description || 'No description has been added.'), tags(entry), stats(entry, true));
        info.append(el('p', 'catalog-hint', `${entry.revision.width} × ${entry.revision.height} · Revision ${entry.revision.revision}`));
        const select = el('select');
        const modes = options.supportedDifficulties?.(entry) ?? ['normal', 'hard'];
        for (const mode of modes) { const option = el('option', '', mode === 'normal' ? 'Normal' : 'Hard'); option.value = mode; select.append(option); }
        select.value = modes.includes(state.difficulty as Difficulty) ? state.difficulty : modes[0] ?? '';
        const playError = statusBox(''); playError.hidden = true;
        const play = button('Play map', () => {
          play.disabled = true; play.textContent = 'Starting…'; playError.hidden = true;
          Promise.resolve().then(() => options.onPlay(entry, select.value as Difficulty)).catch(() => { playError.textContent = 'The map could not be started. Please try again.'; playError.hidden = false; playError.setAttribute('role', 'alert'); }).finally(() => { play.disabled = false; play.textContent = 'Play map'; });
        }, 'catalog-primary');
        play.disabled = modes.length === 0;
        info.append(field('Play difficulty', select), play, playError);
        if (options.renderDetailActions) { const actions = el('div', 'catalog-detail-actions'); options.renderDetailActions(actions, entry); info.append(actions); }
        article.append(info); content.append(article); heading.focus({ preventScroll: true });
      } else {
        const page = await options.reader.list({ search: state.search, tags: state.tags, sort: state.sort, difficulty: state.difficulty === 'all' ? undefined : state.difficulty, limit: PAGE_SIZE, offset: state.offset });
        if (token !== generation || destroyed) return;
        content.removeAttribute('aria-busy'); loading.remove();
        if (!page.entries.length && state.offset > 0 && page.total > 0) { state.offset = Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE; save(); return render(); }
        content.append(statusBox(`${page.total} ${page.total === 1 ? 'map' : 'maps'}${state.search || state.tags.length ? ' matching your filters' : ' in the collection'}`));
        if (!page.entries.length) content.append(el('div', 'catalog-empty', state.search || state.tags.length || state.difficulty !== 'all' ? 'No maps match these filters. Try another name or remove a tag.' : 'The collection is waiting for its first published map. Check back soon.'));
        const collection = el('ul', `catalog-entries catalog-${state.view}`);
        for (const entry of page.entries) {
          const item = el('li', 'catalog-card'); if (state.view === 'grid') item.append(preview(entry));
          const details = el('div', 'catalog-card-content');
          const open = button(entry.map.metadata.title, () => openDetail(entry), 'catalog-map-title'); open.dataset.mapId = entry.map.id;
          const heading = el('h2'); heading.append(open);
          details.append(heading, el('p', 'catalog-creator', `By ${entry.map.metadata.creator || 'Unknown creator'}`), tags(entry), stats(entry)); item.append(details); collection.append(item);
        }
        content.append(collection);
        if (page.total > PAGE_SIZE) {
          const pagination = el('nav', 'catalog-pagination'); pagination.setAttribute('aria-label', 'Map pages');
          const move = (offset: number) => { state.offset = offset; state.scrollTop = 0; save(); void render(); };
          const previous = button('← Previous', () => move(Math.max(0, state.offset - PAGE_SIZE))); previous.disabled = state.offset === 0;
          const next = button('Next →', () => move(state.offset + PAGE_SIZE)); next.disabled = state.offset + PAGE_SIZE >= page.total;
          pagination.append(previous, el('span', '', `Page ${Math.floor(state.offset / PAGE_SIZE) + 1} of ${Math.ceil(page.total / PAGE_SIZE)}`), next); content.append(pagination);
        }
        restoreScroll(focusMap);
      }
    } catch {
      if (token !== generation || destroyed) return;
      content.removeAttribute('aria-busy'); loading.remove(); content.append(statusBox('The map library could not be loaded. Check your connection and try again.', true), button('Try again', () => { void render(); }));
    }
  }
  void render();
  return {
    getState: () => structuredClone(state),
    refresh: () => { loadedEntry = null; return render(); },
    suspend: () => { captureScroll(); paused = true; generation++; save(); },
    resume: (returnToList = true) => { paused = false; if (returnToList) { state.detailId = null; loadedEntry = null; } save(); return render(returnToList); },
    destroy: () => { captureScroll(); save(); destroyed = true; generation++; root.removeEventListener('scroll', captureScroll); root.removeEventListener(RATING_UPDATED, updateRating); root.replaceChildren(); root.classList.remove('community-catalog'); root.removeAttribute('aria-label'); },
  };
}
