// Unit tests - built-in view template engine (middleware.template, engine 'moro').
//
// Two things are pinned here:
//  1. Golden output: well-formed templates render, byte for byte, what the
//     reference renderer kept in this file produces.
//  2. Inert values: a substituted value is never read as template syntax, and
//     a rendered page is inserted into its layout verbatim.
//  3. The `engine` option: it selects nothing, and says so once.
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TemplateCore } from '../../../src/core/middleware/built-in/template/index.js';
import {
  compileTemplate,
  renderCompiledTemplate,
} from '../../../src/core/middleware/built-in/template/core.js';

let views: string;
let counter = 0;

beforeAll(async () => {
  views = await fs.mkdtemp(path.join(os.tmpdir(), 'moro-template-'));
  await fs.mkdir(path.join(views, 'layouts'));
});

afterAll(async () => {
  await fs.rm(views, { recursive: true, force: true });
});

interface Rendered {
  status: number;
  body: string;
  json: unknown;
  headers: Record<string, string>;
}

/** Render `source` through the real res.render() the middleware installs. */
async function render(source: string, data?: unknown, layout?: string): Promise<Rendered> {
  const name = `t${++counter}`;
  await fs.writeFile(path.join(views, `${name}.html`), source);
  let layoutName: string | undefined;
  if (layout !== undefined) {
    layoutName = `l${counter}`;
    await fs.writeFile(path.join(views, 'layouts', `${layoutName}.html`), layout);
  }
  const core = new TemplateCore({
    views,
    cache: false,
    ...(layoutName !== undefined ? { defaultLayout: layoutName } : {}),
  });
  const out: Rendered = { status: 200, body: '', json: undefined, headers: {} };
  const res: any = {
    setHeader(key: string, value: string) {
      out.headers[key.toLowerCase()] = value;
    },
    end(chunk: string) {
      out.body = chunk;
    },
    status(code: number) {
      out.status = code;
      return res;
    },
    json(payload: unknown) {
      out.json = payload;
    },
  };
  core.addRenderMethod({} as any, res);
  if (data === undefined) await res.render(name);
  else await res.render(name, data);
  return out;
}

const html = async (source: string, data?: unknown, layout?: string) =>
  (await render(source, data, layout)).body;

// ---------------------------------------------------------------------------
// The renderer this engine replaced, kept verbatim as an oracle. For data whose
// values contain no template syntax its output is the contract.
// ---------------------------------------------------------------------------
const LEGACY_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};
const legacyEscape = (str: string) => str.replace(/[&<>"']/g, c => LEGACY_ESCAPES[c] ?? c);
const legacyResolve = (obj: any, p: string): any =>
  !p.includes('.') ? obj?.[p] : p.split('.').reduce((o: any, k: string) => o?.[k], obj);

function legacyRender(content: string, data: any): string {
  const RAW = /\{\{\{([\w.]+)\}\}\}/g;
  const VAR = /\{\{([\w.]+)\}\}/g;
  let rendered = content;
  rendered = rendered.replace(RAW, (match: string, key: string) => {
    const value = legacyResolve(data, key);
    return value !== undefined ? String(value) : match;
  });
  rendered = rendered.replace(VAR, (match: string, key: string) => {
    const value = legacyResolve(data, key);
    return value !== undefined ? legacyEscape(String(value)) : match;
  });
  rendered = rendered.replace(
    /\{\{#each (\w+)\}\}(.*?)\{\{\/each\}\}/gs,
    (_match: string, arrayKey: string, template: string) => {
      const array = data[arrayKey];
      if (!Array.isArray(array)) return '';
      return array
        .map(item => {
          let itemTemplate = template;
          itemTemplate = itemTemplate.replace(RAW, (match: string, key: string) => {
            const value = legacyResolve(item, key);
            return value !== undefined ? String(value) : match;
          });
          itemTemplate = itemTemplate.replace(VAR, (match: string, key: string) => {
            const value = legacyResolve(item, key);
            return value !== undefined ? legacyEscape(String(value)) : match;
          });
          return itemTemplate;
        })
        .join('');
    }
  );
  rendered = rendered.replace(
    /\{\{#if (\w+)\}\}(.*?)\{\{\/if\}\}/gs,
    (_match: string, conditionKey: string, body: string) => (data[conditionKey] ? body : '')
  );
  return rendered;
}

describe('view template engine: golden output', () => {
  it('escapes {{var}} and leaves {{{var}}} raw', async () => {
    const data = { title: `Tom & "Jerry" <b>'s</b>`, trusted: '<em>hi</em>' };
    expect(await html('<h1>{{title}}</h1><div>{{{trusted}}}</div>', data)).toBe(
      '<h1>Tom &amp; &quot;Jerry&quot; &lt;b&gt;&#039;s&lt;/b&gt;</h1><div><em>hi</em></div>'
    );
  });

  it('resolves dotted paths and stringifies non-string values', async () => {
    const data = {
      user: { name: 'Ada', address: { city: 'London' } },
      count: 0,
      flag: false,
      nothing: null,
      list: [1, 2, 3],
      obj: { a: 1 },
    };
    expect(
      await html(
        '{{user.name}}|{{user.address.city}}|{{count}}|{{flag}}|{{nothing}}|{{list}}|{{obj}}|{{{user.name}}}',
        data
      )
    ).toBe('Ada|London|0|false|null|1,2,3|[object Object]|Ada');
  });

  it('leaves a tag whose path resolves to undefined in the output unchanged', async () => {
    expect(
      await html('a {{missing}} b {{{missing}}} c {{user.missing.deep}} d {{ spaced }} e', {
        user: {},
      })
    ).toBe('a {{missing}} b {{{missing}}} c {{user.missing.deep}} d {{ spaced }} e');
  });

  it('renders with no data argument', async () => {
    expect(await html('x {{a}} y')).toBe('x {{a}} y');
  });

  it('repeats an {{#each}} body per item with item fields, escaped and raw', async () => {
    const data = {
      items: [
        { name: 'A<1>', html: '<i>a</i>', meta: { n: 1 } },
        { name: 'B', html: '<i>b</i>', meta: { n: 2 } },
      ],
    };
    expect(
      await html(
        '<ul>\n{{#each items}}<li>{{name}} {{{html}}} {{meta.n}}</li>\n{{/each}}</ul>',
        data
      )
    ).toBe('<ul>\n<li>A&lt;1&gt; <i>a</i> 1</li>\n<li>B <i>b</i> 2</li>\n</ul>');
  });

  it('a loop body sees the render data first, then the item', async () => {
    const data = { site: 'S', name: 'TOP', items: [{ name: 'item1', only: 'x' }, { only: 'y' }] };
    expect(await html('{{#each items}}[{{site}}/{{name}}/{{only}}/{{gone}}]{{/each}}', data)).toBe(
      '[S/TOP/x/{{gone}}][S/TOP/y/{{gone}}]'
    );
  });

  it('a loop over a missing or non-array key renders nothing; an empty array renders nothing', async () => {
    const src = 'a{{#each items}}<li>{{name}}</li>{{/each}}b';
    expect(await html(src, {})).toBe('ab');
    expect(await html(src, { items: 'nope' })).toBe('ab');
    expect(await html(src, { items: { length: 1 } })).toBe('ab');
    expect(await html(src, { items: [] })).toBe('ab');
  });

  it('loops over primitive items and skips holes in sparse arrays', async () => {
    expect(await html('{{#each xs}}({{length}}){{/each}}', { xs: ['ab', 'cde'] })).toBe('(2)(3)');
    // eslint-disable-next-line no-sparse-arrays
    expect(await html('{{#each xs}}({{n}}){{/each}}', { xs: [{ n: 1 }, , { n: 3 }] })).toBe(
      '(1)(3)'
    );
  });

  it('{{#if}} keeps its body for truthy keys and drops it otherwise', async () => {
    const src = '<p>{{#if user}}Welcome, {{user.name}}{{/if}}</p>{{#if admin}}ADMIN{{/if}}';
    expect(await html(src, { user: { name: 'Ada' }, admin: 0 })).toBe('<p>Welcome, Ada</p>');
    expect(await html(src, { admin: 'yes' })).toBe('<p></p>ADMIN');
    expect(await html(src, { user: '', admin: [] })).toBe('<p></p>ADMIN');
  });

  it('a conditional may enclose a loop, and a loop body may hold a conditional on the render data', async () => {
    const data = { show: true, flag: 1, items: [{ n: 1 }, { n: 2 }] };
    expect(
      await html('{{#if show}}<ul>{{#each items}}<li>{{n}}</li>{{/each}}</ul>{{/if}}', data)
    ).toBe('<ul><li>1</li><li>2</li></ul>');
    expect(
      await html('{{#if show}}<ul>{{#each items}}<li>{{n}}</li>{{/each}}</ul>{{/if}}', {
        ...data,
        show: false,
      })
    ).toBe('');
    expect(await html('{{#each items}}{{n}}{{#if flag}}!{{/if}};{{/each}}', data)).toBe('1!;2!;');
    expect(
      await html('{{#each items}}{{n}}{{#if flag}}!{{/if}};{{/each}}', { ...data, flag: 0 })
    ).toBe('1;2;');
  });

  it('blocks span lines and repeat', async () => {
    const src = '{{#if a}}\nA\n{{/if}}\n{{#each xs}}\n- {{v}}\n{{/each}}\n{{#if b}}\nB\n{{/if}}\n';
    expect(await html(src, { a: 1, b: 0, xs: [{ v: 1 }, { v: 2 }] })).toBe(
      '\nA\n\n\n- 1\n\n- 2\n\n\n'
    );
  });

  it('tags that are not part of the grammar stay as text', async () => {
    const src =
      '{{#each  two}}x{{/each}} {{#each a.b}}y{{/each}} {{#unless a}}z{{/unless}} {{> part}} {{else}} {{#if a b}}';
    expect(await html(src, { two: [1], a: { b: [1] } })).toBe(
      '{{#each  two}}x{{/each}} {{#each a.b}}y{{/each}} {{#unless a}}z{{/unless}} {{> part}} {{else}} {{#if a b}}'
    );
  });

  it('sets the HTML content type', async () => {
    const out = await render('ok', {});
    expect(out.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(out.status).toBe(200);
  });

  it('inserts the page into the first {{body}} of the layout and leaves the rest of the layout alone', async () => {
    expect(
      await html(
        '<p>{{msg}}</p>',
        { msg: 'hi', title: 'T' },
        '<html><title>{{title}}</title>{{body}}|{{body}}</html>'
      )
    ).toBe('<html><title>{{title}}</title><p>hi</p>|{{body}}</html>');
  });

  it('returns the page as-is when the layout file is missing', async () => {
    const core = new TemplateCore({ views, cache: false, defaultLayout: 'does-not-exist' });
    await fs.writeFile(path.join(views, 'nolayout.html'), 'page {{x}}');
    let body = '';
    const res: any = { setHeader() {}, end: (chunk: string) => (body = chunk) };
    core.addRenderMethod({} as any, res);
    await res.render('nolayout', { x: 1 });
    expect(body).toBe('page 1');
  });

  // Every template below - including ones whose blocks are nested in ways the
  // engine does not support - must render exactly what the previous engine did.
  it('matches the previous renderer across a corpus of templates and data', async () => {
    const templates = [
      'plain text, no tags',
      '{{a}}{{b}}{{{a}}}{{{b}}}{{c.d}}{{{c.d}}}{{c.x}}{{zzz}}',
      '{{{{a}}}} {{{a}} {{a}}} {{ {a} }} {{}} {{{}}} {a} {{a.}} {{.a}} {{a..b}}',
      '{{#each xs}}{{v}},{{/each}}|{{#each ys}}{{v}}{{/each}}|{{#each nope}}{{v}}{{/each}}',
      '{{#each xs}}{{a}}:{{v}}:{{{v}}}:{{w.z}}:{{q}};{{/each}}',
      '{{#if a}}A{{/if}}{{#if zero}}Z{{/if}}{{#if xs}}X{{/if}}{{#if nope}}N{{/if}}',
      '{{#if a}}<{{#each xs}}{{v}}{{/each}}>{{/if}}{{#if zero}}<{{#each xs}}{{v}}{{/each}}>{{/if}}',
      '{{#each xs}}{{v}}{{#if a}}+{{/if}}{{#if zero}}-{{/if}}{{/each}}',
      // same-kind nesting and stray tags: unsupported, output pinned as it was
      '{{#if a}}1{{#if b}}2{{/if}}3{{/if}}4',
      '{{#if zero}}1{{#if b}}2{{/if}}3{{/if}}4',
      '{{#each xs}}[{{#each ys}}{{v}}{{/each}}]{{/each}}',
      '{{/if}}{{/each}}{{#if a}}open{{#each xs}}open',
      '{{#if a}}x{{/if}}{{/if}}{{#each xs}}y{{/each}}{{/each}}',
      '{{#each ys}}{{#if a}}{{/each}}tail{{/if}}',
      '{{#if a}}{{#each xs}}{{#if b}}{{v}}{{/if}}{{/each}}{{/if}}',
      '{{#if a}}{{#each ys}}{{#if b}}{{v}}{{/if}}{{/each}}{{/if}}',
      '{{#each xs}}{{/if}}{{v}}{{#if a}}{{/each}}',
      '{{#if a}}{{#each nope}}{{/if}}{{/each}}after{{/if}}',
      'price: $5 $& $1 {{money}} {{{money}}}',
      '<a href="/u/{{c.d}}" title=\'{{b}}\'>{{b}}</a>\n\t{{#each xs}}\n  <li class="{{v}}">{{w.z}}</li>{{/each}}\n',
    ];
    const datasets: any[] = [
      {},
      {
        a: 'A&a',
        b: '<b>',
        c: { d: 'cd' },
        zero: 0,
        money: '$9.99',
        xs: [{ v: 1, w: { z: 'z1' } }, { v: '<2>' }, { q: 'q3' }],
        ys: [],
      },
      { a: 0, b: 1, xs: [], ys: [{ v: 'y1' }, { v: 'y2' }], c: null, money: 0 },
      { a: 1, b: 0, xs: [{ v: 'only' }], ys: [{ v: 'y' }], q: 'top-q', v: 'top-v' },
      { a: true, b: true, xs: 'not-an-array', ys: [1, 'two', null, undefined, { v: 3 }] },
    ];
    for (const template of templates) {
      for (const data of datasets) {
        expect({ template, data, out: await html(template, data) }).toEqual({
          template,
          data,
          out: legacyRender(template, data),
        });
      }
    }
  });
});

describe('view template engine: substituted values are inert', () => {
  const page = 'Hello {{name}}!<ul>{{#each comments}}<li>{{text}}</li>{{/each}}</ul>';
  const base = {
    users: [{ email: 'alice@corp.example', passwordHash: '$2b$10$SECRETHASH' }],
    comments: [{ text: '<script>alert(1)</script>' }],
    adminToken: 'tok',
    secret: 'TOP-SECRET',
  };
  const list = '<ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>';

  it('a value containing {{#each …}} does not iterate the render data', async () => {
    const name = '{{#each users}}[{{email}}|{{passwordHash}}]{{/each}}';
    const out = await html(page, { ...base, name });
    expect(out).toBe(`Hello ${name}!${list}`);
    expect(out).not.toContain('alice@corp.example');
    expect(out).not.toContain('SECRETHASH');
  });

  it('a value containing {{{…}}} does not emit another value unescaped', async () => {
    const name = '{{#each comments}}{{{text}}}{{/each}}';
    const out = await html(page, { ...base, name });
    expect(out).toBe(`Hello ${name}!${list}`);
    expect(out).not.toContain('<script>');
  });

  it('a value containing {{#if …}} is not evaluated', async () => {
    const name = '{{#if adminToken}}YES{{/if}}';
    expect(await html(page, { ...base, name })).toBe(`Hello ${name}!${list}`);
  });

  it('a value containing {{…}} or {{{…}}} is not substituted, raw or escaped', async () => {
    expect(
      await html('{{a}}|{{{a}}}', { a: '{{secret}} {{{secret}}}', secret: 'TOP-SECRET' })
    ).toBe('{{secret}} {{{secret}}}|{{secret}} {{{secret}}}');
  });

  it('a raw value is emitted verbatim, tags included', async () => {
    const raw = '<b>{{secret}}</b>{{#if adminToken}}Y{{/if}}{{#each users}}{{email}}{{/each}}';
    expect(await html('[{{{raw}}}]', { ...base, raw })).toBe(`[${raw}]`);
  });

  it('item values and render-data values inside a loop body are inert', async () => {
    const data = {
      secret: 'TOP-SECRET',
      flag: true,
      title: '{{inner}} {{{inner}}}',
      rows: [
        { inner: 'ITEM-INNER', text: '{{secret}} {{{inner}}} {{#if flag}}Y{{/if}}' },
        { inner: 'x', text: '{{/each}}{{#each rows}}{{inner}}{{/each}}' },
      ],
    };
    expect(await html('{{#each rows}}<{{title}}|{{text}}|{{{text}}}>{{/each}}', data)).toBe(
      '<{{inner}} {{{inner}}}|{{secret}} {{{inner}}} {{#if flag}}Y{{/if}}|{{secret}} {{{inner}}} {{#if flag}}Y{{/if}}>' +
        '<{{inner}} {{{inner}}}|{{/each}}{{#each rows}}{{inner}}{{/each}}|{{/each}}{{#each rows}}{{inner}}{{/each}}>'
    );
  });

  it('a value cannot close or open a conditional around template content', async () => {
    const data = { show: false, v: '{{/if}}leak{{#if show}}', hidden: 'HIDDEN' };
    expect(await html('{{#if show}}{{v}}{{hidden}}{{/if}}end', data)).toBe('end');
    expect(await html('{{v}}{{#if show}}{{hidden}}{{/if}}end', data)).toBe(
      '{{/if}}leak{{#if show}}end'
    );
  });

  it('inserts $-patterns in the rendered page into the layout verbatim', async () => {
    const layout = '<header>H</header>{{body}}<footer>F</footer>';
    const name = "$& $` $' $$ $1 $<x> costs $5";
    expect(await html('<p>{{{name}}}</p>', { name }, layout)).toBe(
      `<header>H</header><p>${name}</p><footer>F</footer>`
    );
    // and from the template source itself
    expect(await html("<p>$& $$ $'</p>", {}, layout)).toBe(
      "<header>H</header><p>$& $$ $'</p><footer>F</footer>"
    );
  });

  it('a page containing {{body}} is not expanded again by the layout', async () => {
    expect(await html('{{v}}', { v: '{{body}}' }, '<main>{{body}}</main>')).toBe(
      '<main>{{body}}</main>'
    );
  });
});

describe('view template engine: compiled form', () => {
  it('tokenises once and renders repeatedly from the token stream', () => {
    const compiled = compileTemplate('{{#if on}}{{#each xs}}{{v}}{{/each}}{{/if}}{{t}}');
    expect(compiled.hasConditionals).toBe(true);
    expect(renderCompiledTemplate(compiled, { on: 1, xs: [{ v: 'a' }, { v: 'b' }], t: '!' })).toBe(
      'ab!'
    );
    expect(renderCompiledTemplate(compiled, { on: 0, xs: [{ v: 'a' }], t: '<' })).toBe('&lt;');
    expect(compileTemplate('{{a}} {{#each xs}}{{v}}{{/each}}').hasConditionals).toBe(false);
  });

  it('caches the compiled template per file and clearCache() drops it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moro-template-cache-'));
    try {
      const file = path.join(dir, 'page.html');
      await fs.writeFile(file, 'v1 {{x}}');
      const core = new TemplateCore({ views: dir });
      let body = '';
      const res: any = { setHeader() {}, end: (chunk: string) => (body = chunk) };
      core.addRenderMethod({} as any, res);
      await res.render('page', { x: 1 });
      expect(body).toBe('v1 1');
      await fs.writeFile(file, 'v2 {{x}}');
      await res.render('page', { x: 2 });
      expect(body).toBe('v1 2');
      core.clearCache();
      await res.render('page', { x: 3 });
      expect(body).toBe('v2 3');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a template name that escapes the views directory', async () => {
    const core = new TemplateCore({ views, cache: false });
    let status = 0;
    let payload: unknown;
    const res: any = {
      setHeader() {},
      end() {},
      status(code: number) {
        status = code;
        return res;
      },
      json(p: unknown) {
        payload = p;
      },
    };
    core.addRenderMethod({} as any, res);
    await res.render('../outside', {});
    expect(status).toBe(403);
    expect(payload).toEqual({ success: false, error: 'Forbidden' });
  });
});

describe('view template engine: the engine option', () => {
  const LOGGER = '../../../src/core/logger/index.js';

  // The notice is logged once per process, so each test loads its own copy of
  // the middleware core, writing to a logger double.
  async function loadCore() {
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock(LOGGER, () => ({ createFrameworkLogger: () => log }));
    try {
      let core!: typeof import('../../../src/core/middleware/built-in/template/core.js');
      await jest.isolateModulesAsync(async () => {
        core = await import('../../../src/core/middleware/built-in/template/core.js');
      });
      return {
        Core: core.TemplateCore,
        warnings: () => log.warn.mock.calls.map(call => String(call[0])),
      };
    } finally {
      jest.dontMock(LOGGER);
    }
  }

  it('says once that an engine other than the built-in one is not applied', async () => {
    const { Core, warnings } = await loadCore();

    // Nothing to say for the built-in engine, named or not
    new Core({ views });
    new Core({ views, engine: 'moro' });
    expect(warnings()).toEqual([]);

    const core = new Core({ views, engine: 'ejs', cache: false });
    new Core({ views, engine: 'handlebars' });
    new Core({ views, engine: 'ejs' });

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("middleware.template({ engine: 'ejs' })");
    expect(warnings()[0]).toContain('the engine option is not applied');
    expect(warnings()[0]).toContain('built-in engine');

    // And the built-in engine is what renders
    await fs.writeFile(path.join(views, 'named-engine.html'), '<h1>{{title}}</h1><%= title %>');
    const sent: string[] = [];
    const res: any = { setHeader() {}, end: (chunk: string) => sent.push(chunk) };
    core.addRenderMethod({} as any, res);
    await res.render('named-engine', { title: 'T' });
    expect(sent).toEqual(['<h1>T</h1><%= title %>']);
  });
});

describe('view template engine: a render that fails', () => {
  const LOGGER = '../../../src/core/logger/index.js';

  async function renderMissing(nodeEnv: string | undefined) {
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock(LOGGER, () => ({ createFrameworkLogger: () => log }));
    const before = process.env.NODE_ENV;
    try {
      let core!: typeof import('../../../src/core/middleware/built-in/template/core.js');
      await jest.isolateModulesAsync(async () => {
        core = await import('../../../src/core/middleware/built-in/template/core.js');
      });
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      const answer: { status?: number; body?: any } = {};
      const res: any = {
        setHeader() {},
        end() {},
        status(code: number) {
          answer.status = code;
          return res;
        },
        json(payload: unknown) {
          answer.body = payload;
        },
      };
      new core.TemplateCore({ views, cache: false }).addRenderMethod({} as any, res);
      await res.render('no-such-view');
      return { answer, errors: log.error.mock.calls };
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
      jest.dontMock(LOGGER);
    }
  }

  it('logs the reason, and in production tells the client only that it failed', async () => {
    const { answer, errors } = await renderMissing('production');

    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ success: false, error: 'Template rendering failed' });
    expect(JSON.stringify(answer.body)).not.toContain(views);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('Template rendering failed');
    expect(errors[0]?.[2]).toMatchObject({ template: 'no-such-view' });
    expect(String((errors[0]?.[2] as any).error)).toContain('ENOENT');
  });

  it('logs the reason outside production too, where the client also gets it', async () => {
    const { answer, errors } = await renderMissing('development');

    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe('Template rendering failed');
    expect(String(answer.body.details)).toContain('ENOENT');
    expect(errors).toHaveLength(1);
  });
});
