import { supports } from '../shared/contracts.ts';
import type { Difficulty, SupportedConfigurations } from '../shared/contracts.ts';
import { parseMap } from '../engine/map-format.ts';
import type { PreviewRenderer } from '../runtime/preview.ts';
import { AdminError, adminResponse, audit, errorResponse, readJson, requireFields } from './admin-auth.ts';
import { MapsAdmin, inTransaction, lockMap } from './maps-admin.ts';

export class PublicationService {
  private maps: MapsAdmin;
  private policy: SupportedConfigurations;
  private renderer: PreviewRenderer;
  constructor(maps: MapsAdmin, policy: SupportedConfigurations, renderer: PreviewRenderer) { this.maps = maps; this.policy = policy; this.renderer = renderer; }
  private modes(revision: any): Difficulty[] { return (['normal','hard'] as const).filter(mode => supports(this.policy, revision.engine_hash, mode, revision.plugins)); }
  async route(request: Request): Promise<Response | null> {
    const match = /^\/api\/admin\/maps\/([A-Za-z0-9_-]{1,128})\/(preview|publication|file)$/.exec(new URL(request.url).pathname);
    if (!match) return null;
    try {
      const actor = await this.maps.auth.require(request, 'curator', request.method !== 'GET');
      const id = match[1]; const action = match[2];
      const detail = await this.maps.detail(id);
      const revision = detail.revisions.find((row: any) => row.id === detail.map.current_revision_id);
      if (!revision) throw new AdminError(409, 'Map has no revision');
      if (request.method === 'GET' && (action === 'preview' || action === 'file')) {
        const key = action === 'preview' ? revision.preview_key : revision.object_key;
        const object = key ? await this.maps.storage.get(key) : null;
        if (!object) throw new AdminError(404, action === 'preview' ? 'Generate a preview first' : 'Map file unavailable');
        return new Response(Buffer.from(object.bytes), { headers: { 'Content-Type': action === 'preview' ? 'image/png' : 'application/vnd.konkr.map', 'Cache-Control': 'no-store', ...(action === 'file' ? { 'Content-Disposition': 'attachment; filename="map.konkr"' } : {}) } });
      }
      if (request.method !== 'POST' || action === 'file') return adminResponse({ error: 'Method not allowed' }, 405);
      const data = await readJson(request);
      if (action === 'preview') {
        requireFields(data, ['expectedVersion']);
        if (data.expectedVersion !== detail.map.version) throw new AdminError(409, 'Map changed. Reload before previewing.');
        const modes = this.modes(revision); if (!modes.length) throw new AdminError(422, 'This engine and plugin combination is not supported');
        const object = await this.maps.storage.get(revision.object_key); if (!object) throw new AdminError(503, 'Map file unavailable');
        const encoded = Buffer.from(object.bytes).toString('utf8');
        if (parseMap(encoded).contentHash !== revision.content_hash) throw new AdminError(503, 'Stored map checksum mismatch');
        let png: Uint8Array;
        try { png = await this.renderer.render(encoded, modes[0]); } catch { throw new AdminError(503, 'Preview failed or timed out. Retry after checking the map.'); }
        if (!validPng(png)) throw new AdminError(503, 'Preview renderer returned invalid media');
        const key = `previews/${revision.id}.png`;
        await this.maps.storage.put(key, png, 'image/png');
        await inTransaction(this.maps.db, async client => {
          const current = await lockMap(client, id, data.expectedVersion);
          if (current.current_revision_id !== revision.id) throw new AdminError(409, 'Revision changed while rendering');
          await client.query('UPDATE map_revisions SET preview_key=$2 WHERE id=$1', [revision.id, key]);
          await audit(client, actor, 'preview-ready', id, { revisionId: revision.id });
        });
        return adminResponse(await this.maps.detail(id));
      }
      requireFields(data, ['expectedVersion', 'state']);
      if (!['published','archived'].includes(data.state as string)) throw new AdminError(400, 'Invalid publication request');
      await inTransaction(this.maps.db, async client => {
        const current = await lockMap(client, id, data.expectedVersion);
        if (current.current_revision_id !== revision.id) throw new AdminError(409, 'Map revision changed');
        if (data.state === 'published') {
          if (!this.modes(revision).length) throw new AdminError(422, 'This engine and plugin combination is not supported');
          const preview = revision.preview_key ? await this.maps.storage.get(revision.preview_key) : null;
          if (!preview || !validPng(preview.bytes)) throw new AdminError(409, 'Generate a valid preview before publishing');
          const object = await this.maps.storage.get(revision.object_key);
          if (!object || parseMap(Buffer.from(object.bytes).toString('utf8')).contentHash !== revision.content_hash) throw new AdminError(503, 'Stored map unavailable or damaged');
        }
        await client.query("UPDATE maps SET state=$2,published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1", [id, data.state]);
        await audit(client, actor, data.state === 'published' ? 'publish' : 'archive', id, { revisionId: revision.id });
      });
      return adminResponse(await this.maps.detail(id));
    } catch (error) { return errorResponse(error); }
  }
}
function validPng(bytes: Uint8Array): boolean { return bytes.length >= 24 && bytes.length <= 2_000_000 && Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])); }
