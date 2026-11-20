// cdn() middleware - when a response is marked for the CDN to keep, and when
// the CDN is asked to purge.
//
// The adapter's `Cache-Control: public, max-age=...` goes only on responses
// that are safe for a shared cache: successful GET/HEAD responses to requests
// without Authorization, that set no cookie and carry no Cache-Control of
// their own. With autoInvalidate the CDN is purged only after a write that
// was answered below 400.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CDNCore } from '../../../src/core/middleware/built-in/cdn/core.js';
import { CloudFrontCDNAdapter } from '../../../src/core/middleware/built-in/cdn/adapters/cdn/cloudfront.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import { cdn } from '../../../src/core/middleware/built-in/cdn/hook.js';
import { createCDNMiddleware } from '../../../src/core/middleware/built-in/cdn/middleware.js';
import type { CDNAdapter } from '../../../src/types/cdn.js';

const CDN_CACHE_CONTROL = 'public, max-age=3600';

/** An adapter shaped like the built-in ones: a public Cache-Control plus a provider header */
function fakeAdapter() {
  const purged: string[][] = [];
  const adapter: CDNAdapter = {
    purge: async urls => {
      purged.push(urls);
    },
    setHeaders: response => {
      response.setHeader('Cache-Control', CDN_CACHE_CONTROL);
      response.setHeader('X-CDN-Provider', 'Fake');
    },
  };
  return { adapter, purged };
}

/**
 * Response double with the two ways a head goes out: json()/send()/redirect()
 * that reach end() (Node backend), or each sending by itself (native engine).
 */
class FakeResponse {
  statusCode = 200;
  headersSent = false;
  headers: Record<string, any> = {};
  /** The headers as they were when the head was sent */
  wire: Record<string, any> | undefined;
  wireStatus: number | undefined;
  private listeners: Array<() => void> = [];

  constructor(private chained = true) {}

  setHeader(name: string, value: any): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): any {
    return this.headers[name.toLowerCase()];
  }
  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  once(event: string, listener: () => void): this {
    if (event === 'finish') this.listeners.push(listener);
    return this;
  }
  private flush(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.wire = { ...this.headers };
    this.wireStatus = this.statusCode;
  }
  private finish(): void {
    for (const listener of this.listeners.splice(0)) listener();
  }
  writeHead(status: number, headers?: Record<string, any>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    this.flush();
    return this;
  }
  write(_chunk: any): boolean {
    this.flush();
    return true;
  }
  end(_data?: any): void {
    this.flush();
    this.finish();
  }
  json(_data: any): void {
    if (this.chained) {
      (this as any).writeHead(this.statusCode, { 'Content-Type': 'application/json' });
      (this as any).end('{}');
    } else {
      this.flush();
      this.finish();
    }
  }
  send(data: any): void {
    if (this.chained) (this as any).end(data);
    else {
      this.flush();
      this.finish();
    }
  }
  redirect(url: string, status = 302): void {
    this.statusCode = status;
    this.setHeader('Location', url);
    if (this.chained) (this as any).end();
    else {
      this.flush();
      this.finish();
    }
  }
}

function request(method = 'GET', headers: Record<string, string> = {}, path = '/api/items') {
  return { method, path, headers } as any;
}

/** applyHeaders() then a handler; returns the headers that went out */
function respond(
  req: any,
  handler: (res: FakeResponse) => void,
  { chained = true, prepare }: { chained?: boolean; prepare?: (res: FakeResponse) => void } = {}
) {
  const core = new CDNCore({ adapter: fakeAdapter().adapter });
  const res = new FakeResponse(chained);
  prepare?.(res);
  core.applyHeaders(req, res);
  handler(res);
  return res.wire as Record<string, any>;
}

describe.each([
  ['a response that finishes through writeHead()/end()', true],
  ['a response whose json()/send() send by themselves', false],
])('cdn Cache-Control on %s', (_label, chained) => {
  const ok = (res: FakeResponse) => res.json({ ok: true });

  it('marks a plain successful GET for the CDN', () => {
    const wire = respond(request('GET'), ok, { chained });
    expect(wire['cache-control']).toBe(CDN_CACHE_CONTROL);
    expect(wire['x-cdn-provider']).toBe('Fake');
  });

  it('marks a successful HEAD and a 304', () => {
    expect(respond(request('HEAD'), res => res.end(), { chained })['cache-control']).toBe(
      CDN_CACHE_CONTROL
    );
    const notModified = respond(request('GET'), res => res.status(304).end(), { chained });
    expect(notModified['cache-control']).toBe(CDN_CACHE_CONTROL);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('does not mark a %s', method => {
    const wire = respond(request(method), ok, { chained });
    expect(wire['cache-control']).toBeUndefined();
    // the adapter's other headers are not affected
    expect(wire['x-cdn-provider']).toBe('Fake');
  });

  it('does not mark a request that carries Authorization', () => {
    const wire = respond(request('GET', { authorization: 'Bearer alice' }), ok, { chained });
    expect(wire['cache-control']).toBeUndefined();
  });

  it.each([201, 204, 206])('marks a %i', status => {
    const wire = respond(request('GET'), res => res.status(status).json({}), { chained });
    expect(wire['cache-control']).toBe(CDN_CACHE_CONTROL);
  });

  it.each([301, 302, 400, 401, 403, 404, 429, 500, 503])('does not mark a %i', status => {
    const wire = respond(request('GET'), res => res.status(status).json({ error: status }), {
      chained,
    });
    expect(wire['cache-control']).toBeUndefined();
  });

  it('does not mark a redirect', () => {
    const wire = respond(request('GET'), res => res.redirect('/login'), { chained });
    expect(wire['cache-control']).toBeUndefined();
    expect(wire['location']).toBe('/login');
  });

  it('does not mark a response that sets a cookie', () => {
    const wire = respond(
      request('GET'),
      res => {
        res.setHeader('Set-Cookie', ['sid=1; HttpOnly']);
        res.json({ ok: true });
      },
      { chained }
    );
    expect(wire['cache-control']).toBeUndefined();
    expect(wire['set-cookie']).toEqual(['sid=1; HttpOnly']);
  });

  it("leaves the handler's own Cache-Control alone", () => {
    for (const own of ['private, no-store', 'public, max-age=60', CDN_CACHE_CONTROL]) {
      const wire = respond(
        request('GET'),
        res => {
          res.setHeader('Cache-Control', own);
          res.json({ ok: true });
        },
        { chained }
      );
      expect(wire['cache-control']).toBe(own);
    }
    // ...also on a response the CDN header would have been withdrawn from
    const failed = respond(
      request('GET'),
      res => {
        res.setHeader('Cache-Control', 'no-store');
        res.status(500).json({});
      },
      { chained }
    );
    expect(failed['cache-control']).toBe('no-store');
  });

  it('leaves a Cache-Control set before the middleware ran alone', () => {
    const wire = respond(request('GET'), ok, {
      chained,
      prepare: res => res.setHeader('Cache-Control', 'private'),
    });
    expect(wire['cache-control']).toBe('private');
  });

  it('decides a streamed response when its head goes out', () => {
    const streamed = respond(
      request('GET'),
      res => {
        res.write('chunk');
        res.end();
      },
      { chained }
    );
    expect(streamed['cache-control']).toBe(CDN_CACHE_CONTROL);

    const failed = respond(
      request('GET'),
      res => {
        res.statusCode = 500;
        res.write('partial');
        res.end();
      },
      { chained }
    );
    expect(failed['cache-control']).toBeUndefined();
  });
});

describe('cdn Cache-Control with writeHead()', () => {
  it('reads the status and a Set-Cookie passed to writeHead itself', () => {
    const notFound = respond(request('GET'), res => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });
    expect(notFound['cache-control']).toBeUndefined();

    const cookie = respond(request('GET'), res => {
      res.writeHead(200, { 'Set-Cookie': 'sid=1' });
      res.end('ok');
    });
    expect(cookie['cache-control']).toBeUndefined();

    const fine = respond(request('GET'), res => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    expect(fine['cache-control']).toBe(CDN_CACHE_CONTROL);
  });
});

describe('cdn autoInvalidate', () => {
  const options = (adapter: CDNAdapter) => ({
    adapter,
    autoInvalidate: true,
    invalidationPatterns: ['^/api/'],
  });

  it('CDNCore purges only after a write that was answered below 400', async () => {
    const { adapter, purged } = fakeAdapter();
    const core = new CDNCore(options(adapter));

    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      await core.autoInvalidate('/api/items', method, 200);
    }
    for (const status of [400, 401, 404, 409, 500]) {
      await core.autoInvalidate('/api/items', 'POST', status);
    }
    expect(purged).toEqual([]);

    await core.autoInvalidate('/api/items', 'POST', 201);
    await core.autoInvalidate('/api/items/1', 'DELETE', 204);
    await core.autoInvalidate('/api/items/1', 'PUT', 302);
    await core.autoInvalidate('/other', 'POST', 200); // pattern does not match
    expect(purged).toEqual([['/api/items'], ['/api/items/1'], ['/api/items/1']]);
  });

  it('CDNCore keeps purging when called with a path alone (direct callers)', async () => {
    const { adapter, purged } = fakeAdapter();
    const core = new CDNCore(options(adapter));
    await core.autoInvalidate('/api/items');
    expect(purged).toEqual([['/api/items']]);
  });

  it('the hook purges after successful writes only', async () => {
    const { adapter, purged } = fakeAdapter();
    const after: Array<(context: any) => Promise<void>> = [];
    await cdn(options(adapter)).install(
      {
        before: () => undefined,
        after: (_event: string, fn: (context: any) => Promise<void>) => after.push(fn),
      } as any,
      {}
    );
    const finished = (method: string, status: number) =>
      (after[0] as (context: any) => Promise<void>)({
        request: request(method),
        response: { statusCode: status },
      });

    for (let i = 0; i < 7; i++) await finished('GET', 200);
    await finished('POST', 404);
    await finished('DELETE', 500);
    expect(purged).toEqual([]);

    await finished('POST', 201);
    expect(purged).toEqual([['/api/items']]);
  });

  it('the middleware purges after successful writes only', async () => {
    const { adapter, purged } = fakeAdapter();
    const mw = createCDNMiddleware(options(adapter));
    const through = async (method: string, status: number) => {
      const res = new FakeResponse();
      await mw(request(method), res as any, async () => {
        res.status(status).json({});
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    };

    await through('GET', 200);
    await through('POST', 422);
    expect(purged).toEqual([]);
    await through('PUT', 200);
    expect(purged).toEqual([['/api/items']]);
  });

  it('the middleware waits for a response that is sent later', async () => {
    const { adapter, purged } = fakeAdapter();
    const mw = createCDNMiddleware(options(adapter));
    const res = new FakeResponse();
    // next() returns before the handler has answered
    await mw(request('POST'), res as any, async () => undefined);
    expect(purged).toEqual([]);

    res.status(500).json({});
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(purged).toEqual([]);

    const later = new FakeResponse();
    await mw(request('POST'), later as any, async () => undefined);
    later.status(201).json({});
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(purged).toEqual([['/api/items']]);
  });
});

// The CloudFront adapter talks to AWS through whichever SDK the application
// has installed. Neither is installed here, so each test runs in a directory
// holding small stand-ins that record the calls they are given.
describe('CloudFront adapter SDK', () => {
  const roots: string[] = [];

  // A stand-in for AWS SDK v2: `new AWS.CloudFront().createInvalidation(p).promise()`
  const SDK_V2_SOURCE = `
    const calls = (globalThis.__cloudfrontCalls ??= []);
    class CloudFront {
      createInvalidation(params) {
        return { promise: async () => (calls.push(['v2', params]), { Invalidation: { Id: 'I-V2' } }) };
      }
    }
    module.exports = { config: { update() {} }, CloudFront };
  `;
  // A stand-in for AWS SDK v3: `client.send(new CreateInvalidationCommand(p))`
  const SDK_V3_SOURCE = `
    const calls = (globalThis.__cloudfrontCalls ??= []);
    class CreateInvalidationCommand { constructor(input) { this.input = input; } }
    class GetDistributionCommand { constructor(input) { this.input = input; } }
    class CloudFrontClient {
      constructor(config) { this.config = config; }
      async send(command) {
        calls.push(['v3', command.input, this.config]);
        return { Invalidation: { Id: 'I-V3' } };
      }
    }
    module.exports = { CloudFrontClient, CreateInvalidationCommand, GetDistributionCommand };
  `;

  /** Run from a directory where the named packages are installed */
  function installed(packages: Record<string, { version: string; source: string }>): void {
    const root = mkdtempSync(join(tmpdir(), 'moro-cdn-'));
    roots.push(root);
    for (const [name, { version, source }] of Object.entries(packages)) {
      const dir = join(root, 'node_modules', ...name.split('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
      writeFileSync(join(dir, 'index.js'), source);
    }
    jest.spyOn(process, 'cwd').mockReturnValue(root);
  }

  function warnings(): () => string[] {
    globalLogger.setLevel('warn');
    const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    return () => log.mock.calls.filter(c => c[0] === 'warn').map(c => String(c[1]));
  }

  const recorded = (): any[] => ((globalThis as any).__cloudfrontCalls ??= []);

  const adapterOptions = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-east-1',
    distributionId: 'D123',
  };

  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
    recorded().length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('purges through @aws-sdk/client-cloudfront when the application has it', async () => {
    installed({
      '@aws-sdk/client-cloudfront': { version: '3.974.0', source: SDK_V3_SOURCE },
      'aws-sdk': { version: '2.1693.0', source: SDK_V2_SOURCE },
    });
    const warned = warnings();

    // purge() straight after construction waits for the SDK to be loaded
    await new CloudFrontCDNAdapter(adapterOptions).purge(['/a', 'b']);

    expect(recorded()).toHaveLength(1);
    const [sdk, params, config] = recorded()[0];
    expect(sdk).toBe('v3');
    expect(params.DistributionId).toBe('D123');
    expect(params.InvalidationBatch.Paths).toEqual({ Quantity: 2, Items: ['/a', '/b'] });
    expect(config).toEqual({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    // The v2 package was not loaded, so nothing is said about it
    expect(warned()).toEqual([]);
  });

  it('falls back to aws-sdk v2 and says once which package to move to', async () => {
    installed({ 'aws-sdk': { version: '2.1693.0', source: SDK_V2_SOURCE } });
    const warned = warnings();

    await new CloudFrontCDNAdapter(adapterOptions).purge(['/a']);
    await new CloudFrontCDNAdapter(adapterOptions).purge(['/b']);

    expect(recorded().map(call => call[0])).toEqual(['v2', 'v2']);
    const said = warned().filter(message => message.includes('aws-sdk'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('aws-sdk 2.1693.0');
    expect(said[0]).toContain('@aws-sdk/client-cloudfront');
  });
});
