import { supportsPlayback } from '../shared/native-playback.ts';
import type { NativePlaybackPolicy } from '../shared/native-playback.ts';
import type { Difficulty, SupportedConfigurations } from '../shared/contracts.ts';
import { parseMap } from '../engine/map-format.ts';
import { AdminError, adminResponse, audit, errorResponse, readJson, requireFields } from './admin-auth.ts';
import { MapsAdmin, inTransaction, lockMap } from './maps-admin.ts';

export class PublicationService {
  private maps: MapsAdmin;
  private policy: SupportedConfigurations;
  private nativePlayback?: NativePlaybackPolicy;
  constructor(maps: MapsAdmin, policy: SupportedConfigurations, nativePlayback?: NativePlaybackPolicy) { this.maps = maps; this.policy = policy; this.nativePlayback = nativePlayback; }
  private modes(revision: any): Difficulty[] { return (['normal','hard'] as const).filter(mode => supportsPlayback(this.policy, revision.engine_hash, mode, revision.plugins, this.nativePlayback)); }
  async route(request: Request): Promise<Response | null> {
    const match = /^\/api\/admin\/maps\/([A-Za-z0-9_-]{1,128})\/(preview|publication|file)$/.exec(new URL(request.url).pathname);
    if (!match) return null;
    try {
      const actor = await this.maps.auth.require(request, 'curator', request.method !== 'GET');
      const id = match[1]; const action = match[2];
      const detail = await this.maps.detail(id);
      const revision = detail.revisions.find((row: any) => row.id === detail.map.current_revision_id);
      if (!revision) throw new AdminError(409, 'Map has no revision');
      if (action === 'preview') throw new AdminError(410, 'Previews now render in your browser; server screenshots are no longer generated.');
      if (request.method === 'GET' && action === 'file') {
        const object = await this.maps.storage.get(revision.object_key);
        if (!object) throw new AdminError(404, 'Map file unavailable');
        return new Response(Buffer.from(object.bytes), { headers: { 'Content-Type': 'application/vnd.konkr.map', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="map.konkr"' } });
      }
      if (request.method !== 'POST' || action === 'file') return adminResponse({ error: 'Method not allowed' }, 405);
      const data = await readJson(request);
      requireFields(data, ['expectedVersion', 'state']);
      if (!['published','archived'].includes(data.state as string)) throw new AdminError(400, 'Invalid publication request');
      await inTransaction(this.maps.db, async client => {
        const current = await lockMap(client, id, data.expectedVersion);
        if (current.current_revision_id !== revision.id) throw new AdminError(409, 'Map revision changed');
        if (data.state === 'published') {
          if (!this.modes(revision).length) throw new AdminError(422, 'This engine and plugin combination is not supported');
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
