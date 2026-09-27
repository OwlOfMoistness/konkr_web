import type { AdminClient } from './admin.ts';
import { LIMITS } from '../shared/contracts.ts';

export interface PublicationEditor {
  detail(): any;
  active(): boolean;
  update(detail: any): void;
  onUpdate(listener: () => void): void;
  perform<T>(work: () => Promise<T>): Promise<T>;
  saveMetadata(): Promise<void>;
}
export interface MapEditorOptions { renderPublication?: (root: HTMLElement, editor: PublicationEditor) => void }

export function mountMapEditor(root: HTMLElement, client: AdminClient, options: MapEditorOptions = {}): { showList(): Promise<void>; destroy(): void } {
  let offset = 0; let generation = 0; let batchRunning = false;
  // The original preview renderer accepts one job at a time. This also orders
  // metadata/publication changes so each action uses the latest map version.
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = pending.then(work); pending = next.catch(() => {}); return next;
  };
  const current = (token: number) => token === generation && root.isConnected;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
  const button = (label: string, action: () => Promise<unknown> | void, status: HTMLElement, active: () => boolean) => {
    const node = element('button', label); node.type = 'button'; node.disabled = batchRunning;
    node.onclick = () => { node.disabled = true; void Promise.resolve().then(action).catch(error => {
      if (active()) status.textContent = message(error);
    }).finally(() => { node.disabled = batchRunning; }); }; return node;
  };
  const readMap = async (file: File) => {
    if (file.size > LIMITS.encodedMapBytes) throw new Error('Map file is too large');
    return file.text();
  };

  async function loadView(path: string, token: number) {
    try { return await client.request(path); }
    catch (error) {
      if (current(token)) {
        const status = element('p', message(error)); status.setAttribute('role', 'status');
        root.replaceChildren(status, button('← Curated maps', list, status, () => current(token)));
      }
      return null;
    }
  }
  async function detail(id: string) {
    if (batchRunning) return;
    const token = ++generation; const active = () => current(token);
    const data = await loadView(`/api/admin/maps/${encodeURIComponent(id)}`, token);
    if (!active() || !data) return;
    let latest = data; const listeners = new Set<() => void>();
    const heading = element('h1', data.map.title);
    const status = element('p'); status.setAttribute('role', 'status');
    const state = element('span', '', 'admin-map-state');
    const top = element('div', '', 'admin-editor-heading'); top.append(heading, state);
    root.replaceChildren(button('← Curated maps', list, status, active), top, status);
    const update = (next: any) => {
      if (!active()) return;
      latest = next; heading.textContent = next.map.title;
      state.textContent = next.map.state[0].toUpperCase() + next.map.state.slice(1);
      state.dataset.state = next.map.state;
      for (const listener of listeners) listener();
    };
    update(data);
    const layout = element('div', '', 'admin-editor-layout');
    const form = element('form', '', 'admin-metadata');
    const grid = element('div', '', 'admin-metadata-grid');
    const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
    for (const [key, labelText, max] of [['title', 'Title', LIMITS.titleLength], ['creator', 'Creator', LIMITS.creatorLength], ['description', 'Description', LIMITS.descriptionLength], ['tags', 'Tags (comma separated)', 420]] as const) {
      const label = element('label', labelText, ['description','tags'].includes(key) ? 'admin-field-wide' : '');
      const input = key === 'description' ? element('textarea') : element('input');
      input.value = key === 'tags' ? data.map.tags.join(', ') : data.map[key];
      input.maxLength = max; input.required = key === 'title'; fields[key] = input; label.append(input); grid.append(label);
    }
    const save = element('button', 'Save metadata');
    const actions = element('div', '', 'admin-editor-actions'); actions.append(save); form.append(grid, actions);
    const saveMetadata = async () => {
      if (!active()) return;
      if (!form.reportValidity()) throw new Error('Please check the map details.');
      const metadata = { title: fields.title.value, creator: fields.creator.value, description: fields.description.value,
        tags: fields.tags.value.split(',').map(value => value.trim()).filter(Boolean) };
      if (JSON.stringify(metadata) === JSON.stringify({ title: latest.map.title, creator: latest.map.creator, description: latest.map.description, tags: latest.map.tags })) return;
      const result = await client.request(`/api/admin/maps/${id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: latest.map.version, metadata }) });
      update(result);
    };
    form.onsubmit = event => {
      event.preventDefault(); save.disabled = true;
      void serial(saveMetadata).then(() => { if (active()) status.textContent = 'Map details saved.'; })
        .catch(error => { if (active()) status.textContent = message(error); }).finally(() => { save.disabled = false; });
    };
    const publication = element('section', '', 'admin-preview-panel'); layout.append(form, publication); root.append(layout);
    options.renderPublication?.(publication, {
      detail: () => latest, active, update, onUpdate: listener => { listeners.add(listener); },
      perform: work => serial(async () => { if (!active()) throw new Error('Editor closed'); return work(); }),
      saveMetadata,
    });
    const advanced = element('details', '', 'admin-advanced'); advanced.append(element('summary', 'Map file and history'));
    const download = element('a', 'Download map'); download.href = `/api/admin/maps/${id}/file`; download.download = 'map.konkr'; advanced.append(download);
    const label = element('label', 'Replace map file (returns to draft)');
    const input = element('input'); input.type = 'file'; input.accept = '.konkr'; label.append(input); advanced.append(label);
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return; input.disabled = true;
      void serial(async () => {
        if (!active()) return;
        await client.request(`/api/admin/maps/${id}/revisions`, { method: 'POST', body: JSON.stringify({ encoded: await readMap(file), expectedVersion: latest.map.version }) });
        if (active()) await detail(id);
      }).catch(error => { if (active()) status.textContent = message(error); }).finally(() => { input.disabled = false; input.value = ''; });
    };
    for (const revision of data.revisions) advanced.append(element('p', `Revision ${revision.revision} · ${revision.created_at}`));
    root.append(advanced);
  }

  async function list() {
    if (batchRunning) return;
    const token = ++generation; const active = () => current(token);
    const data = await loadView(`/api/admin/maps?offset=${offset}`, token); if (!active() || !data) return;
    const status = element('p'); status.setAttribute('role', 'status');
    const label = element('label', 'Add .konkr maps', 'admin-upload');
    const input = element('input'); input.type = 'file'; input.accept = '.konkr'; input.multiple = true; label.append(input);
    const results = element('ul', '', 'admin-upload-results'); results.setAttribute('aria-label', 'Upload results');
    const items = element('ul', '', 'admin-map-list'); const pages = element('div', '', 'admin-editor-actions');
    root.replaceChildren(element('h1', 'Curated maps'), label, status, results, items, pages);
    const renderMaps = (maps: any[]) => {
      if (!active()) return; items.replaceChildren(); pages.replaceChildren();
      for (const map of maps) {
        const item = element('li'); const open = button(map.title, () => detail(map.id), status, active);
        const badge = element('span', map.state[0].toUpperCase() + map.state.slice(1), 'admin-map-state'); badge.dataset.state = map.state;
        open.setAttribute('aria-label', map.title); open.append(badge); item.append(open); items.append(item);
      }
      if (!maps.length) items.append(element('li', 'No maps on this page.'));
      if (offset) pages.append(button('Previous', async () => { offset -= 50; await list(); }, status, active));
      if (maps.length === 50) pages.append(button('Next', async () => { offset += 50; await list(); }, status, active));
    };
    renderMaps(data.maps);
    input.onchange = () => {
      const files = Array.from(input.files ?? []); if (!files.length) return; input.disabled = true; results.replaceChildren(); status.textContent = '';
      batchRunning = files.length > 1;
      if (batchRunning) for (const control of root.querySelectorAll('button')) control.disabled = true;
      void (async () => {
        for (const [index, file] of files.entries()) {
          if (!active()) break;
          if (batchRunning) status.textContent = `Preparing map ${index + 1} of ${files.length}. Editing is available when uploads finish.`;
          const item = element('li'); const progress = element('span', `${file.name}: uploading…`); item.append(progress); results.append(item);
          let uploaded: any;
          try {
            await serial(async () => {
              if (!active()) return;
              uploaded = await client.request('/api/admin/maps', { method: 'POST', body: JSON.stringify({ encoded: await readMap(file) }) });
              if (!active()) return;
              if (files.length === 1) { await detail(uploaded.map.id); return; }
              progress.textContent = `${file.name}: preparing preview…`;
              await client.request(`/api/admin/maps/${uploaded.map.id}/preview`, { method: 'POST', body: JSON.stringify({ expectedVersion: uploaded.map.version }) });
            });
            if (active()) progress.textContent = `${file.name}: draft ready.${uploaded?.warnings?.length ? ' ' + uploaded.warnings.join(' ') : ''}`;
          } catch (error) {
            if (active()) progress.textContent = `${file.name}: ${uploaded ? 'Draft saved; preview unavailable. ' : ''}${message(error)}`;
          }
          if (active() && uploaded) item.append(button('Edit map', () => detail(uploaded.map.id), status, active));
        }
        if (active()) {
          renderMaps((await client.request(`/api/admin/maps?offset=${offset}`)).maps);
          if (active()) status.textContent = 'Uploads finished. Maps remain drafts until you publish them.';
        }
      })().catch(error => { if (active()) status.textContent = message(error); }).finally(() => {
        batchRunning = false; input.disabled = false; input.value = '';
        if (active()) for (const control of root.querySelectorAll('button')) control.disabled = false;
      });
    };
  }
  void list().catch(error => { if (root.isConnected) { const status = element('p', message(error)); status.setAttribute('role', 'status'); root.replaceChildren(status); } });
  return { showList: list, destroy() { generation++; } };
}
