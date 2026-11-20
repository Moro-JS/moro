// @ts-nocheck
// The request and response helpers, exercised the same way on every HTTP
// server: one set of routes, one table of exchanges, and what is compared
// between servers. The Node http server's answers are the reference (they are
// what the documentation describes); the HTTP/2 suite and the cross-backend
// conformance suite each run the table against their server and compare.
import { expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

export interface HelperFiles {
  dir: string;
  smallPath: string;
  largePath: string;
  /** An HTML page, to be downloaded under a name with another extension */
  pagePath: string;
  large: Buffer;
  remove(): void;
}

/** A small text file and one large enough (300 KB) for sendFile() to stream. */
export function createHelperFiles(): HelperFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-helpers-'));
  const smallPath = path.join(dir, 'small.txt');
  const largePath = path.join(dir, 'large.bin');
  fs.writeFileSync(smallPath, 'hello file\n');
  const large = Buffer.alloc(300 * 1024);
  for (let i = 0; i < large.length; i++) large[i] = i % 251;
  fs.writeFileSync(largePath, large);
  const pagePath = path.join(dir, 'page.html');
  fs.writeFileSync(pagePath, '<p>page</p>\n');
  fs.writeFileSync(path.join(dir, '.hidden.txt'), 'hidden\n');
  // A directory to confine to, holding a link that points out of it
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.symlinkSync(smallPath, path.join(dir, 'sub', 'link.txt'));
  return {
    dir,
    smallPath,
    largePath,
    pagePath,
    large,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The authority every exchange is sent with unless it names its own. */
export const HOST = 'api.eu.example.com:8443';

export function registerHelpers(a: any, files: HelperFiles) {
  const { dir, smallPath, largePath, pagePath } = files;
  // --- request helpers
  a.post('/req', (req: any) => ({
    get: req.get('X-Custom'),
    header: req.header('referrer'),
    isJson: req.is('json'),
    isHtml: req.is('html'),
    accepts: req.accepts(['html', 'json']),
    language: req.acceptsLanguages(['en', 'fr']),
    host: req.headers.host,
    hostname: req.hostname,
    protocol: req.protocol,
    secure: req.secure,
    ips: req.ips,
    xhr: req.xhr,
    subdomains: req.subdomains,
    originalUrl: req.originalUrl,
    encrypted: Boolean(req.socket.encrypted),
    remoteAddress: typeof req.socket.remoteAddress,
    on: typeof req.on,
    context: req.context,
  }));
  a.get('/ipv6-host', (req: any) => ({ hostname: req.hostname }));
  a.get('/closed', (req: any, res: any) => {
    // The request's 'close' event is how a handler learns the exchange is over
    req.on('close', () => {
      a.closedRequests = (a.closedRequests ?? 0) + 1;
    });
    res.json({ listening: true });
  });

  // --- response helpers
  a.get('/send-file', (_req: any, res: any) => res.sendFile(smallPath));
  a.get('/send-file-large', (_req: any, res: any) => res.sendFile(largePath));
  a.get('/send-file-missing', (_req: any, res: any) => res.sendFile(path.join(dir, 'nope.txt')));
  a.get('/download', (_req: any, res: any) => res.download(smallPath, 'report.txt'));
  a.get('/download-unicode', (_req: any, res: any) => res.download(smallPath, '报告.txt'));
  a.get('/download-missing', (_req: any, res: any) =>
    res.download(path.join(dir, 'nope.pdf'), 'report.pdf')
  );
  a.get('/send-file-max-age', (_req: any, res: any) =>
    res.sendFile(smallPath, { maxAge: 3600, immutable: true })
  );
  a.get('/send-file-cache-control', (_req: any, res: any) =>
    res.sendFile(smallPath, { maxAge: 3600, cacheControl: 'private, max-age=60' })
  );
  a.get('/send-file-own-header', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    return res.sendFile(smallPath);
  });
  a.get('/send-file-root', (_req: any, res: any) => res.sendFile('small.txt', { root: dir }));
  a.get('/send-file-root-link', (_req: any, res: any) =>
    res.sendFile('link.txt', { root: path.join(dir, 'sub') })
  );
  a.get('/send-file-root-outside', (_req: any, res: any) =>
    res.sendFile('../small.txt', { root: path.join(dir, 'sub') })
  );
  a.get('/send-file-root-hidden', (_req: any, res: any) =>
    res.sendFile('.hidden.txt', { root: dir })
  );
  a.get('/send-file-root-hidden-denied', (_req: any, res: any) =>
    res.sendFile('.hidden.txt', { root: dir, dotfiles: 'deny' })
  );
  a.get('/send-file-root-hidden-allowed', (_req: any, res: any) =>
    res.sendFile('.hidden.txt', { root: dir, dotfiles: 'allow' })
  );
  a.get('/download-other-extension', (_req: any, res: any) => res.download(pagePath, 'report.pdf'));
  a.get('/download-options', (_req: any, res: any) => res.download(smallPath, { maxAge: 60 }));
  a.get('/attachment', (_req: any, res: any) => {
    res.attachment('summary.pdf');
    res.type('text').end('pdf-bytes');
  });
  a.get('/headers', (_req: any, res: any) => {
    res.set('X-One', '1');
    res.set({ 'X-Two': '2' });
    res.append('X-Multi', 'a');
    res.append('X-Multi', 'b');
    res.appendHeader('X-Appended', 'c');
    res.json({ got: res.get('X-One') });
  });
  a.get('/type', (_req: any, res: any) => res.type('html').send('<p>hi</p>'));
  a.get('/send-status', (_req: any, res: any) => res.sendStatus(201));
  a.get('/location', (_req: any, res: any) => res.location('/日本').status(201).end());
  a.get('/vary', (_req: any, res: any) => {
    res.vary('Accept');
    res.vary(['Origin', 'accept']);
    res.send('varied');
  });
  a.get('/format', (_req: any, res: any) =>
    res.format({
      'text/plain': () => res.send('plain'),
      'application/json': () => res.json({ kind: 'json' }),
      default: () => res.status(406).send('nope'),
    })
  );
  a.get('/links', (_req: any, res: any) =>
    res.links({ next: '/page/2', last: '/page/9' }).send('linked')
  );
  a.get('/locals', (_req: any, res: any) => {
    res.locals.user = { id: 1 };
    res.json({ locals: res.locals });
  });
  a.get('/write', (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/plain');
    res.write('one,');
    res.write(Buffer.from('two,'));
    res.end('three');
  });
  a.get('/pipe', (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/plain');
    Readable.from([Buffer.from('piped '), Buffer.from('body')]).pipe(res);
  });
  a.get('/json-undefined', (_req: any, res: any) => res.status(202).json(undefined));
  a.get('/no-content', (_req: any, res: any) => res.status(204).json({ ignored: true }));
  a.get('/redirect-unicode', (_req: any, res: any) => res.redirect('/日本?q=é'));
  // A target as it may come out of decoded user input: a NUL, an escape
  // character and a DEL, around a tab and a line break
  a.get('/redirect-control', (_req: any, res: any) =>
    res.redirect('/next\x00page?a=\x1b1\x7f&b=x\ty\r\nz')
  );
  a.get('/location-control', (_req: any, res: any) =>
    res.location('/moved\x00here').status(201).end()
  );
  a.post('/form', (req: any) => ({ body: req.body }));
  a.use((req: any, _res: any, next: (err?: unknown) => void) =>
    req.path === '/next-null' ? next(null) : next()
  );
  a.get('/next-null', () => ({ reached: true }));
  a.get('/boom', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('ETag', '"abc"');
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    throw new Error('boom');
  });
}

// Every exchange of the comparison, in order: [name, path, request options]
export const EXCHANGES: Array<[string, string, Record<string, any>]> = [
  [
    'request helpers',
    '/req?x=1&y=2',
    {
      method: 'POST',
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-custom': 'custom-value',
        referer: 'https://ref.example/page',
        accept: 'application/json',
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'x-forwarded-for': '1.1.1.1, 2.2.2.2',
        'x-requested-with': 'XMLHttpRequest',
      },
    },
  ],
  ['an IPv6 literal as the host', '/ipv6-host', { host: '[::1]:3000' }],
  ['req.on', '/closed', {}],
  ['res.sendFile', '/send-file', {}],
  ['res.sendFile of a file large enough to stream', '/send-file-large', {}],
  ['res.sendFile of a missing file', '/send-file-missing', {}],
  ['res.download', '/download', {}],
  ['res.download with a name outside Latin-1', '/download-unicode', {}],
  ['res.download of a missing file', '/download-missing', {}],
  ['res.sendFile with maxAge and immutable', '/send-file-max-age', {}],
  ['res.sendFile with a cacheControl string', '/send-file-cache-control', {}],
  ['res.sendFile after the handler set Cache-Control', '/send-file-own-header', {}],
  ['res.sendFile with a root', '/send-file-root', {}],
  ['res.sendFile with a root, link that leaves it', '/send-file-root-link', {}],
  ['res.sendFile with a root, path outside it', '/send-file-root-outside', {}],
  ['res.sendFile with a root, hidden file', '/send-file-root-hidden', {}],
  ['res.sendFile with a root, hidden file, dotfiles: deny', '/send-file-root-hidden-denied', {}],
  ['res.sendFile with a root, hidden file, dotfiles: allow', '/send-file-root-hidden-allowed', {}],
  ['res.download under a name with another extension', '/download-other-extension', {}],
  ['res.download with options in place of the name', '/download-options', {}],
  ['res.attachment', '/attachment', {}],
  ['res.set / get / append / appendHeader', '/headers', {}],
  ['res.type', '/type', {}],
  ['res.sendStatus', '/send-status', {}],
  ['res.location', '/location', {}],
  ['res.vary', '/vary', {}],
  ['res.format (json)', '/format', { headers: { accept: 'application/json' } }],
  ['res.format (text)', '/format', { headers: { accept: 'text/plain' } }],
  ['res.format (no match)', '/format', { headers: { accept: 'image/png' } }],
  ['res.links', '/links', {}],
  ['res.locals', '/locals', {}],
  ['res.write', '/write', {}],
  ['a readable piped into the response', '/pipe', {}],
  ['res.json(undefined)', '/json-undefined', {}],
  ['res.status(204).json()', '/no-content', {}],
  ['res.redirect to a target outside Latin-1', '/redirect-unicode', {}],
  ['res.redirect to a target with control characters', '/redirect-control', {}],
  ['res.location with a control character', '/location-control', {}],
  [
    'a urlencoded body with a mixed-case media type',
    '/form',
    {
      method: 'POST',
      body: 'a=1&b=two+words',
      headers: { 'content-type': 'Application/X-WWW-Form-Urlencoded' },
    },
  ],
  ['next(null) in app.use() middleware', '/next-null', {}],
  ['the default 500 after a handler set representation headers', '/boom', {}],
];

// What must be equal between the two servers. Framing headers are left
// out where the protocols differ by design (HTTP/1.1 chunked framing).
export const COMPARED_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
  'last-modified',
  'x-content-type-options',
  'location',
  'vary',
  'link',
  'x-one',
  'x-two',
  'x-multi',
  'x-appended',
  'content-encoding',
  'etag',
  'access-control-allow-origin',
];

/**
 * Headers left out of a comparison between backends, by exchange, where the
 * servers have always answered differently and both answers are in use.
 */
export const BACKEND_SPECIFIC_HEADERS: Record<string, string[]> = {};

export interface HelperReply {
  status: number;
  headers: Record<string, any>;
  body: Buffer;
  text: string;
}

/**
 * Send every exchange to the server on `port` and reduce each reply to what
 * is compared: status, the compared headers and the body. `hostHeader` is how
 * the client names the host ('host', or ':authority' on HTTP/2).
 */
export async function runHelperExchanges(
  send: (port: number, urlPath: string, options: any) => Promise<HelperReply>,
  hostHeader: string,
  port: number,
  files: HelperFiles
): Promise<Record<string, any>> {
  const seen: Record<string, any> = {};
  for (const [name, urlPath, options] of EXCHANGES) {
    const { host = HOST, ...rest } = options;
    const res = await send(port, urlPath, {
      ...rest,
      headers: { ...rest.headers, [hostHeader]: host },
    });
    const headers: Record<string, unknown> = {};
    for (const header of COMPARED_HEADERS) headers[header] = res.headers[header];
    seen[name] = {
      status: res.status,
      headers,
      // A long binary body is compared by size and content, not printed
      body:
        res.body.length > 4096 ? `${res.body.length}:${res.body.equals(files.large)}` : res.text,
    };
  }
  return seen;
}

/** The reference answers: what the documentation says each helper does. */
export function expectDocumentedAnswers(seen: Record<string, any>, files: HelperFiles): void {
  expect(JSON.parse(seen['request helpers'].body)).toEqual({
    get: 'custom-value',
    header: 'https://ref.example/page',
    isJson: true,
    isHtml: false,
    accepts: 'json',
    language: 'fr',
    host: HOST,
    hostname: 'api.eu.example.com',
    protocol: 'http',
    secure: false,
    ips: ['1.1.1.1', '2.2.2.2'],
    xhr: true,
    subdomains: ['eu', 'api'],
    originalUrl: '/req?x=1&y=2',
    encrypted: false,
    remoteAddress: 'string',
    on: 'function',
    context: {},
  });
  expect(JSON.parse(seen['an IPv6 literal as the host'].body)).toEqual({ hostname: '[::1]' });
  expect(JSON.parse(seen['a urlencoded body with a mixed-case media type'].body)).toEqual({
    body: { a: '1', b: 'two words' },
  });
  expect(JSON.parse(seen['next(null) in app.use() middleware'].body)).toEqual({ reached: true });
  expect(seen['res.sendFile'].body).toBe('hello file\n');
  expect(seen['res.sendFile of a file large enough to stream'].body).toBe(
    `${files.large.length}:true`
  );
  expect(seen['res.sendFile of a missing file'].status).toBe(404);
  // No cache lifetime unless the handler asks for one
  expect(seen['res.sendFile'].headers['cache-control']).toBeUndefined();
  expect(seen['res.sendFile of a file large enough to stream'].headers['cache-control']).toBe(
    undefined
  );
  expect(seen['res.download'].headers['cache-control']).toBeUndefined();
  expect(seen['res.sendFile with maxAge and immutable']).toMatchObject({
    status: 200,
    body: 'hello file\n',
    headers: { 'cache-control': 'public, max-age=3600, immutable' },
  });
  expect(seen['res.sendFile with a cacheControl string'].headers['cache-control']).toBe(
    'private, max-age=60'
  );
  expect(seen['res.sendFile after the handler set Cache-Control'].headers['cache-control']).toBe(
    'private, no-cache'
  );
  expect(seen['res.sendFile with a root']).toMatchObject({ status: 200, body: 'hello file\n' });
  expect(seen['res.sendFile with a root, link that leaves it'].status).toBe(404);
  expect(seen['res.sendFile with a root, path outside it'].status).toBe(404);
  expect(seen['res.sendFile with a root, hidden file'].status).toBe(404);
  expect(seen['res.sendFile with a root, hidden file, dotfiles: deny'].status).toBe(403);
  expect(seen['res.sendFile with a root, hidden file, dotfiles: allow']).toMatchObject({
    status: 200,
    body: 'hidden\n',
  });
  // The download name is for Content-Disposition; the type is the file's
  const renamed = seen['res.download under a name with another extension'];
  expect(renamed.status).toBe(200);
  expect(renamed.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
  expect(String(renamed.headers['content-type']).split(';')[0]).toBe('text/html');
  expect(renamed.headers['x-content-type-options']).toBe('nosniff');
  expect(seen['res.download with options in place of the name'].headers).toMatchObject({
    'content-disposition': 'attachment; filename="small.txt"',
    'cache-control': 'public, max-age=60',
  });
  expect(seen['res.download'].headers['content-disposition']).toBe(
    'attachment; filename="report.txt"'
  );
  expect(seen['res.download with a name outside Latin-1'].headers['content-disposition']).toBe(
    `attachment; filename="__.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt`
  );
  expect(seen['res.download of a missing file'].status).toBe(404);
  expect(seen['res.download of a missing file'].headers['content-disposition']).toBeUndefined();
  expect(seen['res.redirect to a target outside Latin-1']).toMatchObject({
    status: 302,
    headers: { location: '/%E6%97%A5%E6%9C%AC?q=%C3%A9' },
  });
  expect(seen['res.location'].headers['location']).toBe('/%E6%97%A5%E6%9C%AC');
  // Control characters are percent-encoded, a tab is left, CR and LF are removed
  expect(seen['res.redirect to a target with control characters']).toMatchObject({
    status: 302,
    headers: { location: '/next%00page?a=%1B1%7F&b=x\tyz' },
  });
  expect(seen['res.location with a control character']).toMatchObject({
    status: 201,
    headers: { location: '/moved%00here' },
  });
  expect(seen['res.write'].body).toBe('one,two,three');
  expect(seen['a readable piped into the response'].body).toBe('piped body');
  expect(seen['res.json(undefined)']).toMatchObject({ status: 202, body: '' });
  expect(seen['res.status(204).json()']).toMatchObject({ status: 204, body: '' });
  const failed = seen['the default 500 after a handler set representation headers'];
  expect(failed.status).toBe(500);
  expect(failed.headers).toMatchObject({
    'content-encoding': undefined,
    'cache-control': undefined,
    etag: undefined,
    'content-disposition': undefined,
    'access-control-allow-origin': '*',
  });
}
