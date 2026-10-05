export interface VotingManifest { version: 1; maps: { id: string; revisionId: string }[] }

export function parseVotingManifest(value: unknown): Map<string, string> {
  const manifest = value as VotingManifest;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.maps) || !manifest.maps.length || manifest.maps.length > 10000) throw new Error('Invalid voting manifest');
  const maps = new Map<string, string>();
  for (const map of manifest.maps) {
    if (!map || typeof map.id !== 'string' || typeof map.revisionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(map.id) || !/^r-[a-f0-9]{64}$/.test(map.revisionId) || maps.has(map.id)) throw new Error('Invalid or duplicate map in voting manifest');
    maps.set(map.id, map.revisionId);
  }
  return maps;
}
