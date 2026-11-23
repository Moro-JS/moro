// What a request is told when no route of its own answers it, on each server:
//
// - a HEAD is answered from the GET route (RFC 9110 §9.3.2): the GET's status
//   and header fields, Content-Length included, and no body;
// - `OPTIONS *` is a 204 with `Allow` (RFC 9110 §9.3.7);
// - a method no route can be registered for is a 501, not a 404 (the native
//   engine hands such a request over; Node's parser refuses it first).
import { describe, it, expect, afterEach } from '@jest/globals';
import net from 'node:net';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';

type Backend = 'node' | 'moro';
const BACKENDS: Backend[] = engineLoadable ? ['node', 'moro'] : ['node'];

// One raw exchange: everything the server sends for these bytes until it has
// been quiet for a moment (a HEAD reply has a Content-Length and no body, so
// an HTTP client's own framing cannot be what decides where it ends).
function raw(port: number, request: string, quietMs = 150): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      socket.destroy();
      resolve(data);
    };
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      data += chunk.toString('latin1');
      if (timer) clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    socket.on('end', done);
    socket.on('error', reject);
    setTimeout(done, 2000);
  });
}

function parse(reply: string) {
  const split = reply.indexOf('\r\n\r\n');
  const head = split < 0 ? reply : reply.slice(0, split);
  const lines = head.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number(lines[0].split(' ')[1]),
    headers,
    body: split < 0 ? '' : reply.slice(split + 4),
  };
}

const get = (path: string, method = 'GET') => `${method} ${path} HTTP/1.1\r\nHost: t\r\n\r\n`;

describe.each(BACKENDS)('requests without a route of their own on the %s backend', backend => {
  let app: any;
  let port: number;

  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    resetConfig();
  });

  async function start(define: (app: any) => void | Promise<void>) {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      server: { engine: backend, requestLogging: { enabled: false } },
    });
    await define(app);
    port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
  }

  it('a HEAD gets the status and headers of the GET route, and no body', async () => {
    const seen: string[] = [];
    await start(a => {
      a.get('/text', (req: any, res: any) => {
        seen.push(req.method);
        res.send('hello world');
      });
      a.get('/json', () => ({ ok: true, n: 42 }));
      a.get('/user/:id', (req: any) => ({ id: req.params.id }));
      a.get('/literal', 'build 1.2.3');
      a.get('/teapot', (_req: any, res: any) => res.status(418).json({ error: 'teapot' }));
      a.get('/guarded')
        .before((req: any, res: any, next: () => void) => {
          res.setHeader('X-Guard', req.method);
          next();
        })
        .handler(() => ({ guarded: true }));
    });

    for (const path of ['/text', '/json', '/user/7', '/literal', '/teapot', '/guarded']) {
      const viaGet = parse(await raw(port, get(path)));
      const viaHead = parse(await raw(port, get(path, 'HEAD')));
      expect(`${path} ${viaHead.status}`).toBe(`${path} ${viaGet.status}`);
      expect(viaHead.body).toBe('');
      expect(viaGet.body.length).toBeGreaterThan(0);
      expect(viaHead.headers['content-type']).toBe(viaGet.headers['content-type']);
      expect(viaHead.headers['content-length']).toBe(
        String(Buffer.byteLength(viaGet.body, 'latin1'))
      );
    }
    // The handler runs for the HEAD and can tell.
    expect(seen).toEqual(['GET', 'HEAD']);
    // Route middleware ran too, and saw the method the client sent.
    expect(parse(await raw(port, get('/guarded', 'HEAD'))).headers['x-guard']).toBe('HEAD');
  });

  it('a route registered for HEAD is the one that answers it', async () => {
    await start(a => {
      a.get('/thing', () => ({ from: 'get' }));
      a.head('/thing', (_req: any, res: any) => {
        res.setHeader('X-From', 'head');
        res.status(200).end();
      });
    });
    const reply = parse(await raw(port, get('/thing', 'HEAD')));
    expect(reply.status).toBe(200);
    expect(reply.headers['x-from']).toBe('head');
    expect(reply.body).toBe('');
  });

  it('a HEAD the connection keeps going after: the next response starts where the headers ended', async () => {
    await start(a => {
      a.get('/a', (_req: any, res: any) => res.send('aaaaaaaaaa'));
      a.get('/b', (_req: any, res: any) => res.send('b'));
    });
    const both = await raw(port, get('/a', 'HEAD') + get('/b'));
    const second = both.indexOf('HTTP/1.1', 8);
    expect(second).toBeGreaterThan(0);
    expect(parse(both.slice(0, second)).headers['content-length']).toBe('10');
    expect(both.slice(0, second).endsWith('\r\n\r\n')).toBe(true);
    expect(parse(both.slice(second)).body).toBe('b');
  });

  it('a HEAD or GET with no route at all is a 404; a POST to a GET route is still a 404', async () => {
    await start(a => {
      a.get('/only-get', () => ({ ok: true }));
      a.post('/only-post', () => ({ ok: true }));
    });
    expect(parse(await raw(port, get('/missing', 'HEAD'))).status).toBe(404);
    expect(parse(await raw(port, get('/missing'))).status).toBe(404);
    expect(parse(await raw(port, get('/only-post', 'HEAD'))).status).toBe(404);
    expect(
      parse(await raw(port, 'POST /only-get HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n'))
        .status
    ).toBe(404);
  });

  it('OPTIONS * is a 204 that lists the methods routes can be registered for', async () => {
    await start(a => {
      a.get('/x', () => ({ ok: true }));
    });
    const reply = parse(await raw(port, get('*', 'OPTIONS')));
    expect(reply.status).toBe(204);
    expect(reply.headers.allow).toBe('GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS');
    expect(reply.body).toBe('');
    // An OPTIONS for a path keeps its own answer.
    expect(parse(await raw(port, get('/x', 'OPTIONS'))).status).toBe(404);
  });

  it('middleware that answers OPTIONS * or an unusual method itself still does', async () => {
    await start(async a => {
      await a.use((req: any, res: any, next: () => void) => {
        if (req.method === 'OPTIONS' && req.path === '*') {
          res.setHeader('Allow', 'GET');
          res.status(200).end();
          return;
        }
        if (req.method === 'PURGE') {
          res.status(202).json({ purged: req.path });
          return;
        }
        next();
      });
    });
    const star = parse(await raw(port, get('*', 'OPTIONS')));
    expect(star.status).toBe(200);
    expect(star.headers.allow).toBe('GET');
    if (backend === 'moro') {
      // Node's parser knows PURGE as well, but leave the Node server's list to Node.
      const purge = parse(await raw(port, get('/cache/1', 'PURGE')));
      expect(purge.status).toBe(202);
      expect(JSON.parse(purge.body)).toEqual({ purged: '/cache/1' });
    }
  });

  if (backend === 'moro') {
    it('a method no route can be registered for is a 501, and the connection stays usable', async () => {
      await start(a => {
        a.get('/x', (_req: any, res: any) => res.send('x'));
      });
      for (const method of ['FOOBAR', 'TRACE', 'PROPFIND', 'CONNECT']) {
        const reply = parse(await raw(port, get('/x', method)));
        expect(`${method} ${reply.status}`).toBe(`${method} 501`);
        expect(JSON.parse(reply.body)).toEqual({ success: false, error: 'Not implemented' });
      }
      const both = await raw(port, get('/x', 'FOOBAR') + get('/x'));
      expect(both.match(/HTTP\/1\.1 (\d+)/g)).toEqual(['HTTP/1.1 501', 'HTTP/1.1 200']);
    });
  }
});
