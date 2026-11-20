// Ambient names for scripts/check-doc-samples.mjs (not part of the build or the package).
//
// Doc samples are fragments: most of them use `app`, `req`, `res` and a few other names
// without declaring them. The names below get their real framework types so that member
// access on them is checked. Names exported by the package root are NOT declared here: the
// checker auto-imports those per sample. Everything else is left undeclared on purpose
// (TS2304 is treated as fragment noise and the name is `any`).
//
// '@morojs/moro' is mapped to src/index.ts by the checker.
import type {
  Moro,
  HttpRequest,
  HttpResponse,
  ObjectPoolManager,
  WorkerManager,
  CircuitBreaker,
} from '@morojs/moro';
import type { QueueManager } from '../src/core/queue/index.js';

type BasicContainer = ReturnType<Moro['getContainer']>;
type EnhancedContainer = ReturnType<BasicContainer['getEnhanced']>;

declare global {
  const app: Moro;
  const req: HttpRequest;
  const res: HttpResponse;
  const next: () => void;
  const poolManager: ObjectPoolManager;
  const workers: WorkerManager;
  const workerManager: WorkerManager;
  // Docs call both the basic Container (app.getContainer()) and the enhanced one
  // (app.getContainer().getEnhanced()) `container`; accept either API.
  const container: Omit<BasicContainer, 'register' | 'resolve' | 'has'> &
    Omit<EnhancedContainer, 'register' | 'resolve'> & {
      register<T = any>(name: string): ReturnType<EnhancedContainer['register']>;
      register<T>(
        name: string,
        factory: () => T,
        lifetime?: Parameters<BasicContainer['register']>[2]
      ): void;
      resolve<T = any>(
        name: string,
        optionsOrContext?: Parameters<EnhancedContainer['resolve']>[1]
      ): any;
    };
  const enhanced: EnhancedContainer;
  // QueueManager is not exported from the package root; typed here from the internal
  // module so method names on it are still checked.
  const queueManager: QueueManager;
  const breaker: CircuitBreaker;
}
export {};
