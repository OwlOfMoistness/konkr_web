import type { RunBinding } from './contracts.ts';

/** Save/category identity only. Retain canonical file bytes and their content hash. */
export async function runtimeLevelId(binding: Pick<RunBinding, 'mapId' | 'revisionId' | 'engineHash' | 'difficulty'>): Promise<string> {
  for (const value of [binding.mapId, binding.revisionId, binding.engineHash]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid runtime identity');
  }
  if (binding.difficulty !== 'normal' && binding.difficulty !== 'hard') throw new Error('Invalid runtime difficulty');
  const input = new TextEncoder().encode(JSON.stringify([1, binding.mapId, binding.revisionId, binding.engineHash, binding.difficulty]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return 'cl-community-' + Array.from(hash.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}
