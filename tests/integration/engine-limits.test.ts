/* eslint-disable */
// @ts-nocheck
// Integration - configurable server limits enforced over the wire on the
// native engine. Boundaries are tested at the CONFIGURED value (not just the
// default), including a raised body limit that accepts a body the default
// would reject. Node parity is checked where the limit applies to both.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const testPort = () => 12000 + Math.floor(Math.random() * 3000);
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

describeEngine('Native engine configurable limits (over the wire)', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('body over the configured bodySizeLimit is 413; at the limit is served', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', bodySizeLimit: '2kb', maxUploadSize: '2kb' },
    });
    app.post('/echo', (req: any) => ({ len: JSON.stringify(req.body ?? '').length }));
    await listen(app, port);
    const base = `http://127.0.0.1:${port}/echo`;

    const under = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(1000),
    });
    expect(under.status).toBe(200);

    const over = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(4096),
    });
    expect(over.status).toBe(413);
  });

  it('raised bodySizeLimit accepts a body larger than the 10mb default', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', bodySizeLimit: '12mb', maxUploadSize: '12mb' },
    });
    app.post('/upload', (req: any) => ({ bytes: (req.body ?? '').length }));
    await listen(app, port);

    const body = 'y'.repeat(11 * 1024 * 1024); // 11MB > default 10MB
    const res = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bytes).toBe(body.length);
  }, 30000);

  it('multipart maxFiles is enforced (413 over the limit)', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', limits: { multipart: { maxFiles: 1 } } },
    });
    app.post('/up', (req: any) => ({ ok: true, files: Object.keys(req.body?.files ?? {}).length }));
    await listen(app, port);

    const form = new FormData();
    form.append('a', new Blob(['file-a'], { type: 'text/plain' }), 'a.txt');
    form.append('b', new Blob(['file-b'], { type: 'text/plain' }), 'b.txt');
    const res = await fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: form });
    expect(res.status).toBe(413);
  });

  it('multipart within maxFiles succeeds', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', limits: { multipart: { maxFiles: 3 } } },
    });
    app.post('/up', (req: any) => ({ files: Object.keys(req.body?.files ?? {}).length }));
    await listen(app, port);

    const form = new FormData();
    form.append('a', new Blob(['aaa'], { type: 'text/plain' }), 'a.txt');
    form.append('b', new Blob(['bbb'], { type: 'text/plain' }), 'b.txt');
    const res = await fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).files).toBe(2);
  });
});
