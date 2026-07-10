/* eslint-disable */
// Test clients for the HTTPS / HTTP-2 / WSS integration suites. Global fetch
// cannot be given a custom CA without an undici dependency, so these wrap the
// node core clients with the committed test CA (tests/fixtures/tls/ca.pem)
// pre-trusted. All helpers reject on transport errors so a handshake failure
// surfaces as a test failure, not a hang.
import * as https from 'https';
import * as http2 from 'http2';
import * as fs from 'fs';
import * as path from 'path';

export const TLS_FIXTURES = path.join(__dirname, '..', 'fixtures', 'tls');

/** Read a fixture file (e.g. 'localhost.key', 'ca.pem') as a UTF-8 string. */
export function fixture(name: string): string {
  return fs.readFileSync(path.join(TLS_FIXTURES, name), 'utf8');
}

/** Path (not contents) of a fixture file, for file-path-shaped ssl config. */
export function fixturePath(name: string): string {
  return path.join(TLS_FIXTURES, name);
}

export const testCA = () => fixture('ca.pem');

export interface SimpleResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
  json: () => any;
}

/** One-shot HTTPS request trusting the test CA. */
export function httpsRequest(
  port: number,
  reqPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    host?: string;
    servername?: string;
    rejectUnauthorized?: boolean;
  } = {}
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: options.host ?? '127.0.0.1',
        servername: options.servername ?? 'localhost',
        port,
        path: reqPath,
        method: options.method ?? 'GET',
        headers: options.headers,
        ca: testCA(),
        rejectUnauthorized: options.rejectUnauthorized !== false,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
            json: () => JSON.parse(body.toString('utf8')),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * One-shot HTTP/2 request trusting the test CA. Opens a session, performs the
 * request, closes the session. Returns the response plus the session's ALPN
 * protocol so tests can assert h2 was actually negotiated.
 */
export function h2Request(
  port: number,
  reqPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {}
): Promise<SimpleResponse & { alpnProtocol?: string }> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://localhost:${port}`, {
      ca: testCA(),
    });
    session.on('error', reject);
    session.on('connect', () => {
      const alpnProtocol = (session.socket as any)?.alpnProtocol;
      const req = session.request({
        ':path': reqPath,
        ':method': options.method ?? 'GET',
        ...options.headers,
      });
      let status = 0;
      let headers: Record<string, string | string[] | undefined> = {};
      const chunks: Buffer[] = [];
      req.on('response', h => {
        status = Number(h[':status'] ?? 0);
        headers = h as any;
      });
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        session.close();
        const body = Buffer.concat(chunks);
        resolve({
          status,
          headers,
          body,
          text: body.toString('utf8'),
          json: () => JSON.parse(body.toString('utf8')),
          alpnProtocol,
        });
      });
      req.on('error', err => {
        session.close();
        reject(err);
      });
      if (options.body) req.write(options.body);
      req.end();
    });
  });
}

/**
 * Open a raw http2 session for multiplexing / settings tests. Caller closes.
 */
export function h2Session(port: number): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://localhost:${port}`, { ca: testCA() });
    session.once('error', reject);
    session.once('connect', () => resolve(session));
  });
}

/**
 * WSS client factory trusting the test CA. Uses the `ws` devDependency (the
 * global WebSocket cannot be handed a CA).
 */
export function wssConnect(
  port: number,
  wsPath = '/',
  options: { perMessageDeflate?: boolean | object; timeoutMs?: number } = {}
): Promise<import('ws').WebSocket> {
  // Lazy require keeps `ws` out of suites that never touch WSS
  const { WebSocket } = require('ws');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://localhost:${port}${wsPath}`, {
      ca: testCA(),
      perMessageDeflate: options.perMessageDeflate ?? false,
    });
    const timer = setTimeout(
      () => reject(new Error('wss connect timeout')),
      options.timeoutMs ?? 5000
    );
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
