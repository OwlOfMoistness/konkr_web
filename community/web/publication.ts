import type { AdminClient } from './admin.ts';
import type { PublicationEditor } from './map-editor.ts';

export interface PublicationOptions {
  /** Render directly in the browser; disposing releases the mounted view. */
  mountPreview?: (container: HTMLElement, detail: any) => { ready: Promise<void>; destroy(): void };
}

export function publicationControls(client: AdminClient, options: PublicationOptions = {}) {
  return (root: HTMLElement, editor: PublicationEditor) => {
    const frame = document.createElement('div'); frame.className = 'admin-preview-frame';
    const previewStatus = document.createElement('p'); previewStatus.setAttribute('role', 'status');
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'admin-publication-actions';
    const publish = document.createElement('button'); publish.type = 'button'; publish.textContent = 'Publish'; publish.className = 'konkr-primary';
    const archive = document.createElement('button'); archive.type = 'button'; archive.textContent = 'Archive'; archive.className = 'konkr-danger';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry preview'; retry.hidden = true;
    actions.append(publish, archive); root.append(frame, retry, previewStatus, actions, status);
    let busy = false; let previewGeneration = 0; let disposePreview: (() => void) | undefined;
    const refresh = () => {
      if (!editor.active()) return;
      const state = editor.detail().map.state;
      publish.disabled = busy || state === 'published'; archive.disabled = busy || state === 'archived';
    };
    const preview = async () => {
      const token = ++previewGeneration;
      disposePreview?.(); disposePreview = undefined;
      frame.replaceChildren(); retry.hidden = true; retry.disabled = true; previewStatus.textContent = '';
      if (!options.mountPreview) { frame.textContent = 'Map preview'; return; }
      frame.textContent = 'Preparing map preview…';
      try {
        const preview = options.mountPreview(frame, editor.detail());
        disposePreview = () => preview.destroy();
        await preview.ready;
        if (!editor.active() || token !== previewGeneration) return;
      } catch (error) {
        if (!editor.active() || token !== previewGeneration) return;
        frame.textContent = 'Preview unavailable'; retry.hidden = false;
        previewStatus.textContent = error instanceof Error ? error.message : 'The map preview could not load.';
      } finally { if (editor.active() && token === previewGeneration) retry.disabled = false; }
    };
    retry.onclick = () => { void preview(); };
    const changeState = (state: 'published' | 'archived') => {
      busy = true; status.textContent = ''; refresh();
      void editor.perform(async () => {
        if (state === 'published') await editor.saveMetadata();
        if (!editor.active()) return;
        const detail = editor.detail();
        const result = await client.request(`/api/admin/maps/${detail.map.id}/publication`, { method: 'POST', body: JSON.stringify({ expectedVersion: detail.map.version, state }) });
        editor.update(result);
        if (editor.active()) status.textContent = state === 'published' ? 'Published. Players can now find this map.' : 'Archived. This map is no longer in the catalogue.';
      }).catch(error => { if (editor.active()) status.textContent = error instanceof Error ? error.message : 'Request failed'; })
        .finally(() => { busy = false; refresh(); });
    };
    publish.onclick = () => { changeState('published'); };
    archive.onclick = () => { changeState('archived'); };
    editor.onUpdate(refresh);
    editor.onDispose(() => { previewGeneration++; disposePreview?.(); disposePreview = undefined; });
    refresh(); void preview();
  };
}
