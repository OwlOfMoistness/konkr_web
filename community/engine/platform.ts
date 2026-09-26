import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createContext, runInContext } from 'node:vm';

/** The dynamic boundary is limited to the hash-pinned, recovered game modules. */
export type Recovered = Record<string, any>;
export type EngineRequire = ((id: number) => Recovered) & { m: Record<number, (...args: any[]) => void> };
export interface EngineSourceOptions { repositoryRoot?: string }
export interface EngineSources {
  main: string;
  vendor: string;
  mainHash: string;
  vendorHash: string;
  engineHash: string;
}
export const ADAPTER_VERSION = 'konkr-node-1';
export const PINNED_RELEASE = Object.freeze({
  release: '2.35.30',
  main: 'main.767a81ddb61f928b36d7.bundle.js',
  vendor: 'vendors.d5bf7f8c0122f25ddc8b.bundle.js',
  mainHash: '29377f4e0a30607db86558af7f09cfe546dca5e9993fb87060fdb2eb160cd98a',
  vendorHash: 'e52e1a4f98527997624db96fe72a7d3a2c366c6b8861c8d24371a0b8f39f34c1',
});
const STARTUP = 's.O(void 0,[216],(()=>s(s.s=48762)));var n=s.O(void 0,[216],(()=>s(s.s=9332)));n=s.O(n)';
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export async function loadEngineSources(options: EngineSourceOptions = {}): Promise<EngineSources> {
  const root = options.repositoryRoot ?? fileURLToPath(new URL('../../', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(root, 'community/runtime/manifest.json'), 'utf8'));
  if (manifest.release !== PINNED_RELEASE.release || manifest.main !== PINNED_RELEASE.main ||
      manifest.vendor !== PINNED_RELEASE.vendor || manifest.files[manifest.main] !== PINNED_RELEASE.mainHash ||
      manifest.files[manifest.vendor] !== PINNED_RELEASE.vendorHash ||
      manifest.sourceDirectory !== '_site/releases/2.35.30') throw new Error('Unsupported engine manifest');
  const sourceRoot = path.join(root, manifest.sourceDirectory);
  const [main, vendor] = await Promise.all([
    readFile(path.join(sourceRoot, manifest.main), 'utf8'), readFile(path.join(sourceRoot, manifest.vendor), 'utf8'),
  ]);
  if (sha256(main) !== PINNED_RELEASE.mainHash || sha256(vendor) !== PINNED_RELEASE.vendorHash) {
    throw new Error('Engine bundle checksum mismatch');
  }
  return { main, vendor, mainHash: PINNED_RELEASE.mainHash, vendorHash: PINNED_RELEASE.vendorHash,
    engineHash: PINNED_RELEASE.mainHash };
}

export function guardMainBundle(main: string, expectedHash: string): string {
  if (expectedHash !== PINNED_RELEASE.mainHash || sha256(main) !== expectedHash) throw new Error('Main bundle checksum mismatch');
  if (main.split(STARTUP).length !== 2) throw new Error('Unexpected engine startup boundary');
  return main.replace(STARTUP, 'globalThis.__konkrRequire=s');
}

export function createModuleLoader(sources: EngineSources): { requireModule: EngineRequire; loadedModules: number[] } {
  // A fresh context isolates engine caches, not untrusted code. Only verified
  // release code is evaluated. Resource enforcement belongs to the outer worker.
  // https://nodejs.org/api/vm.html#vmrunincontextcode-contextifiedobject-options
  if (sources.vendorHash !== PINNED_RELEASE.vendorHash || sha256(sources.vendor) !== sources.vendorHash ||
      sources.engineHash !== PINNED_RELEASE.mainHash) throw new Error('Vendor bundle checksum mismatch');
  const guarded = guardMainBundle(sources.main, sources.mainHash);
  const context = createContext({ self: {}, performance, crypto: webcrypto }, {
    name: 'konkr-pinned-engine', codeGeneration: { strings: false, wasm: false },
  });
  runInContext(sources.vendor, context, { timeout: 5_000, filename: PINNED_RELEASE.vendor });
  runInContext(guarded, context, { timeout: 5_000, filename: PINNED_RELEASE.main });
  const requireModule = context.__konkrRequire as EngineRequire;
  const loadedModules: number[] = [];
  for (const [id, factory] of Object.entries(requireModule.m)) {
    requireModule.m[Number(id)] = function (...args: any[]) {
      loadedModules.push(Number(id));
      return factory.apply(this, args);
    };
  }
  return { requireModule, loadedModules };
}
