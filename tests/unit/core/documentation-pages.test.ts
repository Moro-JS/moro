// Generated documentation pages (the simple docs page and the Swagger UI
// shell): every value taken from route metadata or docs configuration is
// escaped for where it lands - HTML text, a quoted attribute, or the inline
// script - so it is shown as written and never read as markup or code.
// Also the middleware that serves the Swagger UI page: which paths under its
// base path it answers, and how it serves the specification and the assets.
import { describe, it, expect, afterAll, afterEach } from '@jest/globals';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SimpleDocsGenerator,
  createSimpleDocsMiddleware,
} from '../../../src/core/docs/simple-docs.js';
import { SwaggerUIMiddleware } from '../../../src/core/docs/swagger-ui.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';

const MARKUP = '<script>alert(1)</script>';
const BREAKOUT = '"><img src=x onerror=alert(1)>';

function simpleDocs(schema: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const generator = new SimpleDocsGenerator(options);
  generator.addRoutes([{ schema: { method: 'GET', path: '/items', ...schema } } as any]);
  return generator.generateHTML();
}

/** The HTML a Swagger UI middleware serves at its base path. */
function swaggerPage(options: Record<string, unknown>, basePath = '/docs'): string {
  // Built without the constructor, which needs the optional swagger-ui-dist
  // package only to locate the static assets.
  const middleware = Object.create(SwaggerUIMiddleware.prototype);
  middleware.options = {
    title: 'API Documentation',
    enableTryItOut: true,
    enableFilter: true,
    enableDeepLinking: true,
    ...options,
  };
  let body = '';
  const res = {
    setHeader: () => undefined,
    send: (html: string) => {
      body = html;
    },
  };
  middleware.createMiddleware(basePath)({ path: basePath }, res, () => undefined);
  return body;
}

/** A Swagger UI middleware over the given options, serving assets from `assetPath`. */
function swaggerMiddleware(options: Record<string, unknown> = {}, assetPath = '/nonexistent') {
  // Built without the constructor, as in swaggerPage() above
  const middleware = Object.create(SwaggerUIMiddleware.prototype);
  middleware.options = {
    title: 'API Documentation',
    enableTryItOut: true,
    enableFilter: true,
    enableDeepLinking: true,
    ...options,
  };
  middleware.openAPISpec = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {} };
  middleware.swaggerUIAssetPath = assetPath;
  return middleware;
}

interface DocsResponse {
  nextCalled: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
}

/** What a docs middleware does with a request for `path`. */
function request(
  middleware: any,
  path: string,
  headers: Record<string, string> = {},
  basePath = '/docs'
): DocsResponse {
  const result: DocsResponse = {
    nextCalled: false,
    status: 200,
    headers: {},
    body: undefined,
    ended: false,
  };
  const res = {
    set statusCode(code: number) {
      result.status = code;
    },
    setHeader: (name: string, value: string) => {
      result.headers[name.toLowerCase()] = value;
    },
    status: (code: number) => {
      result.status = code;
      return res;
    },
    send: (body: unknown) => {
      result.body = body;
      result.ended = true;
    },
    json: (body: unknown) => {
      result.body = body;
      result.ended = true;
    },
    end: () => {
      result.ended = true;
    },
  };
  middleware.createMiddleware(basePath)({ path, headers }, res, () => {
    result.nextCalled = true;
  });
  return result;
}

/** The source of the page's inline script (the one without a src attribute). */
function inlineScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('inline script not found');
  return match[1];
}

describe('simple docs page', () => {
  it('shows route metadata as text', () => {
    const html = simpleDocs({
      path: `/items/${MARKUP}`,
      description: `Lists items ${MARKUP} & more`,
      tags: [`tag${MARKUP}`],
      auth: { roles: [`admin${MARKUP}`] },
    });

    expect(html).not.toContain(MARKUP);
    expect(html).toContain('/items/&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Lists items &lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(html).toContain('<span class="tag">tag&lt;script&gt;alert(1)&lt;/script&gt;</span>');
    expect(html).toContain('<h2>Tag&lt;script&gt;alert(1)&lt;/script&gt;</h2>');
    expect(html).toContain('admin&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps a method inside its class attribute', () => {
    const html = simpleDocs({ method: `GET${BREAKOUT}` });

    expect(html).not.toContain(BREAKOUT);
    expect(html).toContain('<span class="method GET&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">');
  });

  it('escapes the configured title, description and base path', () => {
    const html = simpleDocs(
      {},
      { title: `Docs ${MARKUP}`, description: `About ${MARKUP}`, basePath: `/docs${BREAKOUT}` }
    );

    expect(html).not.toContain(MARKUP);
    expect(html).not.toContain(BREAKOUT);
    expect(html).toContain('<title>Docs &lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).toContain('<h1>Docs &lt;script&gt;alert(1)&lt;/script&gt;</h1>');
    expect(html).toContain('<p>About &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).toContain('<a href="/docs&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('writes plain metadata exactly as before', () => {
    const html = simpleDocs({
      method: 'POST',
      path: '/users/:id',
      description: 'Create a user',
      tags: ['users'],
      rateLimit: { requests: 10, window: 60000 },
    });

    expect(html).toContain('<span class="method POST">POST</span>');
    expect(html).toContain('<span class="path">/users/:id</span>');
    expect(html).toContain('<div class="description">Create a user</div>');
    expect(html).toContain('<span class="tag">users</span>');
    expect(html).toContain('<h2>Users</h2>');
    expect(html).toContain('<strong>Rate Limit:</strong> 10 requests per 60 seconds');
    expect(html).toContain('<a href="/docs" target="_blank">/docs</a>');
  });

  it('escapes the example command so the browser displays it as written', () => {
    const html = simpleDocs({ validation: { query: {} } });

    expect(html).toContain(
      '<code>curl &quot;http://localhost:3001/items?limit=10&amp;search=example&quot;</code>'
    );
  });
});

describe('Swagger UI page', () => {
  it('escapes the title and the favicon URL', () => {
    const html = swaggerPage({ title: `Docs ${MARKUP}`, favicon: `/icon.png${BREAKOUT}` });

    expect(html).toContain('<title>Docs &lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toContain(BREAKOUT);
    expect(html).toContain('href="/icon.png&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('keeps the base path inside its attributes and inside the script string', () => {
    const basePath = `/docs'</script>${BREAKOUT}`;
    const html = swaggerPage({}, basePath);

    expect(html).not.toContain(BREAKOUT);
    expect(html).toContain(
      'href="/docs&#39;&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;/swagger-ui.css"'
    );
    // The spec URL is one string literal that evaluates back to the path
    const script = inlineScript(html);
    const literal = /url: (".*"),\n/.exec(script);
    expect(literal).not.toBeNull();
    expect(JSON.parse((literal as RegExpExecArray)[1])).toBe(`${basePath}/openapi.json`);
    expect(script).toContain('SwaggerUIBundle({');
    expect(script).toContain('setTimeout(initializeSwaggerUI, 100);');
  });

  it('writes the options as literals', () => {
    const script = inlineScript(
      swaggerPage({ enableFilter: 'pets</script>', enableDeepLinking: false })
    );

    expect(script).toContain('url: "/docs/openapi.json",');
    expect(script).toContain('deepLinking: false,');
    expect(script).toContain('tryItOutEnabled: true,');
    expect(script).toContain('filter: "pets\\u003c/script\\u003e",');
  });

  it('serves an unchanged page for plain options', () => {
    const html = swaggerPage({ title: 'Orders API' });

    expect(html).toContain('<title>Orders API</title>');
    expect(html).toContain('<link rel="stylesheet" type="text/css" href="/docs/swagger-ui.css" />');
    expect(html).toContain('<script src="/docs/swagger-ui-bundle.js" charset="UTF-8"></script>');
    expect(html).toContain('filter: true,');
  });
});

describe('documentation page policies', () => {
  const digestSource = (text: string) =>
    `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  const directive = (policy: string, name: string) =>
    policy
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${name} `)) || '';

  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
  });

  it('allows the Swagger UI page its own start-up script by digest, and no other inline script or eval', () => {
    const middleware = swaggerMiddleware({
      title: 'Orders API',
      swaggerOptions: { docExpansion: 'none' },
    });
    const page = request(middleware, '/docs');
    const html = String(page.body);
    const policy = page.headers['content-security-policy'];

    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(inlineScripts).toHaveLength(1);
    expect(inlineScripts[0]).toContain('SwaggerUIBundle({');

    const scriptSrc = directive(policy, 'script-src');
    expect(scriptSrc).toBe(`script-src 'self' ${digestSource(inlineScripts[0])}`);
    expect(policy).not.toContain('unsafe-eval');
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
  });

  it('names the script it actually serves when options change the script', () => {
    const plain = request(swaggerMiddleware(), '/docs');
    const configured = request(
      swaggerMiddleware({ enableFilter: false }),
      '/api-docs',
      {},
      '/api-docs'
    );

    for (const page of [plain, configured]) {
      const script = /<script>([\s\S]*?)<\/script>/.exec(String(page.body))?.[1] as string;
      expect(page.headers['content-security-policy']).toContain(digestSource(script));
    }
    expect(directive(plain.headers['content-security-policy'], 'script-src')).not.toBe(
      directive(configured.headers['content-security-policy'], 'script-src')
    );
  });

  it('keeps customCss inside the style element', () => {
    const css = '.topbar { display: none } </style><script>alert(1)</script> </STYLE ><img src=x>';
    const html = swaggerPage({ customCss: css });

    // One style element, closed once, by the page itself
    expect(html.match(/<\/style/gi)).toHaveLength(1);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] as string;
    const outsideStyle = html.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(outsideStyle.match(/<script>/g)).toHaveLength(1);
    expect(outsideStyle).not.toContain('alert(1)');
    expect(outsideStyle).not.toContain('<img src=x>');
    expect(style).toContain('.topbar { display: none } <\\/style><script>alert(1)</script>');
    expect(style).toContain('<\\/STYLE ><img src=x>');

    // CSS without an end tag is written as given
    expect(swaggerPage({ customCss: '.a > .b::after { content: "</" }' })).toContain(
      '.a > .b::after { content: "</" }'
    );
  });

  it('does not write customJs into the page, and says so', () => {
    globalLogger.setLevel('debug');
    const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    const warnings = () => log.mock.calls.filter(c => c[0] === 'warn').map(c => String(c[1]));

    const page = request(swaggerMiddleware({ customJs: 'window.__ran = true;' }), '/docs');
    expect(String(page.body)).not.toContain('__ran');
    expect(warnings().filter(w => w.includes('customJs is not applied'))).toHaveLength(1);

    log.mockClear();
    request(swaggerMiddleware(), '/docs');
    expect(warnings().filter(w => w.includes('customJs'))).toHaveLength(0);
  });

  it('allows the simple docs page its own style sheet and nothing that runs', () => {
    const headers: Record<string, string> = {};
    let body = '';
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      send: (html: string) => {
        body = html;
      },
    };
    createSimpleDocsMiddleware([{ schema: { method: 'GET', path: '/items' } } as any])(
      { path: '/docs/simple' },
      res,
      () => undefined
    );

    const styles = [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
    expect(styles).toHaveLength(1);
    const policy = headers['content-security-policy'];
    expect(directive(policy, 'default-src')).toBe("default-src 'none'");
    expect(directive(policy, 'style-src')).toBe(`style-src ${digestSource(styles[0])}`);
    expect(policy).not.toContain('script-src');
    expect(policy).not.toContain('unsafe');
    expect(body).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
  });
});

describe('Swagger UI configuration', () => {
  it('applies swaggerOptions ahead of the settings the page owns', () => {
    const script = inlineScript(
      swaggerPage({ swaggerOptions: { docExpansion: 'none', persistAuthorization: true } })
    );

    const applied = script.indexOf('...{"docExpansion":"none","persistAuthorization":true},');
    expect(applied).toBeGreaterThan(script.indexOf('SwaggerUIBundle({'));
    // The page's own values come after, so they are the ones that hold
    expect(script.indexOf('url: "/docs/openapi.json",')).toBeGreaterThan(applied);
    expect(script.indexOf('tryItOutEnabled: true,')).toBeGreaterThan(applied);

    // With nothing to apply, nothing is added
    for (const options of [{}, { swaggerOptions: {} }, { swaggerOptions: undefined }]) {
      expect(inlineScript(swaggerPage(options))).not.toContain('...{');
    }
  });

  it('lets swaggerOptions choose the layout', () => {
    const script = inlineScript(swaggerPage({ swaggerOptions: { layout: 'BaseLayout' } }));

    expect(script).toContain('layout: "BaseLayout",');
    expect(script).not.toContain('layout: "StandaloneLayout",');
    expect(inlineScript(swaggerPage({}))).toContain('layout: "StandaloneLayout",');
  });

  it('writes swaggerOptions values as escaped script literals', () => {
    const html = swaggerPage({ swaggerOptions: { validatorUrl: `x${MARKUP}`, onComplete() {} } });

    expect(html).not.toContain(MARKUP);
    expect(inlineScript(html)).toContain(
      '...{"validatorUrl":"x\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"},'
    );
  });

  it('applies the swaggerOptions that have a JSON form', () => {
    // A function has none and is left out
    const withFunction = { defaultModelsExpandDepth: 2, requestInterceptor: () => undefined };
    expect(inlineScript(swaggerPage({ swaggerOptions: withFunction }))).toContain(
      '...{"defaultModelsExpandDepth":2},'
    );

    // Neither has an object that contains itself; the page is served without it
    const cyclic: Record<string, unknown> = { docExpansion: 'none' };
    cyclic.self = cyclic;
    const script = inlineScript(swaggerPage({ swaggerOptions: cyclic }));
    expect(script).not.toContain('...{');
    expect(script).toContain('url: "/docs/openapi.json",');
  });

  it('names the OAuth2 redirect page under the base path', () => {
    expect(inlineScript(swaggerPage({}, '/internal/docs'))).toContain(
      'oauth2RedirectUrl: window.location.origin + "/internal/docs/oauth2-redirect.html",'
    );
  });
});

describe('Swagger UI middleware', () => {
  const assets = mkdtempSync(join(tmpdir(), 'moro-swagger-assets-'));
  writeFileSync(join(assets, 'swagger-ui.css'), 'body { margin: 0 }');
  writeFileSync(join(assets, 'oauth2-redirect.html'), '<script src="oauth2-redirect.js"></script>');
  writeFileSync(join(assets, 'oauth2-redirect.js'), 'window.close();');
  writeFileSync(join(assets, 'README.md'), 'not an asset');

  afterAll(() => rmSync(assets, { recursive: true, force: true }));

  it('passes paths it does not serve on to the application', () => {
    const middleware = swaggerMiddleware({}, assets);

    for (const path of ['/docs/guide', '/docs/README.md', '/docs/a/b', '/docsify', '/users']) {
      const result = request(middleware, path);

      expect(result.nextCalled).toBe(true);
      expect(result.ended).toBe(false);
      expect(result.status).toBe(200);
    }

    // Its own paths it answers itself
    for (const path of ['/docs', '/docs/', '/docs/openapi.json', '/docs/swagger-ui.css']) {
      const result = request(middleware, path);

      expect(result.nextCalled).toBe(false);
      expect(result.ended).toBe(true);
    }
  });

  it('runs the spec refresher before serving the specification', () => {
    const middleware = swaggerMiddleware();
    const current = { openapi: '3.0.3', info: { title: 'Current', version: '2' }, paths: {} };
    middleware.setSpecRefresher(() => middleware.updateSpec(current));

    expect(request(middleware, '/docs/openapi.json').body).toBe(current);
  });

  it('serves the specification it has when the refresher fails', () => {
    const middleware = swaggerMiddleware();
    middleware.setSpecRefresher(() => {
      throw new Error('routes unavailable');
    });

    expect(request(middleware, '/docs/openapi.json').body).toBe(middleware.openAPISpec);
  });

  it('reads an asset from disk once and serves it from memory afterwards', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moro-swagger-once-'));
    try {
      writeFileSync(join(directory, 'swagger-ui-bundle.js'), 'first();');
      const middleware = swaggerMiddleware({}, directory);

      const first = request(middleware, '/docs/swagger-ui-bundle.js');
      writeFileSync(join(directory, 'swagger-ui-bundle.js'), 'second();');
      const second = request(middleware, '/docs/swagger-ui-bundle.js');
      rmSync(join(directory, 'swagger-ui-bundle.js'));
      const third = request(middleware, '/docs/swagger-ui-bundle.js');

      expect(String(first.body)).toBe('first();');
      expect(second.body).toBe(first.body);
      expect(third.body).toBe(first.body);
      expect(third.status).toBe(200);
      expect(first.headers['content-type']).toBe('application/javascript');
      expect(first.headers['cache-control']).toBe('public, max-age=86400');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('answers a matching If-None-Match with 304 and no body', () => {
    const middleware = swaggerMiddleware({}, assets);
    const { headers } = request(middleware, '/docs/swagger-ui.css');
    const etag = headers.etag;

    expect(etag).toMatch(/^"[0-9a-f]+-[A-Za-z0-9_-]+"$/);

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const result = request(middleware, '/docs/swagger-ui.css', { 'if-none-match': header });

      expect(result.status).toBe(304);
      expect(result.body).toBeUndefined();
      expect(result.ended).toBe(true);
      expect(result.headers.etag).toBe(etag);
    }

    const stale = request(middleware, '/docs/swagger-ui.css', { 'if-none-match': '"other"' });
    expect(stale.status).toBe(200);
    expect(String(stale.body)).toBe('body { margin: 0 }');
  });

  it('serves the OAuth2 redirect page and its script', () => {
    const middleware = swaggerMiddleware({}, assets);

    const page = request(middleware, '/docs/oauth2-redirect.html');
    const script = request(middleware, '/docs/oauth2-redirect.js');

    expect(page.nextCalled).toBe(false);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(page.body)).toBe('<script src="oauth2-redirect.js"></script>');
    expect(script.headers['content-type']).toBe('application/javascript');
    expect(String(script.body)).toBe('window.close();');
  });
});
