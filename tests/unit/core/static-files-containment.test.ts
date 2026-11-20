// staticFiles - containment of directory indexes, the dotfile policy, and the
// bounds of the in-memory cache.
//
//   - a directory index is served only when the file it resolves to is inside
//     the root, however the directory is asked for (with or without the slash,
//     from disk or from the in-memory cache)
//   - the dotfile policy applies to every segment of the requested path, so
//     `/.git/config` is hidden under 'ignore' and refused under 'deny'
//   - the cache holds a file once however its path is spelt or linked, caps the
//     number of entries, and charges each entry its key and a fixed overhead
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { staticFiles, StaticCore } from '../../../src/core/middleware/built-in/static/index.js';
import type { StaticOptions } from '../../../src/core/middleware/built-in/static/core.js';

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, any> = {};
  chunks: Buffer[] = [];
  ended = false;
  headersSent = false;
  private jsonBody: any;
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor() {
    super();
    this.finished = new Promise<void>(resolve => {
      this.resolveFinished = resolve;
    });
  }

  get body(): any {
    if (this.jsonBody !== undefined) return this.jsonBody;
    return this.chunks.length ? Buffer.concat(this.chunks) : undefined;
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString();
  }

  setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(payload: any): void {
    this.jsonBody = payload;
    this.end();
  }
  send(data: any): void {
    this.end(data);
  }
  write(chunk: any): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(data?: any): void {
    if (data !== undefined) this.chunks.push(Buffer.from(data));
    this.headersSent = true;
    this.ended = true;
    this.emit('finish');
    this.emit('close');
    this.resolveFinished();
  }
}

type Handler = (req: any, res: any, next: () => void) => unknown;

async function run(mw: Handler, reqPath: string, headers: Record<string, string> = {}) {
  const res = new MockResponse();
  let nextCalled = false;
  await mw({ method: 'GET', path: reqPath, headers }, res, () => {
    nextCalled = true;
  });
  if (!nextCalled && !res.ended) await res.finished;
  return { res, nextCalled };
}

/** A StaticCore driven like the middleware drives it, with the core at hand for inspection */
function coreHandler(options: StaticOptions): { core: StaticCore; mw: Handler } {
  const core = new StaticCore(options);
  const mw: Handler = async (req, res, next) => {
    if (!(await core.handleRequest(req, res))) next();
  };
  return { core, mw };
}

/** Files held in memory / request paths remembered for them */
const heldFiles = (core: StaticCore): number => (core as any).cache.size;
const rememberedPaths = (core: StaticCore): number => (core as any).aliases.size;

/** Count calls to fs/promises functions while `body` runs */
async function countingFs<T>(
  names: Array<'realpath' | 'stat' | 'readFile'>,
  body: () => Promise<T>
): Promise<{ result: T; calls: Record<string, number> }> {
  // The namespace import is getter-only under ts-jest; the real module object
  // is what the middleware's own import reads through.
  const real = require('fs/promises') as Record<string, any>;
  const originals: Record<string, any> = {};
  const calls: Record<string, number> = {};
  for (const name of names) {
    originals[name] = real[name];
    calls[name] = 0;
    real[name] = (...args: any[]) => {
      calls[name] = (calls[name] as number) + 1;
      return originals[name].apply(real, args);
    };
  }
  try {
    return { result: await body(), calls };
  } finally {
    for (const name of names) real[name] = originals[name];
  }
}

describe('staticFiles containment and cache bounds', () => {
  let base: string;
  let root: string;

  beforeAll(async () => {
    // realpath: os.tmpdir() is a symlink on macOS
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-sec-')));
    root = path.join(base, 'public');
    await fs.mkdir(root);
    await fs.writeFile(path.join(base, 'secret.txt'), 'OUTSIDE-SECRET');

    await fs.writeFile(path.join(root, 'hello.txt'), 'hello');
    await fs.writeFile(path.join(root, 'index.html'), '<h1>root</h1>');
    await fs.writeFile(path.join(root, 'empty.txt'), '');

    // a directory whose index is a link to a file OUTSIDE the root
    await fs.mkdir(path.join(root, 'linkdir-out'));
    await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'linkdir-out', 'index.html'));
    // ...and one whose index is a link to a file inside it
    await fs.mkdir(path.join(root, 'linkdir-in'));
    await fs.symlink(path.join(root, 'hello.txt'), path.join(root, 'linkdir-in', 'index.html'));

    // hidden things
    await fs.writeFile(path.join(root, '.env'), 'ENV-SECRET');
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'config'), 'GITCONFIG-SECRET');
    await fs.mkdir(path.join(root, '.git', 'objects'));
    await fs.writeFile(path.join(root, '.git', 'objects', 'pack'), 'PACK-SECRET');
    await fs.mkdir(path.join(root, 'sub', '.cache'), { recursive: true });
    await fs.writeFile(path.join(root, 'sub', '.cache', 'data.json'), '{"hidden":true}');
    await fs.writeFile(path.join(root, 'sub', 'page.html'), '<p>page</p>');

    // .well-known is meant to be served
    await fs.mkdir(path.join(root, '.well-known', 'acme-challenge'), { recursive: true });
    await fs.writeFile(path.join(root, '.well-known', 'acme-challenge', 'token'), 'ACME-TOKEN');
    await fs.writeFile(path.join(root, '.well-known', 'security.txt'), 'Contact: sec@example');
    await fs.writeFile(path.join(root, '.well-known', '.hidden'), 'WK-HIDDEN');

    // links between hidden and ordinary names
    await fs.symlink(path.join(root, 'hello.txt'), path.join(root, '.hidden-link'));
    await fs.symlink(path.join(root, '.git', 'config'), path.join(root, 'plain-link.txt'));
    await fs.symlink(path.join(root, '.git'), path.join(root, 'plain-dir'));
    // a directory whose index is a link into a hidden directory
    await fs.mkdir(path.join(root, 'linkdir-hidden'));
    await fs.symlink(
      path.join(root, '.git', 'config'),
      path.join(root, 'linkdir-hidden', 'index.html')
    );
    // a directory whose configured index name itself starts with a dot
    await fs.mkdir(path.join(root, 'dotindex'));
    await fs.writeFile(path.join(root, 'dotindex', '.home.html'), '<p>dot index</p>');
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  describe('a root reached through a symbolic link', () => {
    // A deploy layout: current -> releases/one, switched to releases/two later
    let linked: string;
    beforeAll(async () => {
      const one = path.join(base, 'releases', 'one');
      const two = path.join(base, 'releases', 'two');
      await fs.mkdir(path.join(one, 'docs'), { recursive: true });
      await fs.mkdir(path.join(one, '.git'), { recursive: true });
      await fs.mkdir(two, { recursive: true });
      await fs.writeFile(path.join(one, 'app.js'), 'ONE');
      await fs.writeFile(path.join(one, 'docs', 'index.html'), '<p>docs</p>');
      await fs.writeFile(path.join(one, '.git', 'config'), 'GITCONFIG-SECRET');
      await fs.symlink(path.join(one, '.git', 'config'), path.join(one, 'plain-link.txt'));
      await fs.symlink(path.join(base, 'secret.txt'), path.join(one, 'escape.txt'));
      await fs.writeFile(path.join(two, 'only-two.js'), 'TWO');
      linked = path.join(base, 'current');
      await fs.symlink(one, linked);
    });

    it('serves its files and directory indexes', async () => {
      const mw = staticFiles({ root: linked });
      const file = await run(mw, '/app.js');
      expect(file.res.statusCode).toBe(200);
      expect(file.res.text).toBe('ONE');
      const index = await run(mw, '/docs/');
      expect(index.res.statusCode).toBe(200);
      expect(index.res.text).toBe('<p>docs</p>');
    });

    it('still refuses a link out of it and a link into a hidden directory', async () => {
      const mw = staticFiles({ root: linked });
      const out = await run(mw, '/escape.txt');
      expect(out.res.statusCode).toBe(403);
      expect(out.res.text).not.toContain('OUTSIDE-SECRET');
      const hidden = await run(mw, '/plain-link.txt');
      expect(hidden.res.text).not.toContain('GITCONFIG-SECRET');
    });

    it('follows the link when it is switched while the server runs', async () => {
      const mw = staticFiles({ root: linked });
      expect((await run(mw, '/app.js')).res.text).toBe('ONE');
      await fs.rm(linked);
      await fs.symlink(path.join(base, 'releases', 'two'), linked);
      const after = await run(mw, '/only-two.js');
      expect(after.res.statusCode).toBe(200);
      expect(after.res.text).toBe('TWO');
    });
  });

  describe('directory index containment', () => {
    it.each(['/linkdir-out/', '/linkdir-out'])(
      'does not serve an index linked to a file outside the root: %s',
      async reqPath => {
        const { res, nextCalled } = await run(staticFiles({ root }), reqPath);
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.text).not.toContain('OUTSIDE-SECRET');
      }
    );

    it('gives the same answer as asking for that index by name', async () => {
      const byName = await run(staticFiles({ root }), '/linkdir-out/index.html');
      expect(byName.res.statusCode).toBe(403);
    });

    it('does not serve it from the in-memory cache either', async () => {
      const mw = staticFiles({ root, cache: true });
      for (let i = 0; i < 2; i++) {
        const { res } = await run(mw, '/linkdir-out/');
        expect(res.statusCode).toBe(403);
        expect(res.text).not.toContain('OUTSIDE-SECRET');
      }
    });

    it('still serves an index that is a link to a file inside the root', async () => {
      const { res, nextCalled } = await run(staticFiles({ root }), '/linkdir-in/');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe('hello');
      // typed by the name it has in the directory
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    });

    it('still serves an ordinary directory index', async () => {
      const { res } = await run(staticFiles({ root }), '/');
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe('<h1>root</h1>');
    });
  });

  describe('dotfile policy on every path segment', () => {
    const hiddenPaths = [
      '/.env',
      '/.git/config',
      '/.git/objects/pack',
      '/sub/.cache/data.json',
      '/.well-known/.hidden',
      '/.git',
      '/.git/',
    ];

    it.each(hiddenPaths)("'ignore' (the default) falls through for %s", async reqPath => {
      const { res, nextCalled } = await run(staticFiles({ root }), reqPath);
      expect(nextCalled).toBe(true);
      expect(res.ended).toBe(false);
    });

    it.each(hiddenPaths)("'deny' answers 403 for %s", async reqPath => {
      const { res, nextCalled } = await run(staticFiles({ root, dotfiles: 'deny' }), reqPath);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.text).not.toMatch(/SECRET|hidden/);
    });

    it("'allow' serves them", async () => {
      const mw = staticFiles({ root, dotfiles: 'allow' });
      expect((await run(mw, '/.git/config')).res.text).toBe('GITCONFIG-SECRET');
      expect((await run(mw, '/.env')).res.text).toBe('ENV-SECRET');
      expect((await run(mw, '/sub/.cache/data.json')).res.text).toBe('{"hidden":true}');
    });

    it.each([
      ['/.well-known/acme-challenge/token', 'ACME-TOKEN'],
      ['/.well-known/security.txt', 'Contact: sec@example'],
    ])('always serves below .well-known: %s', async (reqPath, expected) => {
      for (const dotfiles of ['ignore', 'deny'] as const) {
        const { res, nextCalled } = await run(staticFiles({ root, dotfiles }), reqPath);
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe(expected);
      }
    });

    it('applies to the name asked for: a dot-named link to an ordinary file', async () => {
      expect((await run(staticFiles({ root }), '/.hidden-link')).nextCalled).toBe(true);
      const denied = await run(staticFiles({ root, dotfiles: 'deny' }), '/.hidden-link');
      expect(denied.res.statusCode).toBe(403);
    });

    it.each(['/plain-link.txt', '/plain-dir/config', '/linkdir-hidden/', '/linkdir-hidden'])(
      'applies to where the path resolves: %s leads into a hidden directory',
      async reqPath => {
        const ignored = await run(staticFiles({ root }), reqPath);
        expect(ignored.nextCalled).toBe(true);
        expect(ignored.res.ended).toBe(false);

        const denied = await run(staticFiles({ root, dotfiles: 'deny' }), reqPath);
        expect(denied.res.statusCode).toBe(403);
        expect(denied.res.text).not.toContain('GITCONFIG-SECRET');
      }
    );

    it('does not hide ordinary files next to hidden ones', async () => {
      const mw = staticFiles({ root });
      expect((await run(mw, '/sub/page.html')).res.text).toBe('<p>page</p>');
      expect((await run(mw, '/hello.txt')).res.text).toBe('hello');
    });

    it('still serves a configured index whose own name starts with a dot', async () => {
      const mw = staticFiles({ root, index: ['.home.html'] });
      const { res, nextCalled } = await run(mw, '/dotindex/');
      expect(nextCalled).toBe(false);
      expect(res.text).toBe('<p>dot index</p>');
    });

    it('does not count dot segments in the location of the root itself', async () => {
      const hiddenRoot = path.join(base, '.site', 'public');
      await fs.mkdir(hiddenRoot, { recursive: true });
      await fs.writeFile(path.join(hiddenRoot, 'app.js'), 'ok()');
      await fs.writeFile(path.join(hiddenRoot, '.env'), 'ENV-SECRET');
      const mw = staticFiles({ root: hiddenRoot });

      expect((await run(mw, '/app.js')).res.text).toBe('ok()');
      expect((await run(mw, '/.env')).nextCalled).toBe(true);
    });

    it('keeps hidden files out of the in-memory cache', async () => {
      const { core, mw } = coreHandler({ root, cache: true });
      try {
        for (let i = 0; i < 2; i++) {
          expect((await run(mw, '/.git/config')).nextCalled).toBe(true);
          expect((await run(mw, '/plain-link.txt')).nextCalled).toBe(true);
        }
        expect(heldFiles(core)).toBe(0);
      } finally {
        core.close();
      }
    });
  });

  describe('in-memory cache bounds', () => {
    it('holds a file once however its path is spelt', async () => {
      const { core, mw } = coreHandler({ root, cache: { watch: false } });
      try {
        const spellings = [
          '/hello.txt',
          '//hello.txt',
          '/./hello.txt',
          '/sub/../hello.txt',
          '/sub/./../hello.txt',
          '///hello.txt',
          '/linkdir-in/../hello.txt',
        ];
        const { calls } = await countingFs(['readFile'], async () => {
          for (const spelling of spellings) {
            const { res, nextCalled } = await run(mw, spelling);
            expect(nextCalled).toBe(false);
            expect(res.text).toBe('hello');
          }
        });
        expect(heldFiles(core)).toBe(1);
        // all of those spellings are one location: one remembered path
        expect(rememberedPaths(core)).toBe(1);
        expect(calls.readFile).toBe(1);
      } finally {
        core.close();
      }
    });

    it('holds a file once when it is reached through links, and reads it once', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-alias-')));
      const { core, mw } = coreHandler({ root: dir, cache: { watch: false, maxEntries: 4 } });
      try {
        await fs.writeFile(path.join(dir, 'a.txt'), 'A');
        for (let i = 0; i < 12; i++) {
          await fs.symlink(path.join(dir, 'a.txt'), path.join(dir, `l${i}.txt`));
        }
        const { calls } = await countingFs(['readFile'], async () => {
          for (let i = 0; i < 12; i++) {
            expect((await run(mw, `/l${i}.txt`)).res.text).toBe('A');
          }
        });
        expect(heldFiles(core)).toBe(1);
        expect(calls.readFile).toBe(1);
        // the remembered request paths are bounded by the same cap
        expect(rememberedPaths(core)).toBeLessThanOrEqual(4);
        // a path that was dropped from the table is still served
        expect((await run(mw, '/l0.txt')).res.text).toBe('A');
      } finally {
        core.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('caps the number of files held (maxEntries)', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-cap-')));
      const { core, mw } = coreHandler({ root: dir, cache: { watch: false, maxEntries: 3 } });
      try {
        for (let i = 0; i < 8; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), `file ${i}`);
        for (let i = 0; i < 8; i++) {
          expect((await run(mw, `/f${i}.txt`)).res.text).toBe(`file ${i}`);
        }
        expect(heldFiles(core)).toBe(3);
        // evicted files are still served, from disk
        expect((await run(mw, '/f0.txt')).res.text).toBe('file 0');
      } finally {
        core.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('charges an entry its key and a fixed overhead, so empty files are not free', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-zero-')));
      const { core, mw } = coreHandler({ root: dir, cache: { watch: false, maxBytes: 4096 } });
      try {
        for (let i = 0; i < 40; i++) await fs.writeFile(path.join(dir, `z${i}.txt`), '');
        for (let i = 0; i < 40; i++) {
          const { res, nextCalled } = await run(mw, `/z${i}.txt`);
          expect(nextCalled).toBe(false);
          expect(res.statusCode).toBe(200);
        }
        // 40 empty bodies fit any byte budget; 40 entries do not fit 4 KiB
        expect(heldFiles(core)).toBeLessThan(10);
        expect(heldFiles(core)).toBeGreaterThan(0);
        expect((core as any).cacheBytes).toBeLessThanOrEqual(4096);
      } finally {
        core.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults to 10,000 entries', () => {
      const core = new StaticCore({ root, cache: true });
      expect((core as any).cacheMaxEntries).toBe(10000);
      core.close();
    });

    it('answers a repeated request without touching the disk', async () => {
      const { core, mw } = coreHandler({ root, cache: { watch: false, revalidateMs: 60_000 } });
      try {
        await run(mw, '/hello.txt');
        await run(mw, '/linkdir-in/');
        const { calls } = await countingFs(['realpath', 'stat', 'readFile'], async () => {
          expect((await run(mw, '/hello.txt')).res.text).toBe('hello');
          expect((await run(mw, '/linkdir-in/')).res.text).toBe('hello');
        });
        expect(calls).toEqual({ realpath: 0, stat: 0, readFile: 0 });
      } finally {
        core.close();
      }
    });

    it('still notices a replaced file reached through two spellings', async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-repl-')));
      const { core, mw } = coreHandler({ root: dir, cache: { watch: false, revalidateMs: 0 } });
      try {
        await fs.writeFile(path.join(dir, 'v.txt'), 'one');
        expect((await run(mw, '/v.txt')).res.text).toBe('one');
        expect((await run(mw, '//v.txt')).res.text).toBe('one');
        await fs.writeFile(path.join(dir, 'v.txt'), 'two!');
        expect((await run(mw, '//v.txt')).res.text).toBe('two!');
        expect((await run(mw, '/v.txt')).res.text).toBe('two!');
        expect(heldFiles(core)).toBe(1);
      } finally {
        core.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
