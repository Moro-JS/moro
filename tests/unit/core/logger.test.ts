// MoroLogger behavior: level filtering, child() context propagation, filter-based
// redaction, and flush()/flushBuffer() safety. Output is captured by registering
// a custom LogOutput (the logger's public extension point) and removing the
// default console output so nothing leaks to stdout.
import { MoroLogger } from '../../../src/core/logger/logger.js';
import { sanitizeFilter } from '../../../src/core/logger/filters.js';

interface Snapshot {
  level: string;
  message: string;
  context?: string;
  metadata?: Record<string, any>;
}

// Registers a capturing output and silences the default console output.
// Returns the array the entries are copied into (entries are pooled/reused by the
// logger, so each is snapshotted at write time).
function captureInto(logger: MoroLogger): Snapshot[] {
  const captured: Snapshot[] = [];
  logger.addOutput({
    name: 'capture',
    write: (e: any) => {
      captured.push({
        level: e.level,
        message: e.message,
        context: e.context,
        metadata: e.metadata ? { ...e.metadata } : e.metadata,
      });
    },
  });
  logger.removeOutput('console');
  return captured;
}

describe('MoroLogger', () => {
  describe('level filtering', () => {
    it('suppresses messages below the configured level and emits at/above it', () => {
      const logger = new MoroLogger({ level: 'warn', enableColors: false });
      const captured = captureInto(logger);
      try {
        logger.debug('dbg', 'C', { marker: 1 }); // below -> suppressed
        logger.info('inf', 'C', { marker: 1 }); // below -> suppressed
        logger.warn('wrn', 'C', { marker: 1 }); // at level -> emitted
        logger.error('err', 'C', { marker: 1 }); // above -> emitted
        expect(captured.map(e => e.level)).toEqual(['warn', 'error']);
        expect(captured.map(e => e.message)).toEqual(['wrn', 'err']);
      } finally {
        logger.destroy();
      }
    });

    it('honors setLevel() changes at runtime', () => {
      const logger = new MoroLogger({ level: 'debug', enableColors: false });
      const captured = captureInto(logger);
      try {
        logger.info('a', 'C', { m: 1 }); // emitted at debug level
        logger.setLevel('error');
        logger.info('b', 'C', { m: 1 }); // now suppressed
        logger.warn('c', 'C', { m: 1 }); // suppressed
        logger.error('d', 'C', { m: 1 }); // emitted
        expect(captured.map(e => e.level)).toEqual(['info', 'error']);
      } finally {
        logger.destroy();
      }
    });
  });

  describe('child() context propagation', () => {
    it('prefixes the context and merges parent + child metadata', () => {
      const parent = new MoroLogger({ level: 'info', enableColors: false });
      const captured = captureInto(parent);
      try {
        const child = parent.child('Auth', { requestId: 'r1' });
        child.info('login', 'Handler', { user: 'bob' });
        expect(captured).toHaveLength(1);
        expect(captured[0].context).toBe('Auth:Handler');
        expect(captured[0].metadata).toMatchObject({ requestId: 'r1', user: 'bob' });
      } finally {
        parent.destroy();
      }
    });

    it('nests context prefixes across grandchildren', () => {
      const parent = new MoroLogger({ level: 'info', enableColors: false });
      const captured = captureInto(parent);
      try {
        const grandchild = parent.child('A').child('B') as MoroLogger;
        grandchild.info('x', 'C', { m: 1 });
        expect(captured[0].context).toBe('A:B:C');
      } finally {
        parent.destroy();
      }
    });

    it('propagates setLevel() from parent to previously-created children', () => {
      const parent = new MoroLogger({ level: 'debug', enableColors: false });
      const captured = captureInto(parent);
      try {
        const child = parent.child('Ctx', { k: 1 });
        parent.setLevel('error');
        child.info('suppressed'); // below new level -> dropped
        child.error('kept'); // at/above -> emitted
        expect(captured.map(e => e.level)).toEqual(['error']);
      } finally {
        parent.destroy();
      }
    });
  });

  describe('sensitive-field redaction (sanitizeFilter)', () => {
    it('redacts configured keys on the full-log path', () => {
      const logger = new MoroLogger({ level: 'info', enableColors: false });
      logger.addFilter(sanitizeFilter(['password', 'token']));
      const captured = captureInto(logger);
      try {
        // A child carries the sensitive value in context metadata; logging without
        // explicit call metadata routes through fullLog(), where filters run.
        const child = logger.child('Ctx', { password: 'hunter2', keep: 'ok' });
        child.info('doing work');
        expect(captured).toHaveLength(1);
        expect(captured[0].metadata?.password).toBe('[REDACTED]');
        expect(captured[0].metadata?.keep).toBe('ok');
      } finally {
        logger.destroy();
      }
    });

    it('redacts sensitive keys passed as explicit call metadata', () => {
      // Regression guard: metadata-bearing logs must still run filters. Previously
      // they took a fast path (complexLog) that skipped filters, so a sensitive
      // value passed as call metadata was logged unredacted. log() now routes to
      // fullLog whenever filters (or metrics) are configured.
      const logger = new MoroLogger({ level: 'info', enableColors: false });
      logger.addFilter(sanitizeFilter(['password']));
      const captured = captureInto(logger);
      try {
        logger.info('login', 'Ctx', { password: 'hunter2', user: 'bob' });
        expect(captured).toHaveLength(1);
        expect(captured[0].metadata?.password).toBe('[REDACTED]');
        expect(captured[0].metadata?.user).toBe('bob');
      } finally {
        logger.destroy();
      }
    });
  });

  describe('flush() / flushBuffer() safety', () => {
    it('flushes buffered output and is idempotent to call repeatedly', () => {
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const logger = new MoroLogger({ level: 'info', enableColors: false });
      try {
        logger.info('buffered-line'); // simple log -> buffered via output()
        logger.flush(); // drains the buffer to stdout
        expect(writeSpy).toHaveBeenCalled();
        // Repeat calls with an empty buffer must be safe no-ops.
        expect(() => {
          logger.flush();
          logger.flushBuffer();
          logger.flushBuffer();
        }).not.toThrow();
      } finally {
        logger.destroy();
        writeSpy.mockRestore();
      }
    });

    it('becomes a no-op after destroy()', () => {
      const logger = new MoroLogger({ level: 'info', enableColors: false });
      const captured = captureInto(logger);
      logger.destroy();
      expect(() => logger.info('after destroy', 'C', { m: 1 })).not.toThrow();
      expect(captured).toHaveLength(0);
    });
  });
});
