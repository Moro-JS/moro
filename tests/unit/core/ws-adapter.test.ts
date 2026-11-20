// Unit tests - the `ws` adapter: the CORS origin contract of its verifyClient
// builder, and how it loads the `ws` package.
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

const resolveUserPackage = jest.fn<(name: string) => string>();
jest.mock('../../../src/core/utilities/package-utils.js', () => ({
  ...(jest.requireActual('../../../src/core/utilities/package-utils.js') as object),
  resolveUserPackage: (name: string) => resolveUserPackage(name),
}));

import { WSAdapter } from '../../../src/core/networking/adapters/ws-adapter.js';

// Exercises the real (private) verifyClient builder so the CORS origin contract
// - '*', function, array, exact, same-origin - is locked in.
function build(cors: any) {
  const adapter = new WSAdapter();
  return (adapter as any).buildVerifyClient({ cors }) as
    ((info: { origin?: string; req: any; secure: boolean }) => boolean) | undefined;
}

const reqFor = (host = 'api.example.com') => ({ req: { headers: { host } }, secure: false });

describe('WSAdapter CORS origin', () => {
  it('allow-all forms return no verifyClient (undefined)', () => {
    expect(build({ origin: '*' })).toBeUndefined();
    expect(build({ origin: true })).toBeUndefined();
  });

  it('an origin that is not configured means same-origin only', () => {
    for (const cors of [undefined, {}, { origin: undefined }, { origin: null }]) {
      const vc = build(cors)!;
      expect(vc({ origin: undefined, ...reqFor('api.example.com') })).toBe(true); // non-browser
      expect(vc({ origin: 'https://api.example.com', ...reqFor('api.example.com') })).toBe(true);
      expect(vc({ origin: 'https://API.example.com', ...reqFor('Api.Example.com') })).toBe(true);
      expect(vc({ origin: 'http://localhost:3000', ...reqFor('localhost:3000') })).toBe(true);
      expect(vc({ origin: 'https://evil.example', ...reqFor('api.example.com') })).toBe(false);
      expect(vc({ origin: 'http://localhost:3001', ...reqFor('localhost:3000') })).toBe(false);
      expect(vc({ origin: 'null', ...reqFor('api.example.com') })).toBe(false);
      expect(vc({ origin: 'https://api.example.com', req: { headers: {} }, secure: false })).toBe(
        false
      );
    }
  });

  it('an unconfigured origin still runs the verifyClient hook', () => {
    const adapter = new WSAdapter();
    const vc = (adapter as any).buildVerifyClient({
      cors: {},
      verifyClient: (info: any) => info.req.headers['x-token'] === 'good',
    }) as (info: any) => boolean;
    const req = (token: string) => ({ headers: { host: 'api.example.com', 'x-token': token } });
    expect(vc({ req: req('good'), secure: false })).toBe(true);
    expect(vc({ req: req('bad'), secure: false })).toBe(false);
    expect(vc({ origin: 'https://evil.example', req: req('good'), secure: false })).toBe(false);
  });

  it('a hook or origin function that throws rejects the upgrade', () => {
    const adapter = new WSAdapter();
    const boom = () => {
      throw new Error('boom');
    };
    const hook = (adapter as any).buildVerifyClient({
      cors: { origin: true },
      verifyClient: boom,
    }) as (info: any) => boolean;
    expect(hook({ origin: 'https://a.com', ...reqFor() })).toBe(false);
    const rule = build({ origin: boom })!;
    expect(rule({ origin: 'https://a.com', ...reqFor() })).toBe(false);
  });

  it('exact string origin allows only the match', () => {
    const vc = build({ origin: 'https://app.example.com' })!;
    expect(vc({ origin: 'https://app.example.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://evil.com', ...reqFor() })).toBe(false);
  });

  it('array origin allows any listed origin', () => {
    const vc = build({ origin: ['https://a.com', 'https://b.com'] })!;
    expect(vc({ origin: 'https://a.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://b.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://c.com', ...reqFor() })).toBe(false);
  });

  it('function origin decides dynamically (boolean, string, or "*")', () => {
    // boolean predicate
    const vcBool = build({ origin: (o: string | undefined) => o === 'https://dyn.com' })!;
    expect(vcBool({ origin: 'https://dyn.com', ...reqFor() })).toBe(true);
    expect(vcBool({ origin: 'https://nope.com', ...reqFor() })).toBe(false);

    // reflect the request origin (return the allowed domain)
    const allow = new Set(['https://ok.com']);
    const vcReflect = build({
      origin: (o: string | undefined) => (o && allow.has(o) ? o : false),
    })!;
    expect(vcReflect({ origin: 'https://ok.com', ...reqFor() })).toBe(true);
    expect(vcReflect({ origin: 'https://bad.com', ...reqFor() })).toBe(false);

    // a function may also open it back up with '*'
    const vcStar = build({ origin: () => '*' })!;
    expect(vcStar({ origin: 'https://anything.com', ...reqFor() })).toBe(true);
  });

  it('RegExp origin matches by pattern', () => {
    const vc = build({ origin: /\.example\.com$/ })!;
    expect(vc({ origin: 'https://x.example.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://x.evil.com', ...reqFor() })).toBe(false);
  });

  it('false = same-origin only (Origin host must equal Host; no Origin allowed)', () => {
    const vc = build({ origin: false })!;
    expect(vc({ origin: undefined, ...reqFor('api.example.com') })).toBe(true); // non-browser
    expect(vc({ origin: 'http://api.example.com', ...reqFor('api.example.com') })).toBe(true);
    expect(vc({ origin: 'http://other.com', ...reqFor('api.example.com') })).toBe(false);
  });

  it('a user verifyClient hook runs after the origin check passes', () => {
    const vc = build({ origin: '*' }); // allow-all origin, but hook still enforced...
    // origin '*' short-circuits to undefined, so use a specific origin + hook:
    const adapter = new WSAdapter();
    const withHook = (adapter as any).buildVerifyClient({
      cors: { origin: true },
      verifyClient: (info: any) => info.origin === 'https://trusted.com',
    }) as (info: any) => boolean;
    expect(withHook({ origin: 'https://trusted.com', ...reqFor() })).toBe(true);
    expect(withHook({ origin: 'https://other.com', ...reqFor() })).toBe(false);
    expect(vc).toBeUndefined();
  });
});

// `ws` is CommonJS and attaches its exports at runtime, so under real ESM
// `await import('ws')` yields `{ default: <the ws module> }` with no named
// `WebSocketServer`. Jest compiles `import()` to `require()` and never sees
// that shape, so these tests feed it to the adapter through small stand-in
// modules that the adapter is pointed at.
describe('WSAdapter: loading the ws package', () => {
  const realWsPath = createRequire(path.join(process.cwd(), 'package.json')).resolve('ws');

  let dir: string;
  const standIn = (name: string, source: string): string => {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, source);
    return file;
  };

  let server: http.Server | undefined;
  let adapter: WSAdapter | undefined;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-ws-shape-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    resolveUserPackage.mockReset();
    if (adapter) await adapter.close();
    adapter = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server?.close(() => resolve()));
    }
    server = undefined;
  });

  const initialize = async () => {
    server = http.createServer();
    adapter = new WSAdapter();
    await adapter.initialize(server, {});
    return adapter;
  };

  it('starts when the module exposes ws only as its default export (real ESM)', async () => {
    // What `await import('<path to ws>')` evaluates to under ESM
    const file = standIn(
      'default-only',
      `Object.defineProperty(exports, '__esModule', { value: true });
       exports.default = require(${JSON.stringify(realWsPath)});`
    );
    const shape = await import(file);
    expect(shape.WebSocketServer).toBeUndefined();
    expect(typeof shape.default.WebSocketServer).toBe('function');

    resolveUserPackage.mockReturnValue(file);
    const a = await initialize();
    expect(resolveUserPackage).toHaveBeenCalledWith('ws');

    // and it really serves WebSocket clients
    const echoed: string[] = [];
    a.getDefaultNamespace().on('connection', socket => {
      socket.on('ping', (data: string) => {
        echoed.push(data);
        socket.emit('pong', data);
      });
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()));
    const port = (server?.address() as AddressInfo).port;
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('open', () => ws.send(JSON.stringify({ event: 'ping', data: 'hi' })));
      ws.once('message', data => {
        resolve(data.toString());
        ws.close();
      });
      ws.once('error', reject);
    });
    expect(JSON.parse(reply)).toEqual({ event: 'pong', data: 'hi' });
    expect(echoed).toEqual(['hi']);
  });

  it('starts when the module has named exports (CommonJS build, Jest)', async () => {
    resolveUserPackage.mockReturnValue(realWsPath);
    await expect(initialize()).resolves.toBeDefined();
  });

  it('reports "not found" only when the package cannot be resolved', async () => {
    resolveUserPackage.mockImplementation(() => {
      throw Object.assign(new Error("Cannot find module 'ws'"), { code: 'MODULE_NOT_FOUND' });
    });
    await expect(initialize()).rejects.toThrow(
      /^ws library not found\. Install it with: npm install ws/
    );
  });

  it('surfaces any other load failure with its own message', async () => {
    resolveUserPackage.mockReturnValue(
      standIn('throws', `throw new Error('native addon failed to load');`)
    );
    await expect(initialize()).rejects.toThrow('native addon failed to load');

    resolveUserPackage.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    await expect(initialize()).rejects.toThrow('EACCES: permission denied');
  });

  it('says so when the package loads but has no WebSocketServer', async () => {
    resolveUserPackage.mockReturnValue(
      standIn(
        'too-old',
        `Object.defineProperty(exports, '__esModule', { value: true });
         exports.default = { Server: function () {} };`
      )
    );
    await expect(initialize()).rejects.toThrow(/does not export WebSocketServer/);
  });
});
