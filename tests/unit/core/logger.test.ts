// MoroLogger behavior: level filtering, child() context propagation, filter-based
// redaction, and flush()/flushBuffer() safety. Output is captured by registering
// a custom LogOutput (the logger's public extension point) and removing the
// default console output so nothing leaks to stdout.
//
// Further down: the built-in `redact` option (on wherever the console prints
// metadata), control characters written as visible escapes in the pretty and
// compact formats, messages without metadata reaching the configured format,
// outputs and filters, and what the json format writes for dates and errors.
// Those read the console output itself, through a spy on stdout and stderr.
//
// sanitizeFilter itself: redaction is recursive and case-insensitive over
// metadata keys, works on a copy of the caller's metadata, and rewrites
// credentials written into the message text without touching unrelated words.
import {
  MoroLogger,
  configureGlobalLogger,
  createFrameworkLogger,
  logger as globalLogger,
} from '../../../src/core/logger/logger.js';
import { sanitizeFilter } from '../../../src/core/logger/filters.js';
import {
  createQueryRedactor,
  createUrlQueryRedactor,
} from '../../../src/core/logger/query-redaction.js';
import type { LogEntry } from '../../../src/types/logger.js';

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

    it('writes each buffered line once and nothing when the buffer is empty', () => {
      // flush() runs on 'beforeExit'. In a worker thread stdout and stderr
      // are message ports to the main thread, so a write there, even of an
      // empty string, is new asynchronous work: 'beforeExit' fires again and
      // the thread never exits.
      const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const logger = new MoroLogger({ level: 'info', enableColors: false });
      try {
        logger.info('one buffered line');
        logger.flush();
        expect(out.mock.calls.map(call => String(call[0]))).toEqual([
          expect.stringContaining('one buffered line'),
        ]);
        expect(err).not.toHaveBeenCalled();

        out.mockClear();
        logger.flush();
        expect(out).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
      } finally {
        logger.destroy();
        out.mockRestore();
        err.mockRestore();
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

// Runs one entry through the filter and returns what a log output would see.
function sanitize(
  message: string,
  metadata?: Record<string, any>,
  filter = sanitizeFilter()
): { message: string; metadata: Record<string, any> | undefined; kept: boolean } {
  const entry: LogEntry = { timestamp: new Date(), level: 'info', message };
  if (metadata !== undefined) entry.metadata = metadata;
  const kept = filter.filter(entry);
  return { message: entry.message, metadata: entry.metadata, kept };
}

describe('sanitizeFilter', () => {
  describe('metadata keys', () => {
    it('redacts sensitive keys at any depth, in any casing', () => {
      const { metadata, kept } = sanitize('request', {
        authorization: 'Bearer AUTH-1',
        cookie: 'sid=COOKIE-2',
        'Set-Cookie': 'sid=SETCOOKIE-3',
        apiKey: 'APIKEY-4',
        'x-api-key': 'APIKEY-5',
        api_key: 'APIKEY-6',
        accessToken: 'TOKEN-7',
        Password: 'PASS-8',
        clientSecret: 'SECRET-9',
        keyPassphrase: 'PHRASE-10',
        user: { name: 'bob', password: 'PASS-11' },
        headers: { Authorization: 'Bearer AUTH-12', Cookie: 'sid=COOKIE-13', accept: '*/*' },
        items: [{ refreshToken: 'TOKEN-14', id: 1 }, 'plain'],
      });

      expect(kept).toBe(true);
      const serialized = JSON.stringify(metadata);
      for (let n = 1; n <= 14; n++) {
        expect(serialized).not.toMatch(new RegExp(`-${n}"`));
      }
      expect(metadata).toEqual({
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'Set-Cookie': '[REDACTED]',
        apiKey: '[REDACTED]',
        'x-api-key': '[REDACTED]',
        api_key: '[REDACTED]',
        accessToken: '[REDACTED]',
        Password: '[REDACTED]',
        clientSecret: '[REDACTED]',
        keyPassphrase: '[REDACTED]',
        user: { name: 'bob', password: '[REDACTED]' },
        headers: { Authorization: '[REDACTED]', Cookie: '[REDACTED]', accept: '*/*' },
        items: [{ refreshToken: '[REDACTED]', id: 1 }, 'plain'],
      });
    });

    it('redacts the default top-level keys and leaves the rest alone', () => {
      const { metadata } = sanitize('x', {
        password: 'p',
        token: 't',
        key: 'k',
        secret: 's',
        monkey: 'banana',
        cacheKey: 'users:1',
        userId: 7,
      });
      expect(metadata).toEqual({
        password: '[REDACTED]',
        token: '[REDACTED]',
        key: '[REDACTED]',
        secret: '[REDACTED]',
        monkey: 'banana',
        cacheKey: 'users:1',
        userId: 7,
      });
    });

    it('honours extra key names passed by the caller', () => {
      const { metadata } = sanitize(
        'x',
        { ssn: '123-45-6789', nested: { SSN: '987-65-4321' }, password: 'p', name: 'bob' },
        sanitizeFilter(['ssn'])
      );
      expect(metadata).toEqual({
        ssn: '[REDACTED]',
        nested: { SSN: '[REDACTED]' },
        password: '[REDACTED]',
        name: 'bob',
      });
    });

    it("does not mutate the caller's metadata, at any depth", () => {
      const original = {
        password: 'p',
        user: { token: 't', profile: { secret: 's' } },
        list: [{ apiKey: 'k' }],
      };
      const snapshot = JSON.parse(JSON.stringify(original));
      const nestedUser = original.user;

      const { metadata } = sanitize('x', original);

      expect(original).toEqual(snapshot);
      expect(original.user).toBe(nestedUser);
      expect(metadata).not.toBe(original);
      expect(metadata?.user).not.toBe(original.user);
      expect(metadata?.user.profile.secret).toBe('[REDACTED]');
    });

    it('handles circular references', () => {
      const node: Record<string, any> = { name: 'a', token: 'TOKEN-1' };
      node.self = node;
      node.child = { parent: node, password: 'PASS-2' };

      const { metadata } = sanitize('x', node);

      expect(metadata?.token).toBe('[REDACTED]');
      expect(metadata?.child.password).toBe('[REDACTED]');
      expect(metadata?.self).toBe(metadata);
      expect(metadata?.child.parent).toBe(metadata);
      expect(node.token).toBe('TOKEN-1');
    });

    it('stops at a depth limit instead of passing deep values through', () => {
      let deep: Record<string, any> = { password: 'DEEP-SECRET' };
      for (let i = 0; i < 20; i++) deep = { next: deep };

      const { metadata } = sanitize('x', deep);
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain('DEEP-SECRET');
      expect(serialized).toContain('[MaxDepth]');
    });

    it('leaves non-plain values (dates, errors, buffers) as they are', () => {
      const when = new Date();
      const error = new Error('boom');
      const buffer = Buffer.from('abc');
      const { metadata } = sanitize('x', { when, error, buffer, empty: null, zero: 0 });
      expect(metadata?.when).toBe(when);
      expect(metadata?.error).toBe(error);
      expect(metadata?.buffer).toBe(buffer);
      expect(metadata?.empty).toBeNull();
      expect(metadata?.zero).toBe(0);
    });
  });

  describe('message text', () => {
    it('does not rewrite unrelated words that contain "key"', () => {
      for (const message of [
        'monkey: banana',
        'turkey=dinner hockey: night',
        'keyboard: qwerty',
        'GET http://localhost:3000/users?page=2 took 12:30:45',
      ]) {
        expect(sanitize(message).message).toBe(message);
      }
    });

    it('redacts key=value, key: value and JSON forms of sensitive names', () => {
      expect(sanitize('login password=hunter2 ok').message).toBe('login password=[REDACTED] ok');
      expect(sanitize('token: abc123').message).toBe('token: [REDACTED]');
      expect(sanitize('body {"password":"hunter2"}').message).toBe(
        'body {"password":"[REDACTED]"}'
      );
      expect(sanitize('key=abc secret=def').message).toBe('key=[REDACTED] secret=[REDACTED]');
      expect(sanitize('apiKey=abc api_key: def').message).toBe(
        'apiKey=[REDACTED] api_key: [REDACTED]'
      );
      expect(sanitize('privateKey=abc accessToken=def').message).toBe(
        'privateKey=[REDACTED] accessToken=[REDACTED]'
      );
    });

    it('redacts credential headers written into the message', () => {
      expect(sanitize('upstream said Authorization: Bearer abc.def.ghi').message).toBe(
        'upstream said Authorization: [REDACTED]'
      );
      expect(sanitize('cookie: sid=abc; theme=dark').message).toBe('cookie: [REDACTED]');
      expect(
        sanitize('headers {"authorization":"Basic dXNlcjpwYXNz","accept":"*/*"}').message
      ).toBe('headers {"authorization":"[REDACTED]","accept":"*/*"}');
    });

    it('never drops the entry', () => {
      expect(sanitize('anything', { password: 'p' }).kept).toBe(true);
      expect(sanitize('anything').kept).toBe(true);
    });
  });
});

// What the logger wrote to the console (stdout and stderr), one string per line.
// The logger buffers its lines, so it is flushed before they are read.
function consoleLines(
  options: ConstructorParameters<typeof MoroLogger>[0],
  run: (logger: MoroLogger) => void
): string[] {
  const chunks: string[] = [];
  const collect = (chunk: any) => {
    chunks.push(String(chunk));
    return true;
  };
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(collect);
  const err = jest.spyOn(process.stderr, 'write').mockImplementation(collect);
  const logger = new MoroLogger({ level: 'debug', enableColors: false, ...options });
  try {
    run(logger);
    logger.flush();
  } finally {
    logger.destroy();
    out.mockRestore();
    err.mockRestore();
  }
  return chunks.join('').split('\n').slice(0, -1);
}

describe('built-in redaction (redact option)', () => {
  it('masks sensitive keys in JSON output, by default', () => {
    const lines = consoleLines({ format: 'json' }, logger => {
      logger.info('login', 'Auth', {
        user: 'ada',
        password: 'hunter2',
        headers: { Authorization: 'Bearer abc.def', Cookie: 'sid=1', accept: '*/*' },
        oauth: { provider: 'github', clientSecret: 's3cr3t', 'x-api-key': 'k-1' },
        // deeper than the console prints
        providers: [{ settings: { privateKey: 'pk-1' } }],
      });
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).metadata).toMatchObject({
      user: 'ada',
      password: '[REDACTED]',
      headers: { Authorization: '[REDACTED]', Cookie: '[REDACTED]', accept: '*/*' },
      oauth: { provider: 'github', clientSecret: '[REDACTED]', 'x-api-key': '[REDACTED]' },
    });
    expect(lines[0]).not.toMatch(/hunter2|abc\.def|sid=1|s3cr3t|k-1|pk-1/);
  });

  it('masks at any depth in what outputs receive', () => {
    const logger = new MoroLogger({ level: 'info', format: 'json', enableColors: false });
    const captured = captureInto(logger);
    try {
      logger.info('m', 'C', {
        a: [{ b: { c: [{ d: { Password: 'p', refresh_token: 'r', keep: 'k' } }] } }],
      });
      expect(captured[0]?.metadata).toEqual({
        a: [
          { b: { c: [{ d: { Password: '[REDACTED]', refresh_token: '[REDACTED]', keep: 'k' } }] } },
        ],
      });
    } finally {
      logger.destroy();
    }
  });

  it('masks the metadata of a child logger and of its calls', () => {
    const lines = consoleLines({ format: 'json' }, logger => {
      const child = logger.child('Payments', { apiKey: 'sk_live_1', region: 'eu' });
      child.info('charge');
      child.info('charge', 'Stripe', { token: 'tok_1', amount: 5 });
    });

    expect(JSON.parse(lines[0] as string).metadata).toEqual({
      apiKey: '[REDACTED]',
      region: 'eu',
    });
    expect(JSON.parse(lines[1] as string).metadata).toEqual({
      apiKey: '[REDACTED]',
      region: 'eu',
      token: '[REDACTED]',
      amount: 5,
    });
  });

  it('masks fields of class instances when they are printed', () => {
    class User {
      id = 7;
      passwordHash = '$2b$10$abcdefghijklmnopqrstuv';
      profile = { apiToken: 'tok_live' };
    }
    const lines = consoleLines({ format: 'json' }, logger => {
      logger.info('created', 'Users', { user: new User() });
    });

    expect(JSON.parse(lines[0] as string).metadata.user).toEqual({
      id: 7,
      passwordHash: '[REDACTED]',
      profile: { apiToken: '[REDACTED]' },
    });
  });

  it('leaves numbers and booleans under a name that only contains a sensitive word', () => {
    const lines = consoleLines({ format: 'json' }, logger => {
      logger.info('usage', 'LLM', {
        promptTokens: 512,
        hasPassword: true,
        token: 123456,
        accessToken: 'at_1',
        secret: '',
      });
    });

    expect(JSON.parse(lines[0] as string).metadata).toEqual({
      promptTokens: 512,
      hasPassword: true,
      token: '[REDACTED]',
      accessToken: '[REDACTED]',
      secret: '',
    });
  });

  it('hands outputs and filters a redacted copy, never the caller object', () => {
    const logger = new MoroLogger({ level: 'info', format: 'json', enableColors: false });
    const captured = captureInto(logger);
    const seenByFilter: any[] = [];
    logger.addFilter({
      name: 'spy',
      filter: entry => {
        seenByFilter.push(entry.metadata);
        return true;
      },
    });
    const credentials = { secret: 'shh' };
    const metadata: Record<string, any> = {
      password: 'p',
      nested: credentials,
      again: credentials,
    };
    metadata.self = metadata;
    try {
      logger.info('m', 'C', metadata);

      expect(captured[0]?.metadata).toMatchObject({
        password: '[REDACTED]',
        nested: { secret: '[REDACTED]' },
        again: { secret: '[REDACTED]' },
      });
      // a circular reference points at the copy, not back at the original
      expect(captured[0]?.metadata?.self.password).toBe('[REDACTED]');
      expect(seenByFilter[0].password).toBe('[REDACTED]');
      expect(metadata.password).toBe('p');
      expect(credentials.secret).toBe('shh');
    } finally {
      logger.destroy();
    }
  });

  it('stops copying at a depth limit', () => {
    let deep: Record<string, any> = { password: 'bottom' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const logger = new MoroLogger({ level: 'info', format: 'json', enableColors: false });
    const captured = captureInto(logger);
    try {
      logger.info('m', 'C', { deep });
      expect(JSON.stringify(captured[0]?.metadata)).toContain('[MaxDepth]');
      expect(JSON.stringify(captured[0]?.metadata)).not.toContain('bottom');
    } finally {
      logger.destroy();
    }
  });

  it('is on in the pretty format when the metadata tail is printed', () => {
    const lines = consoleLines({ format: 'pretty', enableMetadata: true }, logger => {
      logger.info('login', 'Auth', { user: 'ada', password: 'hunter2' });
    });

    expect(lines[0]).toContain('{"user":"ada","password":"[REDACTED]"}');
  });

  it('redact: true masks in every format, an array adds key names, false turns it off', () => {
    const on = new MoroLogger({ level: 'info', enableColors: false, redact: true });
    const onCaptured = captureInto(on);
    const extra = new MoroLogger({ level: 'info', enableColors: false, redact: ['pin', 'SSN'] });
    const extraCaptured = captureInto(extra);
    try {
      on.info('m', 'C', { password: 'p', pin: 1234 });
      extra.info('m', 'C', { password: 'p', pin: 1234, ssn: '078-05-1120' });
      expect(onCaptured[0]?.metadata).toEqual({ password: '[REDACTED]', pin: 1234 });
      expect(extraCaptured[0]?.metadata).toEqual({
        password: '[REDACTED]',
        pin: '[REDACTED]',
        ssn: '[REDACTED]',
      });
    } finally {
      on.destroy();
      extra.destroy();
    }

    const lines = consoleLines({ format: 'json', redact: false }, logger => {
      logger.info('m', 'C', { password: 'p' });
    });
    expect(JSON.parse(lines[0] as string).metadata).toEqual({ password: 'p' });
    // ...and the JSON line is otherwise the same as with redaction on
    expect(JSON.parse(lines[0] as string).timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe('control characters in pretty and compact output', () => {
  const ESC = String.fromCharCode(27);
  const forged = `user=x\r\n2026-01-01 00:00:00 INFO  [Auth] admin signed in ${ESC}[2J${ESC}[31m\b\u0007`;
  const escaped =
    'user=x\\r\\n2026-01-01 00:00:00 INFO  [Auth] admin signed in \\x1b[2J\\x1b[31m\\x08\\x07';

  it('writes one line with visible escapes in the pretty format', () => {
    const lines = consoleLines({ enableTimestamp: false }, logger => {
      logger.info(forged); // message only
      logger.info(forged, 'Ctx\nINFO'); // message and context
      logger.child('Http', { requestId: 'r1' }).warn(forged, 'Req\r'); // child logger
    });

    expect(lines).toEqual([
      `INFO  ${escaped}`,
      `INFO  [Ctx\\nINFO] ${escaped}`,
      `WARN  [Http:Req\\r] ${escaped}`,
    ]);
  });

  it('writes one line with visible escapes in the compact format', () => {
    const lines = consoleLines({ format: 'compact' }, logger => {
      logger.info(forged);
      logger.child('Http', { requestId: 'r1' }).info(forged, 'Req\n');
    });

    expect(lines).toEqual([`INFO  ${escaped}`, `INFO  [Http:Req\\n] ${escaped}`]);
  });

  it('escapes the C1 controls and Unicode line separators, and leaves tabs', () => {
    const csi = String.fromCharCode(0x9b);
    const lineSeparator = String.fromCharCode(0x2028);
    const lines = consoleLines({ enableTimestamp: false }, logger => {
      logger.info(`a\tb${csi}2Jc${lineSeparator}d`);
    });

    expect(lines).toEqual(['INFO  a\tb\\x9b2Jc\\u2028d']);
  });

  it('keeps the frames of a stack trace on their own lines and escapes the rest', () => {
    const error = new Error(`boom\n2026-01-01 00:00:00 INFO  forged ${ESC}[2J`);
    error.stack = `Error: ${error.message}\n    at handler (/app/routes.js:1:2)\n    at next (/app/chain.js:3:4)`;
    const lines = consoleLines({ enableTimestamp: false }, logger => {
      logger.error(error, 'App');
    });

    expect(lines).toEqual([
      'ERROR [App] boom\\n2026-01-01 00:00:00 INFO  forged \\x1b[2J',
      'Error: boom\\n2026-01-01 00:00:00 INFO  forged \\x1b[2J',
      '    at handler (/app/routes.js:1:2)',
      '    at next (/app/chain.js:3:4)',
    ]);
  });

  it('escapes what was logged, not the colours the logger adds itself', () => {
    const lines = consoleLines({ enableTimestamp: false, enableColors: true }, logger => {
      logger.info('GET /users/42 200 3ms', 'Http');
      logger.info(`GET /${ESC}[2J`, 'Http');
    });

    const prefix = `${ESC}[32m${ESC}[1mINFO ${ESC}[0m ${ESC}[34m[Http]${ESC}[0m`;
    expect(lines).toEqual([`${prefix} GET /users/42 200 3ms`, `${prefix} GET /\\x1b[2J`]);
  });

  it('escapeControlChars: false writes messages as they were passed', () => {
    const lines = consoleLines({ enableTimestamp: false, escapeControlChars: false }, logger => {
      logger.info('first\nsecond');
    });
    expect(lines).toEqual(['INFO  first', 'second']);

    // the default, for contrast
    expect(
      consoleLines({ enableTimestamp: false }, logger => logger.info('first\nsecond'))
    ).toEqual(['INFO  first\\nsecond']);
  });
});

describe('messages logged without metadata', () => {
  it('are written as JSON lines when the format is json', () => {
    const lines = consoleLines({ format: 'json' }, logger => {
      logger.info('server started');
      logger.warn('slow request', 'Http');
    });

    expect(lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 'info', message: 'server started' }),
      expect.objectContaining({ level: 'warn', message: 'slow request', context: 'Http' }),
    ]);
  });

  it('are written in the compact format when the format is compact', () => {
    const lines = consoleLines({ format: 'compact' }, logger => {
      logger.info('server started');
      logger.warn('slow request', 'Http');
    });

    expect(lines).toEqual(['INFO  server started', 'WARN  [Http] slow request']);
  });

  it('reach custom outputs, and only those once the console output is removed', () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new MoroLogger({ level: 'info', enableColors: false });
    const captured = captureInto(logger);
    try {
      logger.info('server started');
      logger.info('slow request', 'Http');
      logger.flush();

      expect(captured.map(entry => [entry.message, entry.context])).toEqual([
        ['server started', undefined],
        ['slow request', 'Http'],
      ]);
      expect(out).not.toHaveBeenCalled();
    } finally {
      logger.destroy();
      out.mockRestore();
    }
  });

  it('pass through the filters', () => {
    const lines = consoleLines({ enableTimestamp: false }, logger => {
      logger.addFilter({ name: 'no-noise', filter: entry => !entry.message.includes('noise') });
      logger.addFilter(sanitizeFilter());
      logger.info('noise');
      logger.info('login password=hunter2');
    });

    expect(lines).toEqual(['INFO  login password=[REDACTED]']);
  });

  it('are kept in the history, each entry as it was logged', () => {
    const logger = new MoroLogger({ level: 'info', enableColors: false, enableMetrics: true });
    captureInto(logger);
    try {
      logger.info('first');
      logger.warn('second', 'B', { n: 2 });
      logger.info('third', 'C');
      expect(logger.getHistory().map(entry => [entry.level, entry.message, entry.context])).toEqual(
        [
          ['info', 'first', undefined],
          ['warn', 'second', 'B'],
          ['info', 'third', 'C'],
        ]
      );
      expect(logger.getHistory()[1]?.metadata).toEqual({ n: 2 });
    } finally {
      logger.destroy();
    }
  });

  it('are counted when metrics are enabled', () => {
    const logger = new MoroLogger({ level: 'info', enableColors: false, enableMetrics: true });
    captureInto(logger);
    try {
      logger.info('one');
      logger.info('two', 'Ctx');
      expect(logger.getMetrics().totalLogs).toBe(2);
    } finally {
      logger.destroy();
    }
  });
});

describe('JSON output', () => {
  it('writes the timestamp, dates, errors and bigints as values a JSON parser gets back', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const before = Date.now();
    const lines = consoleLines({ format: 'json' }, logger => {
      logger.info('job finished', 'Jobs', {
        startedAt: new Date('2026-03-04T05:06:07.008Z'),
        invalid: new Date(NaN),
        error: cause,
        rows: 12345678901234567890n,
      });
    });
    const after = Date.now();

    const entry = JSON.parse(lines[0] as string);
    expect(entry.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(entry.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(entry.timestamp)).toBeLessThanOrEqual(after);
    expect(entry.metadata.startedAt).toBe('2026-03-04T05:06:07.008Z');
    expect(entry.metadata.invalid).toBeNull();
    expect(entry.metadata.error).toMatchObject({
      name: 'Error',
      message: 'connect ECONNREFUSED',
      code: 'ECONNREFUSED',
    });
    expect(entry.metadata.error.stack).toContain('connect ECONNREFUSED');
    expect(entry.metadata.rows).toBe('12345678901234567890');
  });

  it('formats timestamps exactly as Date.prototype.toISOString() does', () => {
    const samples = [0, 7, 99, 1000, 1767225599999, 1767225600000, 253402300799999];
    const lines = consoleLines({ format: 'json' }, logger => {
      for (const time of samples) logger.info('t', 'C', { at: new Date(time) });
      logger.info('t', 'C', { at: new Date(-1), far: new Date(8.64e15) });
    });

    expect(lines.slice(0, samples.length).map(line => JSON.parse(line).metadata.at)).toEqual(
      samples.map(time => new Date(time).toISOString())
    );
    expect(JSON.parse(lines[samples.length] as string).metadata).toEqual({
      at: new Date(-1).toISOString(),
      far: new Date(8.64e15).toISOString(),
    });
  });
});

describe('query-string redaction', () => {
  const redact = createQueryRedactor();

  it('replaces the values of the default parameter names and nothing else', () => {
    expect(redact('token=abc&page=2&API_KEY=k1&sig=s&q=token')).toBe(
      'token=REDACTED&page=2&API_KEY=REDACTED&sig=REDACTED&q=token'
    );
    expect(redact('a=1&code=4%2F0AX&b=%20x&password=p%26w')).toBe(
      'a=1&code=REDACTED&b=%20x&password=REDACTED'
    );
  });

  it('returns a query with nothing to redact as the same string', () => {
    for (const query of ['', 'page=2&sort=name', 'token', 'token=', 'a&&b=', '=x&tokens=1']) {
      expect(redact(query)).toBe(query);
    }
  });

  it('matches percent-encoded and bracketed names', () => {
    expect(redact('acc%65ss_token=a&user%5Bpassword%5D=p&token[]=t1&token[]=t2&x[y]=1')).toBe(
      'acc%65ss_token=REDACTED&user%5Bpassword%5D=REDACTED&token[]=REDACTED&token[]=REDACTED&x[y]=1'
    );
    // a malformed escape is compared as written, and never throws
    expect(redact('%E0%A4%A=1&token=t')).toBe('%E0%A4%A=1&token=REDACTED');
  });

  it('takes a list of names in place of the default one', () => {
    const custom = createQueryRedactor(['Invite']);
    expect(custom('invite=abc&token=t')).toBe('invite=REDACTED&token=t');
    expect(createQueryRedactor([])('token=t')).toBe('token=t');
  });

  it('rewrites only the query part of a URL', () => {
    const redactUrl = createUrlQueryRedactor();
    expect(redactUrl('/cb?code=abc&state=s#token=frag')).toBe(
      '/cb?code=REDACTED&state=s#token=frag'
    );
    expect(redactUrl('https://app.example/cb?token=t')).toBe(
      'https://app.example/cb?token=REDACTED'
    );
    expect(redactUrl('/token/abc')).toBe('/token/abc');
    expect(redactUrl('/cb#x?token=t')).toBe('/cb#x?token=REDACTED');
  });

  it('handles a long query of bare names in one pass', () => {
    const query = 'a&'.repeat(200_000) + 'token=t';
    const started = process.hrtime.bigint();
    expect(redact(query).endsWith('token=REDACTED')).toBe(true);
    // quadratic scanning takes many seconds here; one pass takes milliseconds
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1000);
  });
});

describe('configureGlobalLogger', () => {
  it('applies format and redact to loggers created before the call', () => {
    // Framework loggers are created at import time, long before createApp()
    // configures logging: they must follow the settings applied afterwards.
    const early = createFrameworkLogger('EarlyBird');
    const live = (globalLogger as any).options as Record<string, unknown>;
    const saved = { ...live };
    const savedLevel = globalLogger.getLevel();
    const seen: Array<Record<string, any> | undefined> = [];
    globalLogger.addOutput({
      name: 'configure-capture',
      write: (entry: any) => {
        seen.push(entry.metadata ? { ...entry.metadata } : entry.metadata);
      },
    });
    try {
      configureGlobalLogger({ level: 'info', format: 'json' });
      early.info('one', 'Call', { password: 'p1' });
      configureGlobalLogger({ redact: false });
      early.info('two', 'Call', { password: 'p2' });
      configureGlobalLogger({ format: 'compact', redact: ['pin'] });
      early.info('three', 'Call', { password: 'p3', pin: 1234 });
    } finally {
      globalLogger.removeOutput('configure-capture');
      for (const key of Object.keys(live)) {
        if (!(key in saved)) delete live[key];
      }
      Object.assign(live, saved);
      globalLogger.setLevel(savedLevel);
    }

    expect(seen.map(metadata => metadata?.password)).toEqual(['[REDACTED]', 'p2', '[REDACTED]']);
    expect(seen[2]?.pin).toBe('[REDACTED]');
  });
});
