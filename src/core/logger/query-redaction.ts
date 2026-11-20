// Query-string redaction for telemetry and error logs
//
// Tokens travel in query strings: OAuth authorization codes, signed-URL
// signatures, API keys, password-reset links. A URL recorded on a span or in
// an error log keeps them for as long as that backend keeps data, so the
// values of well-known parameter names are replaced before the URL is recorded.

/** What a redacted parameter value is replaced with (the OpenTelemetry convention). */
export const REDACTED_QUERY_VALUE = 'REDACTED';

/**
 * Parameter names redacted by default (matched case-insensitively): bearer
 * and OAuth tokens, OAuth authorization codes, API keys, passwords and
 * secrets, and the signature parameters of signed URLs.
 */
export const DEFAULT_REDACTED_QUERY_PARAMS: readonly string[] = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'key',
  'api_key',
  'apikey',
  'password',
  'secret',
  'client_secret',
  'signature',
  'sig',
  'AWSAccessKeyId',
  'X-Amz-Signature',
  'X-Amz-Security-Token',
  'X-Goog-Signature',
];

// 'user[password]' -> 'password', 'token[]' -> 'token'
function innermostName(name: string): string {
  let end = name.length;
  while (end >= 2 && name.charCodeAt(end - 1) === 93 /* ] */) {
    const open = name.lastIndexOf('[', end - 1);
    if (open === -1) break;
    if (open < end - 2) return name.slice(open + 1, end - 1);
    end = open; // an empty '[]': look at what is in front of it
  }
  return end === name.length ? name : name.slice(0, end);
}

/**
 * Build a function that replaces the values of the named parameters in a
 * query string (without the leading `?`) with `REDACTED`. Names are compared
 * case-insensitively after percent-decoding, and the innermost key of a
 * bracketed name counts (`user[password]`). Everything else - order, other
 * parameters, their encoding - is returned exactly as it came in, and a query
 * with nothing to redact is returned as the same string.
 *
 * @param names Parameter names to redact
 */
export function createQueryRedactor(
  names: readonly string[] = DEFAULT_REDACTED_QUERY_PARAMS
): (query: string) => string {
  const redacted = new Set(names.map(name => String(name).toLowerCase()));
  if (redacted.size === 0) return query => query;

  const isRedacted = (rawName: string): boolean => {
    let name = rawName;
    if (name.indexOf('%') !== -1 || name.indexOf('+') !== -1) {
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        // malformed escape: compare the raw text
      }
    }
    name = name.toLowerCase();
    if (redacted.has(name)) return true;
    const inner = innermostName(name);
    return inner !== name && redacted.has(inner);
  };

  return (query: string): string => {
    if (query.length === 0) return query;
    let result = '';
    let copiedTo = 0; // everything before this index is already in `result`
    let start = 0;
    // Position of the next '=' at or after `start`; -1 once there is none
    // left. Searched again only after `start` has moved past it, so a long
    // query of bare names is still one pass.
    let equals = -2;
    while (start <= query.length) {
      let end = query.indexOf('&', start);
      if (end === -1) end = query.length;
      if (equals !== -1 && equals < start) equals = query.indexOf('=', start);
      // Only a pair with a value has something to hide
      if (equals !== -1 && equals < end - 1 && isRedacted(query.slice(start, equals))) {
        result += query.slice(copiedTo, equals + 1) + REDACTED_QUERY_VALUE;
        copiedTo = end;
      }
      start = end + 1;
    }
    return copiedTo === 0 ? query : result + query.slice(copiedTo);
  };
}

/**
 * The same for a request target or URL (`/callback?code=abc#frag`,
 * `https://host/path?token=x`): only the query part is rewritten.
 */
export function createUrlQueryRedactor(
  names: readonly string[] = DEFAULT_REDACTED_QUERY_PARAMS
): (url: string) => string {
  const redactQuery = createQueryRedactor(names);
  return (url: string): string => {
    const question = url.indexOf('?');
    if (question === -1) return url;
    const hash = url.indexOf('#', question);
    const end = hash === -1 ? url.length : hash;
    const query = url.slice(question + 1, end);
    const redactedQuery = redactQuery(query);
    return redactedQuery === query
      ? url
      : url.slice(0, question + 1) + redactedQuery + url.slice(end);
  };
}
