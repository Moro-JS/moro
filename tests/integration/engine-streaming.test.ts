/* eslint-disable */
// @ts-nocheck
// Integration Tests - native engine path: streaming (writeHead/write/end),
// response lifecycle events ('finish'/'close') and client-abort handling.
// Skipped automatically when no native engine binary exists for this Node ABI
// (the Node http server covers those platforms and has its own suites).
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

// Ports above 10080 avoid the WHATWG fetch bad-port blocklist entirely
const testPort = () => 10100 + Math.floor(Math.random() * 5000);

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

describeEngine('Native engine streaming & lifecycle events', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('boots on the native engine', async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    expect(app.engine.server).toBe('engine');
  });

  it('serves plain JSON routes (baseline)', async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/hello', (req: any, res: any) => ({ success: true, data: 'world' }));
    const port = testPort();
    await listen(app, port);

    const response = await fetch(`http://localhost:${port}/hello`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: 'world' });
  });

  it('streams chunks via writeHead + write + end', async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/stream', (req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('chunk1;');
      res.write('chunk2;');
      res.end('done');
    });
    const port = testPort();
    await listen(app, port);

    const response = await fetch(`http://localhost:${port}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(await response.text()).toBe('chunk1;chunk2;done');
  });

  it("emits 'finish' and 'close' on normal completion", async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    const events: string[] = [];
    let stateAtFinish: any = null;
    app.get('/events', (req: any, res: any) => {
      res.on('finish', () => {
        events.push('finish');
        stateAtFinish = { ended: res.writableEnded, code: res.statusCode };
      });
      res.on('close', () => events.push('close'));
      res.json({ ok: true });
    });
    const port = testPort();
    await listen(app, port);

    await fetch(`http://localhost:${port}/events`);
    expect(events).toEqual(['finish', 'close']);
    expect(stateAtFinish).toEqual({ ended: true, code: 200 });
  });

  it("request logging middleware sees 'finish' (res.on wiring)", async () => {
    // requestLogging uses res.on('finish') internally - previously a no-op
    // stub on this path. Assert the event machinery it depends on works for
    // middleware-registered listeners.
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    let sawFinish = false;
    app.use((req: any, res: any, next: any) => {
      res.on('finish', () => {
        sawFinish = true;
      });
      next();
    });
    app.get('/logged', () => ({ success: true }));
    const port = testPort();
    await listen(app, port);

    const response = await fetch(`http://localhost:${port}/logged`);
    expect(response.status).toBe(200);
    // finish fires synchronously with the terminal write on this path
    expect(sawFinish).toBe(true);
  });

  it('parses multipart uploads into fields and files (binary-safe)', async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    let received: any = null;
    app.post('/upload', (req: any, res: any) => {
      received = req.body;
      res.json({
        success: true,
        fields: req.body?.fields,
        size: req.body?.files?.file?.size,
      });
    });
    const port = testPort();
    await listen(app, port);

    // Binary payload including null bytes and high bytes - a stringified
    // parse corrupts these
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    const form = new FormData();
    form.append('name', 'moro');
    form.append('file', new Blob([binary], { type: 'application/octet-stream' }), 'blob.bin');

    const response = await fetch(`http://localhost:${port}/upload`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.fields).toEqual({ name: 'moro' });
    expect(result.size).toBe(binary.length);
    expect(Buffer.compare(received.files.file.data, binary)).toBe(0);
    expect(received.files.file.filename).toBe('blob.bin');
  });

  it("emits 'close' (not 'finish') on client abort", async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    const events: string[] = [];
    let sawReqClose = false;
    let release: () => void;
    const aborted = new Promise<void>(resolve => (release = resolve));

    app.get('/slow', async (req: any, res: any) => {
      res.on('finish', () => events.push('finish'));
      res.on('close', () => {
        events.push('close');
        release();
      });
      req.on('close', () => {
        sawReqClose = true;
      });
      await aborted;
      // Response already aborted; writes are no-ops
      res.json({ late: true });
    });
    const port = testPort();
    await listen(app, port);

    const controller = new AbortController();
    const pending = fetch(`http://localhost:${port}/slow`, { signal: controller.signal });
    // Give the request time to reach the handler, then abort mid-flight
    await new Promise(r => setTimeout(r, 100));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await aborted;

    expect(events).toEqual(['close']);
    expect(sawReqClose).toBe(true);
  });

  it('res.send defaults a Content-Type (node parity)', async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/text', (req: any, res: any) => res.send('hello world'));
    app.get('/jsonstr', (req: any, res: any) => res.send('{"a":1}'));
    const port = testPort();
    await listen(app, port);

    const text = await fetch(`http://localhost:${port}/text`);
    expect(text.headers.get('content-type')).toContain('text/plain');
    expect(await text.text()).toBe('hello world');

    const js = await fetch(`http://localhost:${port}/jsonstr`);
    expect(js.headers.get('content-type')).toContain('application/json');
  });

  it('res.json produces valid JSON even with a non-boolean success field', async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/weird', (req: any, res: any) =>
      res.json({ success: 'yes', data: [1, 2], error: undefined })
    );
    const port = testPort();
    await listen(app, port);

    const r = await fetch(`http://localhost:${port}/weird`);
    expect(r.status).toBe(200);
    // Must be parseable (the fast path would have emitted {"success":yes,...})
    const body = await r.json();
    expect(body.success).toBe('yes');
    expect(body.data).toEqual([1, 2]);
  });
});
