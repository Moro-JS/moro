// Worker subsystem: pure, thread-free logic only (the task registry and the
// optional-dependency guards). The pool itself is covered in
// worker-pool.test.ts.
import { WORKER_TASKS, workerTasks } from '../../../src/core/workers/worker-manager.js';
import { isPackageAvailable } from '../../../src/core/utilities/package-utils.js';

const jwtAvailable = isPackageAvailable('jsonwebtoken');

describe('workers (pure logic, no thread spawning)', () => {
  describe('WORKER_TASKS registry', () => {
    it('exposes the stable built-in task type identifiers', () => {
      expect(WORKER_TASKS.JWT_VERIFY).toBe('jwt:verify');
      expect(WORKER_TASKS.JWT_SIGN).toBe('jwt:sign');
      expect(WORKER_TASKS.CRYPTO_HASH).toBe('crypto:hash');
      expect(WORKER_TASKS.CRYPTO_ENCRYPT).toBe('crypto:encrypt');
      expect(WORKER_TASKS.CRYPTO_DECRYPT).toBe('crypto:decrypt');
      expect(WORKER_TASKS.DATA_COMPRESS).toBe('data:compress');
      expect(WORKER_TASKS.DATA_DECOMPRESS).toBe('data:decompress');
      expect(WORKER_TASKS.IMAGE_PROCESS).toBe('image:process');
      expect(WORKER_TASKS.HEAVY_COMPUTATION).toBe('computation:heavy');
      expect(WORKER_TASKS.JSON_TRANSFORM).toBe('json:transform');
    });

    it('has unique task type values', () => {
      const values = Object.values(WORKER_TASKS);
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe('optional-dependency guards', () => {
    // These helpers must reject up front WHEN jsonwebtoken is not installed, i.e.
    // before ever constructing a WorkerManager (which would spawn real threads).
    // If jsonwebtoken IS installed, the guard would fall through to a spawning
    // path, so we skip rather than risk spawning a worker.
    const guard = jwtAvailable ? it.skip : it;

    guard('verifyJWT rejects when jsonwebtoken is unavailable', async () => {
      await expect(workerTasks.verifyJWT('token', 'secret')).rejects.toThrow(/jsonwebtoken/);
    });

    guard('signJWT rejects when jsonwebtoken is unavailable', async () => {
      await expect(workerTasks.signJWT({ sub: '1' }, 'secret')).rejects.toThrow(/jsonwebtoken/);
    });
  });
});
