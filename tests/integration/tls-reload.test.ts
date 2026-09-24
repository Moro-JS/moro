// @ts-nocheck
// Integration - TLS certificate rotation on a running listener:
// app.reloadTLS(material | none) and server.ssl.watch. Runs on the Node https
// server (always) and the native engine when its binary has
// capabilities.tlsReload (engine >= 1.1.8); older engine binaries skip.
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as tls from 'tls';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { closeApp, createTestPort } from '../setup.js';
import { fixture, fixturePath, httpsRequest } from '../utils/tls-client.js';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

/** SHA-256 fingerprint of the certificate a fresh handshake is shown. */
const servedFingerprint = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false },
      () => {
        const fp = socket.getPeerCertificate().fingerprint256;
        socket.destroy();
        resolve(fp);
      }
    );
    socket.on('error', reject);
  });
const fingerprintOf = (pem: string) => new crypto.X509Certificate(pem).fingerprint256;
const LOCALHOST_FP = fingerprintOf(fixture('localhost.pem'));
const ALT_FP = fingerprintOf(fixture('alt.pem'));

const waitForFingerprint = async (port: number, expected: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await servedFingerprint(port);
    if (last === expected) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  return last;
};

function suite(engine: 'node' | 'moro') {
  let app: any;
  let dir: string;
  const keyFile = () => path.join(dir, 'server.key');
  const certFile = () => path.join(dir, 'server.crt');

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'moro-tls-'));
    await fs.promises.copyFile(fixturePath('localhost.key'), keyFile());
    await fs.promises.copyFile(fixturePath('localhost.pem'), certFile());
  });

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const boot = async (extra: Record<string, any> = {}) => {
    const port = createTestPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine, ssl: { keyFile: keyFile(), certFile: certFile(), ...extra } },
    });
    app.get('/who', (req: any) => ({ secure: req.secure }));
    await listen(app, port);
    return port;
  };

  it('reloadTLS(material) serves the new certificate to new connections and keeps old ones alive', async () => {
    const port = await boot();
    expect(await servedFingerprint(port)).toBe(LOCALHOST_FP);

    // A connection that handshaked BEFORE the rotation...
    const before = tls.connect({
      host: '127.0.0.1',
      port,
      servername: 'localhost',
      rejectUnauthorized: false,
    });
    await new Promise<void>((resolve, reject) => {
      before.once('secureConnect', () => resolve());
      before.once('error', reject);
    });

    await app.reloadTLS({ keyFile: fixturePath('alt.key'), certFile: fixturePath('alt.pem') });

    // ...still serves requests on its old session afterwards
    const reply = await new Promise<string>((resolve, reject) => {
      let buf = '';
      before.on('data', c => {
        buf += c.toString();
        if (buf.includes('\r\n\r\n') && /"secure":true/.test(buf)) resolve(buf);
      });
      before.once('error', reject);
      before.write('GET /who HTTP/1.1\r\nHost: localhost\r\n\r\n');
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    before.destroy();

    // ...while a new handshake sees the new certificate
    expect(await servedFingerprint(port)).toBe(ALT_FP);
    const res = await httpsRequest(port, '/who', { rejectUnauthorized: false });
    expect(res.status).toBe(200);
    expect(res.json().secure).toBe(true);
  });

  it('reloadTLS() with no argument re-reads the configured files', async () => {
    const port = await boot();
    await fs.promises.copyFile(fixturePath('alt.key'), keyFile());
    await fs.promises.copyFile(fixturePath('alt.pem'), certFile());
    await app.reloadTLS();
    expect(await servedFingerprint(port)).toBe(ALT_FP);
  });

  it('invalid material rejects and the current certificate keeps serving', async () => {
    const port = await boot();
    await expect(app.reloadTLS({ key: 'not a pem', cert: fixture('alt.pem') })).rejects.toThrow();
    await expect(
      app.reloadTLS({ keyFile: fixturePath('localhost.key'), certFile: fixturePath('alt.pem') })
    ).rejects.toThrow(); // key/cert mismatch
    await expect(app.reloadTLS({ cert: fixture('alt.pem') })).rejects.toThrow(
      /key and a certificate/
    );
    // half-written file on disk
    await fs.promises.writeFile(keyFile(), 'garbage');
    await expect(app.reloadTLS()).rejects.toThrow();
    expect(await servedFingerprint(port)).toBe(LOCALHOST_FP);
  });

  it('server.ssl.watch reloads when the files on disk are replaced', async () => {
    const port = await boot({ watch: { debounceMs: 150 } });
    expect(await servedFingerprint(port)).toBe(LOCALHOST_FP);
    // Rotate the way an ACME client does: write new files, rename over
    await fs.promises.writeFile(path.join(dir, 'server.key.tmp'), fixture('alt.key'));
    await fs.promises.writeFile(path.join(dir, 'server.crt.tmp'), fixture('alt.pem'));
    await fs.promises.rename(path.join(dir, 'server.key.tmp'), keyFile());
    await fs.promises.rename(path.join(dir, 'server.crt.tmp'), certFile());
    expect(await waitForFingerprint(port, ALT_FP)).toBe(ALT_FP);
  });

  it('rejects on an app that was not started with TLS', async () => {
    const port = createTestPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    await listen(app, port);
    await expect(app.reloadTLS()).rejects.toThrow(/not started with TLS/);
  });
}

describe('TLS reload on the Node https server', () => suite('node'));

const engineReload = loadNativeEngine()?.capabilities?.tlsReload === true;
(engineReload ? describe : describe.skip)('TLS reload on the native engine', () => suite('moro'));
