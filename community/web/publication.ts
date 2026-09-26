import type { AdminClient } from './admin.ts';

export function publicationControls(client: AdminClient) {
  return (root: HTMLElement, detail: any, reload: () => Promise<void>) => {
    const map = detail.map; const revision = detail.revisions.find((row: any) => row.id === map.current_revision_id);
    const heading = document.createElement('h2'); heading.textContent = 'Preview and publication'; root.append(heading);
    if (revision.preview_key) { const image = document.createElement('img'); image.src = `/api/admin/maps/${map.id}/preview`; image.alt = `Map preview: ${map.title}`; image.style.maxWidth = '100%'; root.append(image); }
    const download = document.createElement('a'); download.href = `/api/admin/maps/${map.id}/file`; download.download = 'map.konkr'; download.textContent = 'Download this revision for playtesting'; root.append(download);
    const status = document.createElement('p'); status.setAttribute('role','status');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    const label = document.createElement('label'); label.append(checkbox, document.createTextNode(' I have playtested this revision and checked its metadata.'));
    const button = (title: string, action: string, data: unknown) => {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = title;
      node.onclick = () => { node.disabled = true;
        const payload = action === 'preview' ? data : { ...(data as object), playtested: checkbox.checked };
        void client.request(`/api/admin/maps/${map.id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }).then(reload).catch(error => { status.textContent = error.message; }).finally(() => { node.disabled = false; });
      }; return node;
    };
    root.append(button('Generate preview','preview',{ expectedVersion: map.version }), label,
      button('Publish','publication',{ expectedVersion: map.version, state: 'published' }),
      button('Archive','publication',{ expectedVersion: map.version, state: 'archived' }), status);
  };
}
