// @ts-nocheck
// What res.cookie() does about `Secure` when the caller gives no `secure`
// option: the same handler on every server and runtime, and what each must
// send. The suites of the HTTP servers and of the serverless adapters run it
// and compare against these tables.

/** Cookies set with every way of saying (or not saying) `secure`. */
export function setCookies(_req: any, res: any) {
  res.cookie('bare', '1');
  res.cookie('options', '1', { httpOnly: true, sameSite: 'lax' });
  res.cookie('on', '1', { secure: true });
  res.cookie('off', '1', { secure: false });
  res.clearCookie('gone');
  res.json({ ok: true });
}

/** `{ name: whether the cookie carries Secure }` for a list of Set-Cookie values. */
export function secureFlags(setCookie: string | string[] | undefined): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const cookie of [setCookie ?? []].flat()) {
    const attributes = cookie.split(';').map(part => part.trim().toLowerCase());
    flags[cookie.slice(0, cookie.indexOf('='))] = attributes.includes('secure');
  }
  return flags;
}

/** The request arrived over plain http: only the cookie that asked is Secure. */
export const OVER_HTTP = { bare: false, options: false, on: true, off: false, gone: false };

/** The request arrived over TLS: every cookie is Secure unless it said `secure: false`. */
export const OVER_TLS = { bare: true, options: true, on: true, off: false, gone: true };

// Every option of res.cookie() and res.clearCookie(): one call per row, and
// the Set-Cookie value it sends over plain http. The values are what the
// Node HTTP/1 server sends; every other server, and the cookie middleware's
// writer, must send the same bytes for the same call.
export const COOKIE_CALLS: Array<[label: string, call: (res: any) => void, sent: string]> = [
  ['no options', res => res.cookie('bare', 'v'), 'bare=v; Path=/'],
  ['empty options', res => res.cookie('empty', 'v', {}), 'empty=v; Path=/'],
  [
    'a value that needs encoding',
    res => res.cookie('encoded', 'a b;c=d,é'),
    'encoded=a%20b%3Bc%3Dd%2C%C3%A9; Path=/',
  ],
  ['maxAge 0', res => res.cookie('zero', 'v', { maxAge: 0 }), 'zero=v; Max-Age=0; Path=/'],
  ['maxAge', res => res.cookie('age', 'v', { maxAge: 90_000 }), 'age=v; Max-Age=90; Path=/'],
  [
    'maxAge under a second',
    res => res.cookie('brief', 'v', { maxAge: 1500 }),
    'brief=v; Max-Age=1; Path=/',
  ],
  ['maxAge null', res => res.cookie('unaged', 'v', { maxAge: null }), 'unaged=v; Path=/'],
  [
    'expires',
    res => res.cookie('dated', 'v', { expires: new Date('2030-01-02T03:04:05Z') }),
    'dated=v; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Path=/',
  ],
  ['path', res => res.cookie('scoped', 'v', { path: '/app' }), 'scoped=v; Path=/app'],
  [
    'domain',
    res => res.cookie('wide', 'v', { domain: 'example.com' }),
    'wide=v; Domain=example.com; Path=/',
  ],
  [
    'sameSite strict',
    res => res.cookie('strict', 'v', { sameSite: 'strict' }),
    'strict=v; SameSite=strict; Path=/',
  ],
  [
    'sameSite lax',
    res => res.cookie('lax', 'v', { sameSite: 'lax' }),
    'lax=v; SameSite=lax; Path=/',
  ],
  [
    'sameSite none',
    res => res.cookie('cross', 'v', { sameSite: 'none', secure: true }),
    'cross=v; Secure; SameSite=none; Path=/',
  ],
  [
    'sameSite as written',
    res => res.cookie('cased', 'v', { sameSite: 'Lax' }),
    'cased=v; SameSite=Lax; Path=/',
  ],
  ['httpOnly', res => res.cookie('hidden', 'v', { httpOnly: true }), 'hidden=v; HttpOnly; Path=/'],
  ['secure', res => res.cookie('tls', 'v', { secure: true }), 'tls=v; Secure; Path=/'],
  ['secure false', res => res.cookie('open', 'v', { secure: false }), 'open=v; Path=/'],
  [
    'every option',
    res =>
      res.cookie('all', 'v', {
        maxAge: 3_600_000,
        expires: new Date('2030-01-02T03:04:05Z'),
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        domain: 'example.com',
        path: '/app',
      }),
    'all=v; Max-Age=3600; Expires=Wed, 02 Jan 2030 03:04:05 GMT; HttpOnly; Secure; SameSite=strict; Domain=example.com; Path=/app',
  ],
  [
    'clearCookie',
    res => res.clearCookie('gone'),
    'gone=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
  ],
  [
    'clearCookie with the options the cookie was set with',
    res =>
      res.clearCookie('gone-scoped', {
        path: '/app',
        domain: 'example.com',
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      }),
    'gone-scoped=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=none; Domain=example.com; Path=/app',
  ],
];

/** Makes every call of COOKIE_CALLS, in order, then answers. */
export function setEveryCookie(_req: any, res: any) {
  for (const [, call] of COOKIE_CALLS) call(res);
  res.json({ ok: true });
}

/** `{ label: Set-Cookie value }` for the answer to setEveryCookie. */
export function byCall(setCookie: string | string[] | undefined): Record<string, string> {
  const sent = [setCookie ?? []].flat();
  return Object.fromEntries(COOKIE_CALLS.map(([label], index) => [label, sent[index]]));
}

/** What byCall() gives when every call sent what the Node HTTP/1 server sends. */
export const EVERY_COOKIE: Record<string, string> = Object.fromEntries(
  COOKIE_CALLS.map(([label, , sent]) => [label, sent])
);
