import type { AdminClient } from './admin.ts';
import type { PublicationEditor } from './map-editor.ts';

export function publicationControls(client: AdminClient) {
  return (root: HTMLElement, editor: PublicationEditor) => {
    const frame = document.createElement('div'); frame.className = 'admin-preview-frame';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'admin-publication-actions';
    const publish = document.createElement('button'); publish.type = 'button'; publish.textContent = 'Publish'; publish.className = 'konkr-primary';
    const archive = document.createElement('button'); archive.type = 'button'; archive.textContent = 'Archive'; archive.className = 'konkr-danger';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry preview'; retry.hidden = true;
    actions.append(publish, archive); root.append(frame, retry, actions, status);
    let busy = false; let previewFailed = false;
    const refresh = () => {
      if (!editor.active()) return;
      const detail = editor.detail(); const map = detail.map;
      const revision = detail.revisions.find((row: any) => row.id === map.current_revision_id);
      frame.replaceChildren();
      if (revision.preview_key) {
        const image = document.createElement('img'); image.src = `/api/admin/maps/${map.id}/preview`; image.alt = `Map preview: ${map.title}`; frame.append(image);
      } else { frame.textContent = previewFailed ? 'Preview unavailable' : 'Preparing map preview…'; }
      retry.disabled = busy;
      publish.disabled = busy || map.state === 'published'; archive.disabled = busy || map.state === 'archived';
    };
    const preparePreview = async () => {
      const detail = editor.detail(); const revision = detail.revisions.find((row: any) => row.id === detail.map.current_revision_id);
      if (revision.preview_key) return;
      const result = await client.request(`/api/admin/maps/${detail.map.id}/preview`, { method: 'POST', body: JSON.stringify({ expectedVersion: detail.map.version }) });
      editor.update(result); previewFailed = false; refresh();
    };
    const run = (work: () => Promise<void>) => {
      busy = true; status.textContent = ''; refresh();
      return editor.perform(work).catch(error => {
        if (!editor.active()) return;
        status.textContent = error instanceof Error ? error.message : 'Request failed';
        const detail = editor.detail(); const revision = detail.revisions.find((row: any) => row.id === detail.map.current_revision_id);
        if (!revision.preview_key) { previewFailed = true; retry.hidden = false; }
      }).finally(() => { busy = false; if (editor.active()) refresh(); });
    };
    const preview = () => { retry.hidden = true; previewFailed = false; void run(preparePreview); };
    retry.onclick = preview;
    const changeState = (state: 'published' | 'archived') => run(async () => {
      if (state === 'published') { await preparePreview(); if (!editor.active()) return; await editor.saveMetadata(); }
      if (!editor.active()) return;
      const detail = editor.detail();
      const result = await client.request(`/api/admin/maps/${detail.map.id}/publication`, { method: 'POST', body: JSON.stringify({ expectedVersion: detail.map.version, state }) });
      editor.update(result);
      if (editor.active()) status.textContent = state === 'published' ? 'Published. Players can now find this map.' : 'Archived. This map is no longer in the catalogue.';
    });
    publish.onclick = () => { void changeState('published'); };
    archive.onclick = () => { void changeState('archived'); };
    editor.onUpdate(refresh); refresh(); preview();
  };
}
