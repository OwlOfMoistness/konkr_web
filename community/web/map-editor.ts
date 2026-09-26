import type { AdminClient } from './admin.ts';
import { LIMITS } from '../shared/contracts.ts';

export interface MapEditorOptions { renderPublication?: (root: HTMLElement, detail: any, reload: () => Promise<void>) => void }
export function mountMapEditor(root: HTMLElement, client: AdminClient, options: MapEditorOptions = {}): void {
  let offset = 0;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const button = (label: string, action: () => Promise<void> | void) => {
    const node = element('button', label); node.type = 'button'; node.onclick = () => { node.disabled = true; void Promise.resolve().then(action).catch(showError).finally(() => { node.disabled = false; }); }; return node;
  };
  const status = element('p'); status.setAttribute('role', 'status');
  const showError = (error: unknown) => { status.textContent = error instanceof Error ? error.message : 'Request failed'; };
  const fileInput = (labelText: string, upload: (encoded: string) => Promise<void>) => {
    const label = element('label', labelText); const input = element('input'); input.type = 'file'; input.accept = '.konkr'; label.append(input);
    input.onchange = () => { const file = input.files?.[0]; if (!file) return; input.disabled = true;
      void (async () => { if (file.size > LIMITS.encodedMapBytes) throw new Error('Map file is too large'); await upload(await file.text()); })().catch(showError).finally(() => { input.disabled = false; input.value = ''; });
    }; return label;
  };
  async function detail(id: string) {
    const data = await client.request(`/api/admin/maps/${encodeURIComponent(id)}`); const map = data.map;
    root.replaceChildren(element('h1', map.title), button('← Curated maps', list), status);
    status.textContent = '';
    const revision = data.revisions.find((item: any) => item.id === map.current_revision_id);
    root.append(element('p', `${map.state} · revision ${revision.revision} · ${revision.width} × ${revision.height} · ${revision.plugins.join(', ') || 'standard rules'}`));
    const form = element('form'); const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
    for (const [key, labelText, max] of [['title', 'Title', LIMITS.titleLength], ['creator', 'Creator', LIMITS.creatorLength], ['description', 'Description', LIMITS.descriptionLength], ['tags', 'Tags (comma separated)', 420]] as const) {
      const label = element('label', labelText); const input = key === 'description' ? element('textarea') : element('input');
      input.value = key === 'tags' ? map.tags.join(', ') : map[key]; input.maxLength = max; input.required = key === 'title'; fields[key] = input; label.append(input); form.append(label);
    }
    const save = element('button', 'Save metadata'); form.append(save);
    form.onsubmit = event => { event.preventDefault(); save.disabled = true;
      void client.request(`/api/admin/maps/${id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: map.version, metadata: { title: fields.title.value, creator: fields.creator.value, description: fields.description.value, tags: fields.tags.value.split(',').map(value => value.trim()).filter(Boolean) } }) }).then(() => detail(id)).catch(showError).finally(() => { save.disabled = false; });
    };
    root.append(form, fileInput('Upload a new gameplay revision (returns to draft)', async encoded => {
      await client.request(`/api/admin/maps/${id}/revisions`, { method: 'POST', body: JSON.stringify({ encoded, expectedVersion: map.version }) }); await detail(id);
    }));
    const publication = element('section'); root.append(publication); options.renderPublication?.(publication, data, () => detail(id));
    const history = element('details'); history.append(element('summary', 'Revision history'));
    for (const item of data.revisions) history.append(element('p', `Revision ${item.revision} · ${item.created_at} · ${item.content_hash.slice(0,12)}`)); root.append(history);
  }
  async function list() {
    const data = await client.request(`/api/admin/maps?offset=${offset}`);
    root.replaceChildren(element('h1', 'Curated maps'), button('Sign out', () => client.signOut()), status); status.textContent = '';
    root.append(fileInput('Add a .konkr map', async encoded => {
      const result = await client.request('/api/admin/maps', { method: 'POST', body: JSON.stringify({ encoded }) }); await detail(result.map.id);
      if (result.warnings.length) status.textContent = result.warnings.join(' ');
    }));
    const items = element('ul'); for (const map of data.maps) { const item = element('li'); item.append(button(`${map.title} · ${map.state}`, () => detail(map.id))); items.append(item); } root.append(items);
    if (!data.maps.length) root.append(element('p', 'No maps on this page.'));
    if (offset) root.append(button('Previous', async () => { offset -= 50; await list(); }));
    if (data.maps.length === 50) root.append(button('Next', async () => { offset += 50; await list(); }));
  }
  void list().catch(error => { root.replaceChildren(status); showError(error); });
}
