// Response-header helpers shared by every server (Node http, HTTP/2, the
// native engine through the router), so the same call produces the same
// header whichever one is serving.

const BEYOND_LATIN1 = /[\u0100-\uffff]/;
const NON_ASCII_RUN = /[\u0080-\uffff]+/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// What a header value cannot carry besides CR and LF: C0 controls other than
// tab, and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/g;
const RFC8187_RESERVED = /['()*]/g;

/** UTF-8 percent-encoding that cannot throw: a lone surrogate becomes U+FFFD. */
function percentEncode(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return encodeURIComponent(text.replace(LONE_SURROGATE, '\uFFFD'));
  }
}

// One control character as %XX
const percentEncodeControl = (c: string): string =>
  `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * The value of a `Location` header for `url`: CR and LF are removed (they
 * would end the header), any other control character a header value cannot
 * carry (NUL, the rest of C0 except tab, DEL) is percent-encoded, as a
 * browser does with one in a URL, and a URL holding a character beyond
 * U+00FF has its non-ASCII characters percent-encoded as UTF-8 (RFC 3986
 * 2.5), which is what a browser would send for it anyway. A printable ASCII
 * or Latin-1 URL passes through unchanged.
 */
export function locationHeaderValue(url: string): string {
  let safe = url;
  // One scan decides whether anything has to be taken out or encoded
  if (safe.search(CONTROL_CHARS) !== -1) {
    safe = safe.replace(/[\r\n]/g, '').replace(CONTROL_CHARS, percentEncodeControl);
  }
  return BEYOND_LATIN1.test(safe) ? safe.replace(NON_ASCII_RUN, percentEncode) : safe;
}

/**
 * The value of `Content-Disposition: attachment` for a display name.
 *
 * A name a header can carry as it is (ASCII or Latin-1, no control
 * characters) is sent in the quoted `filename` parameter. Any other name is
 * sent twice, as RFC 6266 4.3 recommends: an ASCII stand-in in `filename` for
 * old clients and the real name in `filename*` (RFC 8187, UTF-8
 * percent-encoded), which current browsers prefer.
 */
export function attachmentDisposition(filename: string): string {
  const quoted = filename.replace(/[\r\n"]/g, '');
  if (!BEYOND_LATIN1.test(quoted) && quoted.search(CONTROL_CHARS) === -1) {
    return `attachment; filename="${quoted}"`;
  }
  const name = quoted.replace(CONTROL_CHARS, '');
  if (!BEYOND_LATIN1.test(name)) return `attachment; filename="${name}"`;
  const fallback = name.replace(NON_ASCII_RUN, run => '_'.repeat(Array.from(run).length));
  const extended = percentEncode(name).replace(
    RFC8187_RESERVED,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

// Headers that describe the body a handler was about to send. On an error
// response they describe a body that is not coming: Content-Encoding makes
// the client try to decompress plain JSON, Content-Length and Content-Range
// give the wrong size, the validators and Content-Disposition belong to the
// other representation.
const REPRESENTATION_HEADERS = [
  'Content-Encoding',
  'Content-Length',
  'Content-Range',
  'ETag',
  'Last-Modified',
  'Content-Disposition',
];

/**
 * Remove, from a response that has not started, the headers that described
 * the body the failed handler meant to send, and its Cache-Control unless
 * that forbids storing: an error must not inherit a public cache lifetime.
 * Everything else (CORS, cookies, security headers) stays as set.
 * `keepCacheControl` leaves Cache-Control alone whatever it says.
 */
export function clearRepresentationHeaders(
  res: {
    getHeader?: (name: string) => unknown;
    removeHeader?: (name: string) => unknown;
  },
  keepCacheControl = false
): void {
  if (typeof res.removeHeader !== 'function') return;
  for (let i = 0; i < REPRESENTATION_HEADERS.length; i++) {
    res.removeHeader(REPRESENTATION_HEADERS[i] as string);
  }
  if (keepCacheControl) return;
  const cacheControl = typeof res.getHeader === 'function' ? res.getHeader('Cache-Control') : null;
  if (cacheControl !== undefined && cacheControl !== null) {
    if (!/no-store/i.test(String(cacheControl))) res.removeHeader('Cache-Control');
  }
}

/**
 * A request failed after its response had started. Nothing can be answered
 * any more, and leaving the response open would leave the client waiting on
 * a body that never ends (an unterminated chunked response on HTTP/1.1, an
 * open stream on HTTP/2). Destroying it makes the failure visible as a
 * truncated transfer. Does nothing to a response that has already been ended.
 */
export function destroyUnfinishedResponse(res: {
  headersSent?: boolean;
  writableEnded?: boolean;
  destroy?: (error?: Error) => unknown;
}): void {
  if (res.headersSent !== true || res.writableEnded !== false) return;
  if (typeof res.destroy === 'function') res.destroy();
}
