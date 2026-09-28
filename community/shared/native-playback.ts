import { supports } from './contracts.ts';
import type { Difficulty, SupportedConfigurations } from './contracts.ts';

/** Native browser capabilities are separate from independently verified replay support. */
export const NATIVE_MAP_PLUGINS = ['always-retreat', 'buy-gifts', 'buy-towns', 'capture-towns', 'low-upkeep', 'pick-landing-spot', 'spawn-gifts', 'zombies'] as const;
export interface NativePlaybackPolicy { engineHash: string; plugins: readonly string[] }
export function nativePlaybackPlugins(policy?: NativePlaybackPolicy): string[] {
  return [...new Set(policy?.plugins ?? [])].filter(plugin => (NATIVE_MAP_PLUGINS as readonly string[]).includes(plugin));
}
export function supportsPlayback(policy: SupportedConfigurations, engineHash: string, difficulty: Difficulty, plugins: string[], nativePlayback?: NativePlaybackPolicy): boolean {
  if (supports(policy, engineHash, difficulty, plugins)) return true;
  if (!nativePlayback?.engineHash || engineHash !== nativePlayback.engineHash || !['normal','hard'].includes(difficulty) || new Set(plugins).size !== plugins.length) return false;
  const available = nativePlaybackPlugins(nativePlayback);
  return plugins.every(plugin => available.includes(plugin));
}
