// Unit tests - the security-header built-ins: the headers helmet sends by
// default, the Content-Security-Policy header it builds from each accepted
// `contentSecurityPolicy` form, the default policy of csp(), and (on real
// servers) helmet's headers on the responses the built-in hooks answer
// themselves, ahead of function middleware.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { createApp, middleware } from '../../../src/index.js';
import { HelmetCore } from '../../../src/core/middleware/built-in/helmet/index.js';
import { CSPCore } from '../../../src/core/middleware/built-in/csp/index.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { closeApp, createTestPort } from '../../setup.js';
import { describeEngine } from '../../integration/engine-test-utils.js';

function apply(options?: Parameters<typeof middleware.helmet>[0]) {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
  const next = jest.fn();
  middleware.helmet(options)({ headers: {} } as any, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  return headers;
}

describe('helmet: default headers', () => {
  it('switches the legacy XSS filter off and leaves the other defaults as they were', () => {
    expect(apply()['X-XSS-Protection']).toBe('0');
    expect(apply({ xXssProtection: true })['X-XSS-Protection']).toBe('0');
    expect(apply({ xXssProtection: false })['X-XSS-Protection']).toBeUndefined();

    expect(apply()).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Download-Options': 'noopen',
      'X-Permitted-Cross-Domain-Policies': 'none',
    });
  });
});

describe('helmet: Content-Security-Policy', () => {
  const DEFAULT_POLICY =
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

  it('names base-uri, form-action and frame-ancestors in the default policy', () => {
    expect(apply()['Content-Security-Policy']).toBe(DEFAULT_POLICY);
    expect(apply({ contentSecurityPolicy: true })['Content-Security-Policy']).toBe(DEFAULT_POLICY);
  });

  it('lets frame-ancestors follow xFrameOptions in the default policy', () => {
    expect(apply({ xFrameOptions: 'SAMEORIGIN' })['Content-Security-Policy']).toBe(
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    );
    // framing allowed outright: the policy does not take that back
    expect(apply({ xFrameOptions: false })['Content-Security-Policy']).toBe(
      "default-src 'self'; base-uri 'self'; form-action 'self'"
    );
  });

  it('sends no policy when disabled', () => {
    expect(apply({ contentSecurityPolicy: false })['Content-Security-Policy']).toBeUndefined();
  });

  it('builds the policy from directives given directly', () => {
    const headers = apply({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    });

    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'"
    );
  });

  it('builds the same policy from directives given under a `directives` key', () => {
    const headers = apply({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.example.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'api.example.com'],
          fontSrc: ["'self'", 'fonts.gstatic.com'],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
    });

    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' cdn.example.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' api.example.com; " +
        "font-src 'self' fonts.gstatic.com; " +
        "object-src 'none'; " +
        "media-src 'self'; " +
        "frame-src 'none'"
    );
    // the rest of the headers are still applied
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('accepts a directive without sources and skips one that is switched off', () => {
    const core = new HelmetCore({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          upgradeInsecureRequests: true,
          blockAllMixedContent: false,
          sandbox: 'allow-scripts',
        },
      } as any,
    });
    const headers: Record<string, string> = {};
    core.applyHeaders(
      { headers: {} } as any,
      { setHeader: (n: string, v: string) => (headers[n] = v) } as any
    );

    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'self'; upgrade-insecure-requests; sandbox allow-scripts"
    );
  });
});

describe('csp: default policy', () => {
  const policyOf = (options?: ConstructorParameters<typeof CSPCore>[0]) => {
    const headers: Record<string, string> = {};
    new CSPCore(options).applyCSP({
      setHeader: (name: string, value: string) => (headers[name] = value),
    } as any);
    return headers['Content-Security-Policy'] as string;
  };

  it('names base-uri, form-action and frame-ancestors, unless directives are given', () => {
    expect(policyOf({ directives: { defaultSrc: ["'self'"] } })).toBe("default-src 'self'");
    expect(policyOf()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
        "media-src 'self'; frame-src 'none'; base-uri 'self'; form-action 'self'; " +
        "frame-ancestors 'self'"
    );
  });
});

function onHookResponses(engine: 'node' | 'moro') {
  let app: any;
  let base = '';

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const boot = async (setup: (app: any) => Promise<void>) => {
    resetConfig();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    await setup(app);
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));
    expect(app.engine?.server).toBe(engine === 'node' ? 'node' : 'engine');
    base = `http://127.0.0.1:${port}`;
  };

  const helmetHeaders = (res: Awaited<ReturnType<typeof fetch>>) => ({
    nosniff: res.headers.get('x-content-type-options'),
    frame: res.headers.get('x-frame-options'),
    csp: res.headers.get('content-security-policy'),
  });
  const APPLIED = {
    nosniff: 'nosniff',
    frame: 'SAMEORIGIN',
    csp: "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  };
  const NONE = { nosniff: null, frame: null, csp: null };

  it("puts them on the rate limiter's 429, when helmet is registered", async () => {
    // without helmet the 429 is as it always was
    await boot(async a => {
      await a.use(middleware.rateLimit({ requests: 1, window: 60000 }));
      a.get('/limited', () => ({ ok: true }));
    });
    await fetch(`${base}/limited`);
    const bare = await fetch(`${base}/limited`);
    expect(bare.status).toBe(429);
    expect(helmetHeaders(bare)).toEqual(NONE);
    await closeApp(app);

    await boot(async a => {
      await a.use(middleware.helmet({ xFrameOptions: 'SAMEORIGIN' }));
      await a.use(middleware.rateLimit({ requests: 1, window: 60000 }));
      a.get('/limited', () => ({ ok: true }));
    });

    const first = await fetch(`${base}/limited`);
    expect(first.status).toBe(200);
    expect(helmetHeaders(first)).toEqual(APPLIED);

    const refused = await fetch(`${base}/limited`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    expect(helmetHeaders(refused)).toEqual(APPLIED);
  });

  it("puts them on the CORS middleware's 403", async () => {
    await boot(async a => {
      await a.use(middleware.cors({ origin: ['https://app.example'], credentials: true }));
      await a.use(middleware.helmet({ xFrameOptions: 'SAMEORIGIN' }));
      a.get('/data', () => ({ ok: true }));
    });

    const refused = await fetch(`${base}/data`, { headers: { origin: 'https://evil.example' } });
    expect(refused.status).toBe(403);
    expect(helmetHeaders(refused)).toEqual(APPLIED);
  });

  it("puts them on the CSRF middleware's 403", async () => {
    await boot(async a => {
      await a.use(middleware.helmet({ xFrameOptions: 'SAMEORIGIN' }));
      await a.use(middleware.csrf({ secret: 'csrf-test-secret' }));
      a.post('/transfer', () => ({ ok: true }));
    });

    const refused = await fetch(`${base}/transfer`, { method: 'POST' });
    expect(refused.status).toBe(403);
    expect(helmetHeaders(refused)).toEqual(APPLIED);
  });
}

describe('helmet: responses answered by hooks (Node http server)', () => onHookResponses('node'));
describeEngine('helmet: responses answered by hooks (native engine)', () =>
  onHookResponses('moro')
);
