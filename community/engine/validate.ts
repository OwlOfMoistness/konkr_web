import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ContractError, LIMITS, parseDecision, supports } from '../shared/contracts.ts';
import type { SimulationAdapter, SupportedConfigurations, ValidationInput, ValidationResult } from '../shared/contracts.ts';
import { runtimeLevelId } from '../shared/runtime-identity.ts';
import { parseMap } from './map-format.ts';
import { createEngineSession, SimulationLimitError } from './adapter.ts';
import type { SimulationLimits } from './adapter.ts';
import { ADAPTER_VERSION, loadEngineSources, PINNED_RELEASE } from './platform.ts';
import type { EngineSourceOptions } from './platform.ts';
import { applyPlayerDecision, PlayerCommandError, UnsupportedDecisionError } from './player-commands.ts';

export interface ValidatorOptions {
  /** Trusted reviewed policy. There is intentionally no permissive default. */
  policy: SupportedConfigurations;
  sourceOptions?: EngineSourceOptions;
  limits?: Partial<SimulationLimits>;
  timeoutMs?: number;
  memoryMb?: number;
}
export const DEFAULT_VALIDATOR_RESOURCES = Object.freeze({ timeoutMs: 120_000, memoryMb: 512 });

function prepareInput(input: ValidationInput, options: ValidatorOptions): ValidationInput | ValidationResult {
  try {
    if (!input || !input.binding || !Array.isArray(input.decisions)) return { status: 'invalid', code: 'invalid-input' };
    if (input.decisions.length > LIMITS.decisions || Buffer.byteLength(JSON.stringify(input.decisions)) > LIMITS.submissionBytes) {
      return { status: 'unsupported', code: 'decision-limit' };
    }
    const map = parseMap(input.canonicalMap);
    const binding = input.binding;
    if (binding.mapHash !== map.contentHash || binding.plugins.length !== map.plugins.length ||
        binding.plugins.some((key, index) => key !== map.plugins[index])) return { status: 'invalid', code: 'map-binding-mismatch' };
    if (binding.engineHash !== PINNED_RELEASE.mainHash || binding.adapterVersion !== ADAPTER_VERSION) return { status: 'unsupported', code: 'engine-version' };
    if (binding.seed !== undefined && (!Number.isSafeInteger(binding.seed) || binding.seed < 0)) return { status: 'invalid', code: 'invalid-seed' };
    if (!supports(options.policy, binding.engineHash, binding.difficulty, map.plugins)) return { status: 'unsupported', code: 'configuration-not-reviewed' };
    if (map.plugins.includes('pick-landing-spot')) return { status: 'unsupported', code: 'landing-not-supported' };
    const fixed = (map.state.map as { fixedAIDifficulty?: string }).fixedAIDifficulty;
    if (fixed && fixed !== binding.difficulty) return { status: 'unsupported', code: 'fixed-difficulty-mismatch' };
    return { binding: structuredClone(binding), canonicalMap: map.encoded, decisions: input.decisions.map(parseDecision) };
  } catch (error) {
    return { status: 'invalid', code: error instanceof ContractError ? 'malformed-input' : 'invalid-input' };
  }
}

/** Internal worker entry; production callers use NodeSimulationAdapter's deadline. */
export async function validateInWorker(input: ValidationInput, options: ValidatorOptions): Promise<ValidationResult> {
  const prepared = prepareInput(input, options);
  if ('status' in prepared) return prepared;
  let index = 0;
  try {
    const sources = await loadEngineSources(options.sourceOptions);
    const session = createEngineSession(sources, prepared.canonicalMap, prepared.binding.difficulty, {
      seed: prepared.binding.seed, limits: options.limits, runtimeLevelId: await runtimeLevelId(prepared.binding),
    });
    for (; index < prepared.decisions.length; index++) await applyPlayerDecision(session, prepared.decisions[index]);
    if (session.outcome?.winner === 1) return { status: 'verified', outcome: 'victory', turns: session.outcome.turns, finalStateHash: session.stateHash() };
    return { status: 'non-winning', outcome: session.outcome ? 'defeat' : 'unfinished', turns: session.outcome?.turns ?? session.model.currentPhase.turnNumber };
  } catch (error) {
    if (error instanceof PlayerCommandError) return { status: 'invalid', code: error.code, decisionIndex: index };
    if (error instanceof UnsupportedDecisionError || error instanceof SimulationLimitError) return { status: 'unsupported', code: error.code };
    if (error instanceof ContractError) return { status: 'invalid', code: 'malformed-input', decisionIndex: index };
    // Unexpected engine/IO errors are never reclassified as cheating or success.
    return { status: 'error', code: 'engine-failure', retryable: false };
  }
}

export class NodeSimulationAdapter implements SimulationAdapter {
  private options: ValidatorOptions;
  constructor(options: ValidatorOptions) {
    this.options = structuredClone(options);
    const timeout = options.timeoutMs ?? DEFAULT_VALIDATOR_RESOURCES.timeoutMs;
    const memory = options.memoryMb ?? DEFAULT_VALIDATOR_RESOURCES.memoryMb;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000 ||
        !Number.isSafeInteger(memory) || memory < 64 || memory > 2048) throw new Error('Invalid validator resource limits');
  }
  async validate(input: ValidationInput): Promise<ValidationResult> {
    const prepared = prepareInput(input, this.options);
    if ('status' in prepared) return prepared;
    // Worker deadlines can interrupt synchronous engine code, unlike Promise.race
    // around an in-process simulation. https://nodejs.org/api/worker_threads.html
    return new Promise(resolve => {
      let worker: Worker;
      try {
        worker = new Worker(new URL(import.meta.url), {
          workerData: { kind: 'konkr-validation-v1', input: prepared, options: this.options },
          resourceLimits: { maxOldGenerationSizeMb: this.options.memoryMb ?? DEFAULT_VALIDATOR_RESOURCES.memoryMb },
          stdout: true, stderr: true,
        });
      } catch { resolve({ status: 'error', code: 'worker-start-failure', retryable: true }); return; }
      worker.stdout.resume(); worker.stderr.resume();
      let complete = false;
      const finish = (result: ValidationResult) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        void worker.terminate().then(() => resolve(result), () => resolve(result));
      };
      const timer = setTimeout(() => finish({ status: 'error', code: 'simulation-timeout', retryable: true }), this.options.timeoutMs ?? DEFAULT_VALIDATOR_RESOURCES.timeoutMs);
      worker.once('message', (result: ValidationResult) => finish(result));
      worker.once('error', () => finish({ status: 'error', code: 'worker-failure', retryable: true }));
      worker.once('exit', () => finish({ status: 'error', code: 'worker-exited', retryable: true }));
    });
  }
}

if (!isMainThread && workerData?.kind === 'konkr-validation-v1') {
  const result = await validateInWorker(workerData.input, workerData.options);
  parentPort?.postMessage(result);
}
