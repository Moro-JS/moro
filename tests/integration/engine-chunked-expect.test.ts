/* eslint-disable */
// @ts-nocheck
// Integration - the native engine handles chunked request bodies and
// Expect: 100-continue over the wire (previously untested). Raw sockets are
// used for exact framing control.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import * as net from 'net';

const testPort = () => 13500 + Math.floor(Math.random() * 3000);
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// Send raw bytes, collect the full response text (until the socket goes quiet).
function rawExchange(port: number, requestBytes: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(requestBytes));
    let buf = '';
    let quiet: NodeJS.Timeout | null = null;
    sock.on('data', d => {
      buf += d.toString('latin1');
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => {
        sock.destroy();
        resolve(buf);
      }, 150);
    });
    sock.on('error', reject);
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      buf ? resolve(buf) : reject(new Error('no response'));
    });
  });
}

describeEngine('Native engine chunked bodies + Expect: 100-continue', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('decodes a chunked request body', async () => {
    const port = testPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.post('/echo', (req: any) => ({ got: req.body }));
    await listen(app, port);

    // "Hello, " + "world!" as two chunks.
    const req =
      'POST /echo HTTP/1.1\r\nHost: t\r\nContent-Type: text/plain\r\n' +
      'Transfer-Encoding: chunked\r\n\r\n' +
      '7\r\nHello, \r\n6\r\nworld!\r\n0\r\n\r\n';
    const res = await rawExchange(port, req);
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    const bodyStart = res.indexOf('\r\n\r\n') + 4;
    const jsonText = res
      .slice(bodyStart)
      .replace(/^[0-9a-fA-F]+\r\n/, '')
      .split('\r\n')[0];
    expect(jsonText).toContain('Hello, world!');
  });

  it('answers Expect: 100-continue with an interim 100 then the final response', async () => {
    const port = testPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.post('/upload', (req: any) => ({ received: req.body }));
    await listen(app, port);

    // Send headers with Expect, then the body, in one write (the engine still
    // emits the interim 100 before reading the body).
    const body = 'payload-data';
    const req =
      `POST /upload HTTP/1.1\r\nHost: t\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${body.length}\r\nExpect: 100-continue\r\n\r\n${body}`;
    const res = await rawExchange(port, req);
    expect(res).toMatch(/HTTP\/1\.1 100 Continue/);
    expect(res).toMatch(/HTTP\/1\.1 200/);
    expect(res).toContain('payload-data');
  });
});
