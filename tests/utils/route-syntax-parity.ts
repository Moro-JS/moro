// @ts-nocheck
// Optional parameters (':name?') and wildcards ('*', '*name') in route paths,
// exercised the same way on every server and runtime: one set of routes, one
// table of URLs, and the answer the documentation gives for each. The Node
// http server, the HTTP/2 server, the native engine and the serverless
// runtimes each run the table in their own suite.
import http from 'node:http';
import { defineModule } from '../../src/index.js';

const answer = (route: string) => (req: any) => ({ route, params: req.params });

/**
 * The routes, in the three registration forms and in a module. They are
 * registered in the order that would give the wrong answer if the order
 * decided: the wildcard before the routes under it, the optional parameter
 * before the fixed path and after the required parameter it must not replace.
 */
export async function registerSyntaxRoutes(app: any): Promise<void> {
  // A wildcard, then fixed paths and a longer wildcard under it
  app.get('/files/*', answer('/files/*'));
  app.get('/files/readme', answer('/files/readme'));
  app.get('/files/img/*', answer('/files/img/*'));
  app.get('/files/:name/meta', answer('/files/:name/meta'));

  // An optional parameter, then a fixed path it also covers
  app.get('/users/:id?', answer('/users/:id?'));
  app.get('/users/me', answer('/users/me'));

  // A required parameter keeps its path from an optional one registered later
  app.get('/accounts/:id', answer('/accounts/:id'));
  app.get('/accounts/:id?', answer('/accounts/:id?'));

  // The chainable form and the schema form
  app.get('/archive/:year?/:month?').handler(answer('/archive/:year?/:month?'));
  app.route({
    method: 'GET',
    path: '/static/:kind/*',
    handler: answer('/static/:kind/*'),
  });
  app.get('/dl/*path').handler(answer('/dl/*path'));

  // Paths that are not this syntax keep meaning their own text
  app.get('/c++', answer('/c++'));
  app.get('/glob/**', answer('/glob/**'));

  // app.use(prefix, fn) in front of a wildcard route
  await app.use('/files/private', (req: any, res: any, next: () => void) => {
    if (req.headers['x-pass'] === 'yes') return next();
    res.status(403).json({ denied: req.path });
  });

  await app.loadModule(
    defineModule({
      name: 'catalog',
      version: '1.0.0',
      routes: [
        { method: 'GET', path: '/items/:id?', handler: answer('catalog /items/:id?') },
        { method: 'GET', path: '/assets/*', handler: answer('catalog /assets/*') },
      ],
    })
  );
}

const ok = (route: string, params: Record<string, string> = {}) =>
  `200 ${route} ${JSON.stringify(params)}`;

/** URL -> answer, the same on every server and runtime. */
export const SYNTAX_CASES: Array<[url: string, answer: string]> = [
  // --- optional parameter
  ['/users', ok('/users/:id?')],
  ['/users/', ok('/users/:id?')],
  ['/users/7', ok('/users/:id?', { id: '7' })],
  ['/users/7/', ok('/users/:id?', { id: '7' })],
  ['/users/a%2Fb', ok('/users/:id?', { id: 'a/b' })],
  ['/users/me', ok('/users/me')],
  ['/users/7/8', '404'],
  ['/users//7', '404'],
  ['//users', '404'],
  ['/accounts', ok('/accounts/:id?')],
  ['/accounts/9', ok('/accounts/:id', { id: '9' })],
  ['/archive', ok('/archive/:year?/:month?')],
  ['/archive/2026', ok('/archive/:year?/:month?', { year: '2026' })],
  ['/archive/2026/11', ok('/archive/:year?/:month?', { year: '2026', month: '11' })],
  ['/archive/2026/11/17', '404'],
  // --- wildcard
  ['/files', '404'],
  ['/files/', ok('/files/*', { '*': '' })],
  ['/files/a', ok('/files/*', { '*': 'a' })],
  ['/files/a/', ok('/files/*', { '*': 'a/' })],
  ['/files/a/b.txt', ok('/files/*', { '*': 'a/b.txt' })],
  ['/files/a%2Fb/c%20d', ok('/files/*', { '*': 'a/b/c d' })],
  ['/files/%zz/x', ok('/files/*', { '*': '%zz/x' })],
  ['/files/readme', ok('/files/readme')],
  ['/files/readme/x', ok('/files/*', { '*': 'readme/x' })],
  ['/files/img', ok('/files/*', { '*': 'img' })],
  ['/files/img/', ok('/files/img/*', { '*': '' })],
  ['/files/img/logo.png', ok('/files/img/*', { '*': 'logo.png' })],
  ['/files/report/meta', ok('/files/:name/meta', { name: 'report' })],
  ['/files/report/meta/x', ok('/files/*', { '*': 'report/meta/x' })],
  ['/files//x', '404'],
  ['/files/a//b', '404'],
  ['/files/a//', '404'],
  ['/static', '404'],
  ['/static/css', '404'],
  ['/static/css/', ok('/static/:kind/*', { kind: 'css', '*': '' })],
  ['/static/css/site.css', ok('/static/:kind/*', { kind: 'css', '*': 'site.css' })],
  ['/static/css/a/b.css', ok('/static/:kind/*', { kind: 'css', '*': 'a/b.css' })],
  ['/dl/a/b', ok('/dl/*path', { path: 'a/b' })],
  // --- app.use(prefix, fn) in front of the wildcard
  ['/files/private/x', '403'],
  ['/files//private/x', '404'],
  // --- not this syntax
  ['/c++', ok('/c++')],
  ['/c', '404'],
  ['/glob/**', ok('/glob/**')],
  ['/glob/x', '404'],
  // --- module routes
  ['/api/v1.0.0/catalog/items', ok('catalog /items/:id?')],
  ['/api/v1.0.0/catalog/items/3', ok('catalog /items/:id?', { id: '3' })],
  ['/api/v1.0.0/catalog/items/3/4', '404'],
  ['/api/v1.0.0/catalog/assets', '404'],
  ['/api/v1.0.0/catalog/assets/a/b.css', ok('catalog /assets/*', { '*': 'a/b.css' })],
];

/**
 * Dot segments, for the servers that receive the path as the client wrote it
 * (the serverless runtimes hand over a path their URL parser has already
 * resolved). The router does not resolve them: the request stays inside the
 * route its text matches, and the handler gets the segments as they were sent.
 */
export const RAW_PATH_CASES: Array<[url: string, answer: string]> = [
  ['/files/../users/me', ok('/files/*', { '*': '../users/me' })],
  ['/files/a/../../users/me', ok('/files/*', { '*': 'a/../../users/me' })],
  ['/files/%2e%2e/users/me', ok('/files/*', { '*': '../users/me' })],
  ['/users/..', ok('/users/:id?', { id: '..' })],
];

/** A reply in the form the tables are written in. */
export function describeReply(status: number, body: string): string {
  if (status !== 200) return String(status);
  const parsed = JSON.parse(body);
  return `200 ${parsed.route} ${JSON.stringify(parsed.params)}`;
}

/** GET over HTTP/1.1 with the path sent exactly as given. */
export function rawGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () =>
        resolve(describeReply(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')))
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** The table as an object, for one toEqual over all of it. */
export const expectedAnswers = (cases: Array<[string, string]>): Record<string, string> =>
  Object.fromEntries(cases);

/** Every URL of `cases` through `get`, as url -> answer. */
export async function collectAnswers(
  cases: Array<[string, string]>,
  get: (url: string) => Promise<string>
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const [url] of cases) answers[url] = await get(url);
  return answers;
}
