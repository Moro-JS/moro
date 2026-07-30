/**
 * Property-based fuzzing for the parsers MoroJS owns.
 *
 * Zero third-party dependencies means we own query, cookie, multipart and
 * route-pattern parsing outright — there is no upstream library absorbing
 * malformed input on our behalf. These tests throw structured garbage at each
 * parser and assert the invariants that must hold for ANY input:
 *
 *   1. Never throw on untrusted input (a parse must not crash the process).
 *   2. Never pollute Object.prototype (`__proto__`, `constructor`, `prototype`).
 *   3. Terminate promptly - no catastrophic backtracking (ReDoS).
 *   4. Round-trip faithfully: whatever the encoder writes, the parser returns.
 *
 * Note on CR/LF: percent-decoding means a cookie value legitimately CAN contain
 * CRLF, because `res.cookie(name, 'a\nb')` has to survive the round trip.
 * Response splitting is stopped at the header-writing boundary instead, which
 * every backend enforces - see the Set-Cookie re-encoding test below.
 *
 * The generator is seeded and deterministic: a CI failure reproduces locally
 * from the seed printed in the assertion message. Set MORO_FUZZ_SEED to replay
 * a specific run, MORO_FUZZ_RUNS to change iteration count.
 */
import { parseRawQueryString } from '../../src/core/http/utils/query-parser.js';
import { parseCookies, buildCookieString } from '../../src/core/middleware/built-in/cookie/core.js';
import { parseMultipart } from '../../src/core/http/utils/multipart-parser.js';
import { MethodRadixRouter } from '../../src/core/routing/radix-tree.js';

// ===== Deterministic PRNG (mulberry32) =====

const SEED = Number(process.env.MORO_FUZZ_SEED ?? 0x5eed1e);
const RUNS = Number(process.env.MORO_FUZZ_RUNS ?? 2000);

function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fragments chosen to hit known parser failure classes rather than random
 * bytes: prototype-pollution keys, percent-escape edge cases, CRLF injection,
 * quoted-string confusion, and unicode/surrogate boundaries.
 */
const HOSTILE = [
  '__proto__',
  'constructor',
  'prototype',
  '[__proto__]',
  '%5f%5fproto%5f%5f',
  '\r\n',
  '\r\nSet-Cookie: pwned=1',
  '\n',
  '%0d%0a',
  '%',
  '%zz',
  '%e0%a4',
  '%c0%80',
  '=',
  '==',
  '&',
  ';',
  '+',
  '"',
  '\\',
  '\\"',
  ';;;;',
  '\0',
  '\uD800',
  '�',
  '../..',
  '%2e%2e%2f',
  ' ',
  '\t',
  'a'.repeat(64),
  '',
];

function randomHostile(rng: () => number, maxParts = 12): string {
  const n = Math.floor(rng() * maxParts);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += HOSTILE[Math.floor(rng() * HOSTILE.length)];
    if (rng() < 0.4) out += String.fromCharCode(32 + Math.floor(rng() * 95));
  }
  return out;
}

// ===== Invariants =====

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

function expectNoPrototypePollution(input: string) {
  // A polluted prototype shows up on an unrelated fresh object.
  const canary: any = {};
  expect(canary.pwned).toBeUndefined();
  expect(({} as any).polluted).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty('pwned');
  for (const key of PROTO_KEYS) {
    // The parser may store the key as an OWN property (that is safe and
    // intended); what must never happen is the real prototype changing.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  }
  void input;
}

/**
 * Cookie values are percent-decoded, so `%0d%0a` legitimately decodes to CRLF -
 * that is required for `res.cookie(name, 'a\nb')` to round-trip. CRLF is
 * neutralised at the header-writing boundary instead, which every backend
 * enforces (Node throws ERR_INVALID_CHAR, uWS strips via sanitizeHeaderValue,
 * the native engine drops the header). So the parser-level invariant is
 * round-trip fidelity, not CRLF absence.
 */
function expectRoundTrip(value: string) {
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    // Lone surrogates are not encodable by the JS built-in itself - not a
    // parser property, so there is nothing to assert for this input.
    return;
  }
  const parsed = parseCookies(`c=${encoded}`);
  expect(parsed.c).toBe(value);
}

describe('fuzz: query string parser', () => {
  it('never throws, never pollutes the prototype, and decodes deterministically', () => {
    const rng = makeRng(SEED);
    for (let i = 0; i < RUNS; i++) {
      const input = randomHostile(rng);
      let result: Record<string, string>;
      try {
        result = parseRawQueryString(input);
      } catch (err) {
        throw new Error(
          `parseRawQueryString threw on input ${JSON.stringify(input)} ` +
            `(seed=${SEED}, run=${i}): ${(err as Error).message}`
        );
      }
      expect(typeof result).toBe('object');
      expectNoPrototypePollution(input);

      // Parsing is a pure function: same input, same output.
      expect(parseRawQueryString(input)).toEqual(result);
    }
  });

  it('stores __proto__ as an own key instead of reaching the prototype', () => {
    const result = parseRawQueryString('__proto__[pwned]=1&__proto__=2&constructor=3');
    expect(({} as any).pwned).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('pwned');
    // Null-prototype result: the key is data, not a setter.
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it('terminates promptly on pathological input (no catastrophic backtracking)', () => {
    const bombs = [
      '='.repeat(50_000),
      '&'.repeat(50_000),
      `a=${'%'.repeat(50_000)}`,
      `${'%25'.repeat(20_000)}=1`,
      `${'a['.repeat(20_000)}=1`,
      `${'+'.repeat(50_000)}=1`,
    ];
    for (const bomb of bombs) {
      const started = Date.now();
      parseRawQueryString(bomb);
      const elapsed = Date.now() - started;
      if (elapsed >= 1000) {
        throw new Error(`query parse took ${elapsed}ms on a ${bomb.length}-char bomb`);
      }
    }
  });
});

describe('fuzz: cookie parser', () => {
  it('never throws and round-trips any value through encode/decode', () => {
    const rng = makeRng(SEED ^ 0x1111);
    for (let i = 0; i < RUNS; i++) {
      const input = randomHostile(rng);
      let result: Record<string, string>;
      try {
        result = parseCookies(input);
      } catch (err) {
        throw new Error(
          `parseCookies threw on input ${JSON.stringify(input)} ` +
            `(seed=${SEED}, run=${i}): ${(err as Error).message}`
        );
      }
      expect(typeof result).toBe('object');
      expectNoPrototypePollution(input);

      // Anything res.cookie() writes must come back out of parseCookies
      // byte-identical, including control characters and unicode.
      if (input) expectRoundTrip(input);
    }
  });

  it('does not pollute the prototype via a __proto__ cookie name', () => {
    parseCookies('__proto__=pwned; constructor=x; prototype=y');
    expect(({} as any).pwned).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('pwned');
  });

  it('re-encodes control characters when writing Set-Cookie', () => {
    // The output side is where injection is stopped: a value carrying CRLF is
    // percent-encoded back into a single header line.
    const header = buildCookieString('sid', 'a\r\nX-Injected: yes');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('%0D%0A');
  });

  it('terminates promptly on pathological cookie headers', () => {
    const bombs = [
      `${'a'.repeat(100_000)}=1`,
      `${'='.repeat(50_000)}`,
      `${'; '.repeat(50_000)}`,
      `${'a=b; '.repeat(20_000)}`,
      `${'"'.repeat(50_000)}`,
    ];
    for (const bomb of bombs) {
      const started = Date.now();
      parseCookies(bomb);
      const elapsed = Date.now() - started;
      if (elapsed >= 1000) {
        throw new Error(`cookie parse took ${elapsed}ms on a ${bomb.length}-char bomb`);
      }
    }
  });
});

describe('fuzz: route pattern matching', () => {
  it('never throws on hostile paths and never pollutes params', () => {
    const router = new MethodRadixRouter();
    router.addRoute('GET', '/users/:id', () => undefined);
    router.addRoute('GET', '/users/:id/posts/:postId', () => undefined);
    router.addRoute('GET', '/files/*', () => undefined);
    router.addRoute('GET', '/static', () => undefined);

    const rng = makeRng(SEED ^ 0x2222);
    for (let i = 0; i < RUNS; i++) {
      const path = `/${randomHostile(rng, 8).replace(/\0/g, '')}`;
      let result: unknown;
      try {
        result = router.findRoute('GET', path);
      } catch (err) {
        throw new Error(
          `findRoute threw on path ${JSON.stringify(path)} ` +
            `(seed=${SEED}, run=${i}): ${(err as Error).message}`
        );
      }
      expect(result === null || typeof result === 'object').toBe(true);
      expectNoPrototypePollution(path);
    }
  });

  it('terminates promptly on deeply nested and repetitive paths (ReDoS guard)', () => {
    const router = new MethodRadixRouter();
    router.addRoute('GET', '/a/:b/c/:d/e/:f', () => undefined);
    router.addRoute('GET', '/deep/*', () => undefined);

    const bombs = [
      `/${'a/'.repeat(10_000)}`,
      `/deep/${'x'.repeat(100_000)}`,
      `/${'::'.repeat(20_000)}`,
      `/${'%2f'.repeat(20_000)}`,
      `/a/${'b'.repeat(50_000)}/c/d/e/f`,
    ];
    for (const bomb of bombs) {
      const started = Date.now();
      router.findRoute('GET', bomb);
      const elapsed = Date.now() - started;
      if (elapsed >= 1000) {
        throw new Error(`route match took ${elapsed}ms on a ${bomb.length}-char path`);
      }
    }
  });

  it('does not let a __proto__ path segment reach the prototype', () => {
    const router = new MethodRadixRouter();
    router.addRoute('GET', '/users/:id', () => undefined);
    const match = router.findRoute('GET', '/users/__proto__') as { params: Record<string, string> };
    expect(({} as any).id).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('id');
    if (match) expect(match.params.id).toBe('__proto__');
  });
});

describe('fuzz: multipart parser', () => {
  it('never throws unexpectedly on malformed bodies', () => {
    const rng = makeRng(SEED ^ 0x3333);
    for (let i = 0; i < RUNS / 4; i++) {
      const boundary = `----moro${Math.floor(rng() * 1e6)}`;
      const junk = randomHostile(rng, 20);
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${junk}"\r\n\r\n${junk}\r\n--${boundary}--\r\n`,
        'binary'
      );
      const contentType = `multipart/form-data; boundary=${boundary}`;

      try {
        const parsed = parseMultipart(body, contentType);
        expect(parsed).toBeDefined();
        expectNoPrototypePollution(junk);
      } catch (err) {
        // Rejecting malformed input is correct; crashing with a non-Error or a
        // stack overflow is not.
        if (!(err instanceof Error)) {
          throw new Error(`multipart threw a non-Error on run ${i} (seed=${SEED}): ${String(err)}`);
        }
        expect((err as Error).message).not.toMatch(/Maximum call stack/i);
      }
    }
  });

  it('does not pollute the prototype via a __proto__ part name', () => {
    const boundary = '----moroproto';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\npwned\r\n--${boundary}--\r\n`,
      'binary'
    );
    const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(({} as any).pwned).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('pwned');
    expect(parsed).toBeDefined();
  });

  it('terminates promptly when the boundary never appears', () => {
    const body = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const started = Date.now();
    try {
      parseMultipart(body, 'multipart/form-data; boundary=----never-present');
    } catch {
      // Rejection is fine - the property under test is termination.
    }
    const elapsed = Date.now() - started;
    if (elapsed >= 2000) {
      throw new Error(`multipart scan took ${elapsed}ms on a 2MB body`);
    }
  });
});
