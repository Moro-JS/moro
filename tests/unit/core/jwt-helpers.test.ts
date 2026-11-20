// Unit tests - the JWT helpers for custom auth middleware: how safeVerifyJWT
// loads the `jsonwebtoken` package, and what it reports for each outcome.
//
// `jsonwebtoken` is not a dependency of this repo, so these tests point the
// helper at small stand-in modules that implement HS256 verification with the
// same error names. `jsonwebtoken` is CommonJS and builds its exports at
// runtime, so under real ESM `await import('jsonwebtoken')` yields
// `{ default: <the module> }` with no named `verify`. Jest compiles `import()`
// to `require()` and never sees that shape, so one stand-in reproduces it.
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const resolveUserPackage = jest.fn<(name: string) => string>();
jest.mock('../../../src/core/utilities/package-utils.js', () => ({
  ...(jest.requireActual('../../../src/core/utilities/package-utils.js') as object),
  resolveUserPackage: (name: string) => resolveUserPackage(name),
}));

import * as moro from '../../../src/index.js';
import {
  safeVerifyJWT,
  extractJWTFromHeader,
  createAuthErrorResponse,
} from '../../../src/core/middleware/built-in/auth/jwt-helpers.js';

const SECRET = 'jwt-test-secret';

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** An HS256 token over `payload`, signed with `secret`. */
function sign(payload: Record<string, unknown>, secret = SECRET, alg = 'HS256'): string {
  const head = `${b64url(JSON.stringify({ alg, typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(head).digest('base64url');
  return `${head}.${signature}`;
}

// The parts of jsonwebtoken's verify() the helper relies on: the algorithm
// allow-list, the signature check, `exp`, and its error names.
const VERIFY_SOURCE = `
const crypto = require('crypto');
function fail(name, message, extra) {
  const error = new Error(message);
  error.name = name;
  throw Object.assign(error, extra);
}
function verify(token, secret, options) {
  const parts = String(token).split('.');
  if (parts.length !== 3) fail('JsonWebTokenError', 'jwt malformed');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (!options.algorithms.includes(header.alg)) fail('JsonWebTokenError', 'invalid algorithm');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(parts[0] + '.' + parts[1])
    .digest('base64url');
  if (expected !== parts[2]) fail('JsonWebTokenError', 'invalid signature');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) {
    fail('TokenExpiredError', 'jwt expired', { expiredAt: new Date(payload.exp * 1000) });
  }
  return payload;
}
`;

describe('safeVerifyJWT', () => {
  let dir: string;
  const standIn = (name: string, source: string): string => {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, source);
    return file;
  };
  let defaultOnly: string;
  let namedExports: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-jwt-shape-'));
    // What `await import('jsonwebtoken')` evaluates to under ESM
    defaultOnly = standIn(
      'default-only',
      `${VERIFY_SOURCE}
       Object.defineProperty(exports, '__esModule', { value: true });
       exports.default = { verify };`
    );
    // What a CommonJS build gets from require('jsonwebtoken')
    namedExports = standIn('named-exports', `${VERIFY_SOURCE}\nmodule.exports = { verify };`);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    resolveUserPackage.mockReset();
  });

  it('verifies a token when the package exposes verify only on its default export (real ESM)', async () => {
    const shape = await import(defaultOnly);
    expect(shape.verify).toBeUndefined();
    expect(typeof shape.default.verify).toBe('function');

    resolveUserPackage.mockReturnValue(defaultOnly);
    const result = await safeVerifyJWT(sign({ sub: 'user-1', role: 'admin' }), SECRET);

    expect(resolveUserPackage).toHaveBeenCalledWith('jsonwebtoken');
    expect(result).toEqual({ success: true, payload: { sub: 'user-1', role: 'admin' } });
  });

  it('verifies a token when the package has named exports (CommonJS build)', async () => {
    resolveUserPackage.mockReturnValue(namedExports);

    const result = await safeVerifyJWT(sign({ sub: 'user-1' }), SECRET);

    expect(result).toEqual({ success: true, payload: { sub: 'user-1' } });
  });

  describe.each([
    ['default export', () => defaultOnly],
    ['named exports', () => namedExports],
  ])('through the %s', (_label, standInPath) => {
    it('reports a bad signature as invalid', async () => {
      resolveUserPackage.mockReturnValue(standInPath());

      const result = await safeVerifyJWT(sign({ sub: 'user-1' }, 'another-secret'), SECRET);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('invalid');
    });

    it('reports an expired token as expired, with when it expired', async () => {
      resolveUserPackage.mockReturnValue(standInPath());
      const exp = Math.floor(Date.now() / 1000) - 60;

      const result = await safeVerifyJWT(sign({ sub: 'user-1', exp }), SECRET);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('expired');
      expect(result.error?.expiredAt).toEqual(new Date(exp * 1000));
    });

    it('rejects a token signed with an algorithm other than HS256 by default', async () => {
      resolveUserPackage.mockReturnValue(standInPath());
      const token = sign({ sub: 'user-1' }, SECRET, 'HS512');

      expect((await safeVerifyJWT(token, SECRET)).error?.type).toBe('invalid');
    });

    it('does not use a PEM public key or certificate as the HS256 secret', async () => {
      resolveUserPackage.mockReturnValue(standInPath());
      const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const spki = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      const keys: any[] = [
        spki,
        publicKey.export({ type: 'pkcs1', format: 'pem' }),
        Buffer.from(spki),
        '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUdGVzdA==\n-----END CERTIFICATE-----\n',
      ];

      for (const key of keys) {
        // Anyone who has the public key can produce this token
        const forged = sign({ sub: 'admin' }, key);

        const result = await safeVerifyJWT(forged, key);

        expect(result).toEqual({
          success: false,
          error: {
            type: 'missing_secret',
            message: expect.stringContaining('public key requires options.algorithms'),
          },
        });
        expect(createAuthErrorResponse(result.error).error).toBe('Configuration error');

        // With the algorithms named, the decision is the package's
        const named = await safeVerifyJWT(forged, key, { algorithms: ['RS256'] });
        expect(named.error?.type).toBe('invalid');
      }
    });
  });

  it('says the package is required when it cannot be resolved', async () => {
    resolveUserPackage.mockImplementation(() => {
      throw Object.assign(new Error("Cannot find module 'jsonwebtoken'"), {
        code: 'MODULE_NOT_FOUND',
      });
    });

    const result = await safeVerifyJWT(sign({ sub: 'user-1' }), SECRET);

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/requires the "jsonwebtoken" package/);
  });

  it('is exported from the package root with its companion helpers', () => {
    expect(moro.safeVerifyJWT).toBe(safeVerifyJWT);
    expect(moro.extractJWTFromHeader).toBe(extractJWTFromHeader);
    expect(moro.createAuthErrorResponse).toBe(createAuthErrorResponse);
  });
});
