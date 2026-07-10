/* eslint-disable */
// @ts-nocheck
// Unit Tests - MoroEngineServer against a FAKE @morojs/engine module that
// implements the native API contract (engine repo docs/API.md) in memory.
// No native binary required: the fake records serve/respond/writeHead/write/
// end calls per reqId and drives the onRequest/onAborted/onWritable callbacks.
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'OTHER'];

const tick = () => new Promise(resolve => setImmediate(resolve));

/** Fold a flat [k1,v1,k2,v2,...] header array into { key: [values...] } */
function foldFlat(flat: string[] | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    (out[flat[i]] ??= []).push(flat[i + 1]);
  }
  return out;
}

function createFakeEngine() {
  const requests = new Map<number, any>();
  let callbacks: any = null;
  let serveOptions: any = null;
  let nextReqId = 1;
  const listens: any[] = [];
  let closed = false;

  // reqIds are safe no-ops after terminal/abort - the fake enforces that
  const live = (reqId: number) => {
    const r = requests.get(reqId);
    return r && !r.terminal && !r.aborted ? r : undefined;
  };

  const engine = {
    serve(cbs: any, options: any) {
      callbacks = cbs;
      serveOptions = options;
      return 42;
    },
    listen(serverId: number, host: string, port: number) {
      listens.push({ serverId, host, port });
      return port === 0 ? 54321 : port;
    },
    close(_serverId: number) {
      closed = true;
    },
    stopListening(_serverId: number) {
      // graceful-drain phase; the fake has nothing to drain
    },
    getMethod(reqId: number) {
      return live(reqId)?.methodStr;
    },
    getQuery(reqId: number) {
      return live(reqId)?.query;
    },
    getHeaders(reqId: number) {
      return live(reqId)?.headersFlat.slice();
    },
    getHeader(reqId: number, name: string) {
      const r = live(reqId);
      if (!r) return undefined;
      for (let i = 0; i + 1 < r.headersFlat.length; i += 2) {
        if (r.headersFlat[i] === name) return r.headersFlat[i + 1];
      }
      return undefined;
    },
    getBody(reqId: number) {
      const r = live(reqId);
      if (!r || !r.body) return null;
      // Stable copy, like the native engine
      const copy = new ArrayBuffer(r.body.length);
      new Uint8Array(copy).set(r.body);
      return copy;
    },
    getRemoteAddress(reqId: number) {
      return live(reqId)?.remoteAddress;
    },
    respond(reqId: number, status: number, headersFlat: string[] | null, body: any) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'respond', status, headersFlat, body });
      r.terminal = true;
    },
    writeHead(reqId: number, status: number, headersFlat: string[] | null) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'writeHead', status, headersFlat });
    },
    write(reqId: number, chunk: any) {
      const r = live(reqId);
      if (!r) return false;
      r.ops.push({ type: 'write', chunk });
      return !r.backpressure;
    },
    end(reqId: number, chunk?: any) {
      const r = live(reqId);
      if (!r) return;
      r.ops.push({ type: 'end', chunk });
      r.terminal = true;
    },
    isAborted(reqId: number) {
      return requests.get(reqId)?.aborted ?? false;
    },
    probe() {
      return { ok: true, version: 'fake', abi: process.versions.modules };
    },
    version: 'fake',

    // ---- test drivers ----
    requests,
    get serveOptions() {
      return serveOptions;
    },
    get listens() {
      return listens;
    },
    get closed() {
      return closed;
    },
    simulate(options: any = {}) {
      const method = (options.method || 'GET').toUpperCase();
      let methodIdx = METHODS.indexOf(method);
      if (methodIdx === -1) methodIdx = 7;
      const headersFlat: string[] = [];
      for (const [k, v] of Object.entries(options.headers || {})) {
        headersFlat.push(k.toLowerCase(), String(v));
      }
      // rawHeaders: [lowercaseKey,value,...] appended verbatim so duplicate
      // header lines (which an object can't express) can be simulated
      if (Array.isArray(options.rawHeaders)) {
        for (const h of options.rawHeaders) headersFlat.push(String(h));
      }
      const reqId = nextReqId++;
      requests.set(reqId, {
        methodStr: method,
        path: options.path || '/',
        query: options.query || '',
        headersFlat,
        body: options.body
          ? Buffer.isBuffer(options.body)
            ? options.body
            : Buffer.from(options.body)
          : null,
        remoteAddress: options.remoteAddress || '127.0.0.1',
        aborted: false,
        terminal: false,
        backpressure: !!options.backpressure,
        ops: [],
      });
      callbacks.onRequest(reqId, methodIdx, options.path || '/');
      return reqId;
    },
    abort(reqId: number) {
      const r = requests.get(reqId);
      if (r) r.aborted = true;
      callbacks.onAborted(reqId);
    },
    drain(reqId: number) {
      const r = requests.get(reqId);
      if (r) r.backpressure = false;
      callbacks.onWritable(reqId);
    },
  };

  return engine;
}

function createServer(options: any = {}) {
  const engine = createFakeEngine();
  const server = new MoroEngineServer({ engineModule: engine, ...options });
  return { engine, server };
}

describe('MoroEngineServer (fake engine)', () => {
  describe('construction', () => {
    it('rejects a module without the Moro-shaped serve()/respond() API', () => {
      expect(() => new MoroEngineServer({ engineModule: { App: () => ({}) } })).toThrow(
        /serve\/respond/
      );
    });

    it('registers callbacks via serve() with the larger body limit', () => {
      const { engine } = createServer({ maxBodySize: 1024, maxUploadSize: 2048 });
      expect(engine.serveOptions).toEqual({ maxBodySize: 2048, reusePort: false });
    });
  });

  describe('route dispatch', () => {
    it('dispatches to the router handler and responds in one respond() call', async () => {
      const { engine, server } = createServer();
      let seen: any = null;
      server.setRouterHandler((req, res) => {
        seen = { method: req.method, path: req.path, url: req.url, query: req.query };
        res.json({ success: true, data: 'world' });
        return true;
      });

      const reqId = engine.simulate({ path: '/hello', query: 'a=1&b=two' });
      await tick();

      expect(seen.method).toBe('GET');
      expect(seen.path).toBe('/hello');
      expect(seen.url).toBe('/hello?a=1&b=two');
      expect(seen.query).toEqual({ a: '1', b: 'two' });

      const r = engine.requests.get(reqId);
      expect(r.ops).toHaveLength(1);
      expect(r.ops[0].type).toBe('respond');
      expect(r.ops[0].status).toBe(200);
      expect(r.ops[0].body).toBe('{"success":true,"data":"world"}');
      expect(foldFlat(r.ops[0].headersFlat)['content-type']).toEqual(['application/json']);
    });

    it('exposes lazy request properties (headers, cookies, ip, requestId)', async () => {
      const { engine, server } = createServer();
      let seen: any = null;
      server.setRouterHandler((req, res) => {
        seen = {
          headers: req.headers,
          cookies: req.cookies,
          ip: req.ip,
          custom: req.get('X-Custom'),
          host: req.hostname,
        };
        res.json({ success: true, data: null });
        return true;
      });

      engine.simulate({
        path: '/props',
        headers: { Host: 'moro.dev:3000', 'X-Custom': 'yes', Cookie: 'sid=abc123; theme=dark' },
        remoteAddress: '10.0.0.9',
      });
      await tick();

      expect(seen.headers).toEqual({
        host: 'moro.dev:3000',
        'x-custom': 'yes',
        cookie: 'sid=abc123; theme=dark',
      });
      expect(seen.cookies).toEqual({ sid: 'abc123', theme: 'dark' });
      expect(seen.ip).toBe('10.0.0.9');
      expect(seen.custom).toBe('yes');
      expect(seen.host).toBe('moro.dev');
    });

    it('runs global middleware before the router and merges its headers', async () => {
      const { engine, server } = createServer();
      const order: string[] = [];
      server.use((req, res, next) => {
        order.push('mw');
        res.setHeader('X-MW', 'ran');
        next();
      });
      server.setRouterHandler((req, res) => {
        order.push('route');
        res.json({ success: true, data: 1 });
        return true;
      });

      const reqId = engine.simulate({ path: '/mw' });
      await tick();

      expect(order).toEqual(['mw', 'route']);
      const headers = foldFlat(engine.requests.get(reqId).ops[0].headersFlat);
      expect(headers['x-mw']).toEqual(['ran']);
    });

    it('middleware that responds short-circuits the router', async () => {
      const { engine, server } = createServer();
      let routed = false;
      server.use((req, res, _next) => {
        res.status(403).json({ success: false, error: 'nope' });
      });
      server.setRouterHandler(() => {
        routed = true;
        return true;
      });

      const reqId = engine.simulate({ path: '/blocked' });
      await tick();

      expect(routed).toBe(false);
      const r = engine.requests.get(reqId);
      expect(r.ops).toHaveLength(1);
      expect(r.ops[0].status).toBe(403);
    });
  });

  describe('json fast path', () => {
    it.each([
      [{ success: true, data: { a: 1 } }, '{"success":true,"data":{"a":1}}'],
      [{ success: false, error: 'boom' }, '{"success":false,"error":"boom"}'],
      [{ success: true, data: [1, 2], total: 2 }, '{"success":true,"data":[1,2],"total":2}'],
      [{ success: true, data: 'x', error: null }, '{"success":true,"data":"x","error":null}'],
    ])('serializes %j via the fast path', async (payload, expected) => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        res.json(payload);
        return true;
      });
      const reqId = engine.simulate({});
      await tick();
      expect(engine.requests.get(reqId).ops[0].body).toBe(expected);
    });
  });

  describe('headers flat array', () => {
    it('flattens set headers only, with multi-value set-cookie as separate pairs', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        res.setHeader('X-One', '1');
        res.cookie('a', '1', { httpOnly: true });
        res.cookie('b', '2');
        res.status(201).json({ success: true, data: null });
        return true;
      });

      const reqId = engine.simulate({});
      await tick();

      const op = engine.requests.get(reqId).ops[0];
      expect(op.status).toBe(201);
      // Flat pairs: even length, lowercased keys
      expect(op.headersFlat.length % 2).toBe(0);
      const headers = foldFlat(op.headersFlat);
      expect(headers['x-one']).toEqual(['1']);
      // Path defaults to '/' (Express behavior) so clearCookie() reliably
      // clears cookies regardless of the route that set them
      expect(headers['set-cookie']).toEqual(['a=1; HttpOnly; Path=/', 'b=2; Path=/']);
      expect(headers['content-type']).toEqual(['application/json']);
      expect(Object.keys(headers)).toHaveLength(3);
    });

    it('passes null when no headers were set', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        // end() does not sniff a Content-Type (unlike send()), so with no
        // headers set the engine receives a null header block.
        res.end('raw');
        return true;
      });
      const reqId = engine.simulate({});
      await tick();
      expect(engine.requests.get(reqId).ops[0].headersFlat).toBeNull();
    });
  });

  describe('streaming', () => {
    it('maps writeHead/write/end to the engine streaming API in order', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('chunk1;');
        res.write('chunk2;');
        res.end('done');
        return true;
      });

      const reqId = engine.simulate({ path: '/stream' });
      await tick();

      const ops = engine.requests.get(reqId).ops;
      expect(ops.map((o: any) => o.type)).toEqual(['writeHead', 'write', 'write', 'end']);
      expect(ops[0].status).toBe(200);
      expect(foldFlat(ops[0].headersFlat)['content-type']).toEqual(['text/plain']);
      expect(ops[1].chunk).toBe('chunk1;');
      expect(ops[2].chunk).toBe('chunk2;');
      expect(ops[3].chunk).toBe('done');
    });

    it('write() flushes the head first when writeHead was skipped', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        res.status(206).setHeader('Content-Type', 'text/plain');
        res.write('partial');
        res.end();
        return true;
      });

      const reqId = engine.simulate({});
      await tick();

      const ops = engine.requests.get(reqId).ops;
      expect(ops.map((o: any) => o.type)).toEqual(['writeHead', 'write', 'end']);
      expect(ops[0].status).toBe(206);
      expect(ops[2].chunk).toBeUndefined();
    });

    it("surfaces backpressure and emits 'drain' on onWritable", async () => {
      const { engine, server } = createServer();
      let res: any = null;
      server.setRouterHandler((_req, rs) => {
        res = rs;
        rs.writeHead(200, { 'Content-Type': 'text/plain' });
        return true;
      });

      const reqId = engine.simulate({ backpressure: true });
      await tick();

      expect(res.write('slow')).toBe(false);
      let drained = false;
      res.on('drain', () => {
        drained = true;
      });
      engine.drain(reqId);
      expect(drained).toBe(true);
      expect(res.write('fast')).toBe(true);
      res.end();
      expect(engine.requests.get(reqId).terminal).toBe(true);
    });
  });

  describe('lifecycle events', () => {
    it("emits 'finish' then 'close' on terminal writes, and 'close' on the request", async () => {
      const { engine, server } = createServer();
      const events: string[] = [];
      let stateAtFinish: any = null;
      server.setRouterHandler((req, res) => {
        res.on('finish', () => {
          events.push('finish');
          stateAtFinish = { ended: res.writableEnded, code: res.statusCode };
        });
        res.on('close', () => events.push('close'));
        req.on('close', () => events.push('req-close'));
        res.json({ success: true, data: 'ok' });
        return true;
      });

      engine.simulate({});
      await tick();

      expect(events).toEqual(['finish', 'close', 'req-close']);
      expect(stateAtFinish).toEqual({ ended: true, code: 200 });
    });

    it("emits 'close' (not 'finish') on abort, and late writes are no-ops", async () => {
      const { engine, server } = createServer();
      const events: string[] = [];
      let res: any = null;
      server.setRouterHandler((req, rs) => {
        res = rs;
        rs.on('finish', () => events.push('finish'));
        rs.on('close', () => events.push('close'));
        req.on('aborted', () => events.push('req-aborted'));
        req.on('close', () => events.push('req-close'));
        return true; // handler holds the response open
      });

      const reqId = engine.simulate({ path: '/slow' });
      await tick();

      engine.abort(reqId);
      expect(events).toEqual(['close', 'req-aborted', 'req-close']);
      expect(res.writableEnded).toBe(true);

      // Response already aborted - the wrapper never reaches the engine
      res.json({ late: true });
      res.write('late');
      res.end('late');
      expect(engine.requests.get(reqId).ops).toHaveLength(0);
    });
  });

  describe('body parsing', () => {
    it('parses application/json bodies', async () => {
      const { engine, server } = createServer();
      let body: any = null;
      server.setRouterHandler((req, res) => {
        body = req.body;
        res.json({ success: true, data: null });
        return true;
      });

      engine.simulate({
        method: 'POST',
        path: '/json',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"moro","n":2}',
      });
      await tick();

      expect(body).toEqual({ name: 'moro', n: 2 });
    });

    it('parses urlencoded bodies', async () => {
      const { engine, server } = createServer();
      let body: any = null;
      server.setRouterHandler((req, res) => {
        body = req.body;
        res.json({ success: true, data: null });
        return true;
      });

      engine.simulate({
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'a=1&b=hello%20world',
      });
      await tick();

      expect(body).toEqual({ a: '1', b: 'hello world' });
    });

    it('parses multipart bodies via the shared parser (binary-safe)', async () => {
      const { engine, server } = createServer();
      let body: any = null;
      server.setRouterHandler((req, res) => {
        body = req.body;
        res.json({ success: true, data: null });
        return true;
      });

      const boundary = '----moroBoundary42';
      const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nmoro\r\n`),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob.bin"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        ),
        binary,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      engine.simulate({
        method: 'POST',
        path: '/upload',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: payload,
      });
      await tick();

      expect(body.fields).toEqual({ name: 'moro' });
      expect(body.files.file.filename).toBe('blob.bin');
      expect(body.files.file.size).toBe(binary.length);
      expect(Buffer.compare(body.files.file.data, binary)).toBe(0);
    });

    it('malformed JSON is rejected with 400 without dispatching (Node-path parity)', async () => {
      const { engine, server } = createServer();
      let dispatched = false;
      server.setRouterHandler((req, res) => {
        dispatched = true;
        res.json({ success: true, data: null });
        return true;
      });

      const reqId = engine.simulate({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{oops',
      });
      await tick();

      expect(dispatched).toBe(false);
      expect(engine.requests.get(reqId).ops[0].status).toBe(400);
    });

    it('responds 413 when a non-multipart body exceeds maxBodySize', async () => {
      const { engine, server } = createServer({ maxBodySize: 8 });
      let routed = false;
      server.setRouterHandler(() => {
        routed = true;
        return true;
      });

      const reqId = engine.simulate({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"tooLarge":true}',
      });
      await tick();

      expect(routed).toBe(false);
      const op = engine.requests.get(reqId).ops[0];
      expect(op.status).toBe(413);
      expect(op.body).toBe('{"success":false,"error":"Request entity too large"}');
    });
  });

  describe('fallbacks', () => {
    it('responds 404 when no router handler is set', async () => {
      const { engine } = createServer();
      const reqId = engine.simulate({ path: '/missing' });
      await tick();

      const op = engine.requests.get(reqId).ops[0];
      expect(op.type).toBe('respond');
      expect(op.status).toBe(404);
      expect(op.body).toBe('{"success":false,"error":"Not found"}');
      expect(foldFlat(op.headersFlat)['content-type']).toEqual(['application/json']);
    });

    it('responds 404 when the router does not handle the request', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler(() => false);
      const reqId = engine.simulate({ path: '/unrouted' });
      await tick();
      expect(engine.requests.get(reqId).ops[0].status).toBe(404);
    });

    it('responds 500 when the router handler throws', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler(() => {
        throw new Error('handler exploded');
      });
      const reqId = engine.simulate({});
      await tick();

      const op = engine.requests.get(reqId).ops[0];
      expect(op.status).toBe(500);
      expect(op.body).toBe('{"success":false,"error":"Internal server error"}');
    });
  });

  describe('listen/close', () => {
    it('binds through engine.listen and reports via the handle', async () => {
      const { engine, server } = createServer();
      let listened = false;
      server.listen(8085, () => {
        listened = true;
      });

      expect(listened).toBe(true);
      expect(engine.listens).toEqual([{ serverId: 42, host: '0.0.0.0', port: 8085 }]);
      const handle = server.getServer();
      expect(handle.listening).toBe(true);
      expect(handle.address()).toEqual({ address: '0.0.0.0', family: 'IPv4', port: 8085 });
      expect(server.getApp()).toBe(handle);

      await new Promise<void>(resolve => server.close(() => resolve()));
      expect(engine.closed).toBe(true);
      expect(handle.listening).toBe(false);
      expect(handle.address()).toBeNull();
    });

    it('close before listen invokes the callback without touching the engine', () => {
      const { engine, server } = createServer();
      let closed = false;
      server.close(() => {
        closed = true;
      });
      expect(closed).toBe(true);
      expect(engine.closed).toBe(false);
    });

    it('re-registers a fresh native server on listen() after close()', async () => {
      const { engine, server } = createServer();
      server.listen(8090, () => {});
      await new Promise<void>(resolve => server.close(() => resolve()));
      // A restart must serve again: the old serverId's handles are torn down.
      server.listen(8091, () => {});
      expect(engine.listens[engine.listens.length - 1]).toEqual({
        serverId: 42,
        host: '0.0.0.0',
        port: 8091,
      });
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
  });

  describe('parity fixes', () => {
    it('joins duplicate request headers like Node (comma for most, ; for cookie)', async () => {
      const { engine, server } = createServer();
      let headers: any = null;
      server.setRouterHandler((req, res) => {
        headers = req.headers;
        res.json({ success: true, data: null });
        return true;
      });
      engine.simulate({
        rawHeaders: [
          'x-forwarded-for',
          '1.1.1.1',
          'x-forwarded-for',
          '2.2.2.2',
          'cookie',
          'a=1',
          'cookie',
          'b=2',
        ],
      });
      await tick();
      expect(headers['x-forwarded-for']).toBe('1.1.1.1, 2.2.2.2');
      expect(headers['cookie']).toBe('a=1; b=2');
    });

    it('malformed JSON body is rejected 400 without reaching the handler', async () => {
      const { engine, server } = createServer();
      let dispatched = false;
      server.setRouterHandler((req, res) => {
        dispatched = true;
        res.json({ success: true, data: null });
        return true;
      });
      const reqId = engine.simulate({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      });
      await tick();
      expect(dispatched).toBe(false);
      expect(engine.requests.get(reqId).ops[0].status).toBe(400);
    });

    it('cookie() always sets Path (defaults to /) and honors expires + maxAge:0', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        res.clearCookie('session');
        res.json({ success: true, data: null });
        return true;
      });
      const reqId = engine.simulate({});
      await tick();
      const op = engine.requests.get(reqId).ops[0];
      const headers = foldFlat(op.headersFlat);
      const setCookie = headers['set-cookie'][0];
      expect(setCookie).toMatch(/session=/);
      expect(setCookie).toMatch(/Max-Age=0/);
      expect(setCookie).toMatch(/Expires=/);
      expect(setCookie).toMatch(/Path=\//);
    });

    it('sendStatus uses the code (not "OK") as the body for unknown statuses', async () => {
      const { engine, server } = createServer();
      server.setRouterHandler((req, res) => {
        res.sendStatus(422);
        return true;
      });
      const reqId = engine.simulate({});
      await tick();
      const op = engine.requests.get(reqId).ops[0];
      expect(op.status).toBe(422);
      // 422 is in STATUS_STRINGS? No - so body is the code string, never "OK"
      expect(op.body).not.toBe('OK');
    });

    it('a malformed percent-escape in a direct-route param yields the raw value, not a 500', async () => {
      const { engine, server } = createServer();
      let captured: any = null;
      server.get('/users/:id', (req: any, res: any) => {
        captured = req.params.id;
        res.json({ success: true, data: captured });
      });
      const reqId = engine.simulate({ path: '/users/%zz' });
      await tick();
      const op = engine.requests.get(reqId).ops[0];
      expect(op.status).not.toBe(500);
      expect(captured).toBe('%zz');
    });

    it('invokes the global error handler for errors thrown in middleware', async () => {
      const { engine, server } = createServer();
      let handledErr: any = null;
      server.setErrorHandler((err: any, req: any, res: any) => {
        handledErr = err;
        res.status(500).json({ success: false, error: 'custom-shape' });
      });
      server.use(() => {
        throw new Error('boom');
      });
      const reqId = engine.simulate({});
      await tick();
      expect(handledErr).toBeInstanceOf(Error);
      const op = engine.requests.get(reqId).ops[0];
      expect(JSON.stringify(op.body)).toContain('custom-shape');
    });
  });
});
