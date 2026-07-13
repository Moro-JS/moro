import { WSAdapter } from '../../../src/core/networking/adapters/ws-adapter.js';

// Exercises the real (private) verifyClient builder so the CORS origin contract
// - '*', function, array, exact, same-origin - is locked in.
function build(cors: any) {
  const adapter = new WSAdapter();
  return (adapter as any).buildVerifyClient({ cors }) as
    | ((info: { origin?: string; req: any; secure: boolean }) => boolean)
    | undefined;
}

const reqFor = (host = 'api.example.com') => ({ req: { headers: { host } }, secure: false });

describe('WSAdapter CORS origin', () => {
  it('allow-all forms return no verifyClient (undefined)', () => {
    expect(build({ origin: '*' })).toBeUndefined();
    expect(build({ origin: true })).toBeUndefined();
    expect(build(undefined)).toBeUndefined();
    expect(build({})).toBeUndefined();
  });

  it('exact string origin allows only the match', () => {
    const vc = build({ origin: 'https://app.example.com' })!;
    expect(vc({ origin: 'https://app.example.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://evil.com', ...reqFor() })).toBe(false);
  });

  it('array origin allows any listed origin', () => {
    const vc = build({ origin: ['https://a.com', 'https://b.com'] })!;
    expect(vc({ origin: 'https://a.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://b.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://c.com', ...reqFor() })).toBe(false);
  });

  it('function origin decides dynamically (boolean, string, or "*")', () => {
    // boolean predicate
    const vcBool = build({ origin: (o: string | undefined) => o === 'https://dyn.com' })!;
    expect(vcBool({ origin: 'https://dyn.com', ...reqFor() })).toBe(true);
    expect(vcBool({ origin: 'https://nope.com', ...reqFor() })).toBe(false);

    // reflect the request origin (return the allowed domain)
    const allow = new Set(['https://ok.com']);
    const vcReflect = build({
      origin: (o: string | undefined) => (o && allow.has(o) ? o : false),
    })!;
    expect(vcReflect({ origin: 'https://ok.com', ...reqFor() })).toBe(true);
    expect(vcReflect({ origin: 'https://bad.com', ...reqFor() })).toBe(false);

    // a function may also open it back up with '*'
    const vcStar = build({ origin: () => '*' })!;
    expect(vcStar({ origin: 'https://anything.com', ...reqFor() })).toBe(true);
  });

  it('RegExp origin matches by pattern', () => {
    const vc = build({ origin: /\.example\.com$/ })!;
    expect(vc({ origin: 'https://x.example.com', ...reqFor() })).toBe(true);
    expect(vc({ origin: 'https://x.evil.com', ...reqFor() })).toBe(false);
  });

  it('false = same-origin only (Origin host must equal Host; no Origin allowed)', () => {
    const vc = build({ origin: false })!;
    expect(vc({ origin: undefined, ...reqFor('api.example.com') })).toBe(true); // non-browser
    expect(vc({ origin: 'http://api.example.com', ...reqFor('api.example.com') })).toBe(true);
    expect(vc({ origin: 'http://other.com', ...reqFor('api.example.com') })).toBe(false);
  });

  it('a user verifyClient hook runs after the origin check passes', () => {
    const vc = build({ origin: '*' }); // allow-all origin, but hook still enforced...
    // origin '*' short-circuits to undefined, so use a specific origin + hook:
    const adapter = new WSAdapter();
    const withHook = (adapter as any).buildVerifyClient({
      cors: { origin: true },
      verifyClient: (info: any) => info.origin === 'https://trusted.com',
    }) as (info: any) => boolean;
    expect(withHook({ origin: 'https://trusted.com', ...reqFor() })).toBe(true);
    expect(withHook({ origin: 'https://other.com', ...reqFor() })).toBe(false);
    expect(vc).toBeUndefined();
  });
});
