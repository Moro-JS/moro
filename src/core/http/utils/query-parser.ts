// Parse a raw query string ("a=1&b=2") into an object. Transport-neutral: the
// single canonical implementation for the Node http server and the Moro
// engine adapter, so req.query is identical on every transport.
//
// Semantics follow application/x-www-form-urlencoded (WHATWG):
//   - '+' decodes to a space in keys and values
//   - malformed percent-escapes never throw (the raw text is kept)
//   - a key without '=' yields '' ("?flag" -> { flag: '' })
//   - duplicate keys are last-wins
// The result has a null prototype (like node:querystring), so a key named
// "__proto__" is stored as an own property instead of vanishing.

function decodeComponent(component: string): string {
  const plusDecoded = component.indexOf('+') === -1 ? component : component.replace(/\+/g, ' ');
  if (plusDecoded.indexOf('%') === -1) return plusDecoded;
  try {
    return decodeURIComponent(plusDecoded);
  } catch {
    return plusDecoded;
  }
}

// One pass over the string, a substring per key and per value and nothing
// else: no array of pairs, no pair strings cut out only to be cut again. The
// two characters that need decoding are looked for once in the whole string
// rather than in every component, so a query with neither - most of them -
// is sliced and stored as is.
export function parseRawQueryString(queryString: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (!queryString) return result;
  const len = queryString.length;
  let start = queryString.charCodeAt(0) === 63 /* ? */ ? 1 : 0;
  const encoded = queryString.indexOf('%') !== -1 || queryString.indexOf('+') !== -1;
  // The next '=' at or after `start`, found once and kept until a pair has
  // moved past it: looking it up per pair would rescan the rest of the
  // string for every pair that has none.
  let eq = queryString.indexOf('=', start);
  while (start < len) {
    let end = queryString.indexOf('&', start);
    if (end === -1) end = len;
    if (end > start) {
      if (eq !== -1 && eq < start) eq = queryString.indexOf('=', start);
      if (eq === -1 || eq > end) {
        const key = queryString.substring(start, end);
        result[encoded ? decodeComponent(key) : key] = '';
      } else {
        const key = queryString.substring(start, eq);
        const value = queryString.substring(eq + 1, end);
        if (encoded) result[decodeComponent(key)] = decodeComponent(value);
        else result[key] = value;
      }
    }
    start = end + 1;
  }
  return result;
}
