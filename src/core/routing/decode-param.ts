// Percent-decoding of one route parameter, shared by every matcher (radix
// tree, compiled path, unified router) so `req.params` is the same whichever
// matched. A value without a percent sign is returned as is - the common case
// and no call. A malformed escape keeps the raw text: the handler, not a
// URIError, decides the answer to an odd URL.
export function decodeParam(value: string): string {
  if (value.indexOf('%') === -1) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
