// Parse a raw query string ("a=1&b=2") into an object. Transport-neutral: the
// single canonical implementation for the Node http server, the uWS adapter,
// and the Moro engine adapter, so req.query is identical on every transport.
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

export function parseRawQueryString(queryString: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (!queryString) return result;
  if (queryString[0] === '?') queryString = queryString.substring(1);
  const pairs = queryString.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      result[decodeComponent(pair)] = '';
    } else {
      result[decodeComponent(pair.substring(0, eqIdx))] = decodeComponent(
        pair.substring(eqIdx + 1)
      );
    }
  }
  return result;
}
