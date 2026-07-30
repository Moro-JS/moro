/* eslint-disable no-undef */
import { createApp, createAppEdge, middleware, HOOK_EVENTS } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { createTestPort, delay, waitFor } from '../setup.js';

describe('Hook lifecycle - integration', () => {
  let app: Moro;
  let port: number;

  beforeEach(async () => {
    port = createTestPort();
    app = await createApp({ logging: { level: 'error' } });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('exposes the live hook manager as app.hooks', () => {
    expect(typeof app.hooks.before).toBe('function');
    expect(typeof app.hooks.after).toBe('function');
    expect(typeof app.hooks.hasHooks).toBe('function');
  });

  it("fires before('request') and after('response') around a request", async () => {
    const order: string[] = [];

    app.hooks.before('request', (ctx: any) => {
      order.push(`before:hasReq=${!!ctx.request}`);
    });
    app.hooks.after('response', (ctx: any) => {
      order.push(`after:status=${ctx.response?.statusCode}`);
    });

    app.get('/hooked', () => ({ ok: true }));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const res = await fetch(`http://localhost:${port}/hooked`);
    expect(res.status).toBe(200);

    // Response hooks run after the response is flushed, off the critical path
    await waitFor(() => order.length === 2, { description: 'both lifecycle hooks to fire' });
    expect(order[0]).toBe('before:hasReq=true');
    expect(order[1]).toBe('after:status=200');
  });

  it("fires 'error' hooks when a handler throws, without altering the 500", async () => {
    const seen: string[] = [];
    app.hooks.after('error', (ctx: any) => {
      seen.push(`${ctx.error?.message}:${!!ctx.request}`);
    });

    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const res = await fetch(`http://localhost:${port}/boom`);
    expect(res.status).toBe(500);

    // Error hooks are fire-and-forget observers
    await waitFor(() => seen.length === 1, { description: 'error hook to fire' });
    expect(seen[0]).toBe('kaboom:true');
  });

  it('HOOK_EVENTS names the events that actually execute', () => {
    expect(HOOK_EVENTS).toEqual({
      REQUEST: 'request',
      RESPONSE: 'response',
      ERROR: 'error',
    });

    // The constants are valid registration keys
    const fn = () => {};
    app.hooks.before(HOOK_EVENTS.REQUEST, fn);
    expect(app.hooks.hasHooks('request')).toBe(true);
    app.hooks.removeHook(HOOK_EVENTS.REQUEST, fn);
  });

  it('runs lifecycle hooks on the serverless handler path (edge runtime)', async () => {
    const edgeApp = await createAppEdge({ logging: { level: 'fatal' } });
    const events: string[] = [];

    edgeApp.hooks.before('request', () => {
      events.push('request');
    });
    edgeApp.hooks.after('response', () => {
      events.push('response');
    });

    edgeApp.get('/edge', () => ({ ok: true }));

    const fetchHandler = edgeApp.getHandler() as (request: Request) => Promise<Response>;
    const response = await fetchHandler(new Request('http://localhost/edge'));

    expect(response.status).toBe(200);
    // On serverless, response hooks are awaited BEFORE the handler returns —
    // post-return work would be frozen by the platform
    expect(events).toEqual(['request', 'response']);

    await edgeApp.close();
  });

  it('persists session changes made in handlers (hook-form session middleware)', async () => {
    // middleware.session is the hook form: attach on before('request'),
    // save on after('response'). The save half never fired before the
    // response-hook execution fix, so views stayed at 1 forever.
    await app.use(middleware.session({ secret: 'test-secret', store: 'memory' }));

    app.get('/count', (req: any) => {
      req.session.views = (req.session.views || 0) + 1;
      return { views: req.session.views };
    });

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const first = await fetch(`http://localhost:${port}/count`);
    const setCookie = first.headers.get('set-cookie');
    const firstData = (await first.json()) as any;
    expect(firstData.views).toBe(1);
    expect(setCookie).toBeTruthy();

    // Give the post-response save hook a moment to write to the store
    await delay(150);

    const second = await fetch(`http://localhost:${port}/count`, {
      headers: { cookie: (setCookie as string).split(';')[0]! },
    });
    const secondData = (await second.json()) as any;
    expect(secondData.views).toBe(2);
  });
});
