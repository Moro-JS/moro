// Method label shared by the metrics middleware (Prometheus, CloudWatch).
//
// A metric label must come from a small fixed set. The request method does
// not, by itself: the native engine passes any token a client sends (the Node
// parser rejects unknown ones), so labelling by the raw value lets a client
// mint a new time series - or a new billable CloudWatch dimension value - per
// request. Everything outside the registered methods is reported as OTHER.

const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

/** The label for unregistered methods */
export const OTHER_METHOD = 'OTHER';

/**
 * The method as a metric label: upper-cased, and `OTHER` for anything that is
 * not a registered HTTP method. The usual request (already upper-case, known)
 * is one Set lookup.
 */
export function normalizeMethodLabel(method: unknown): string {
  if (typeof method !== 'string') return OTHER_METHOD;
  if (KNOWN_METHODS.has(method)) return method;
  // Longest registered method is 7 characters: no need to upper-case a long token
  if (method.length > 7) return OTHER_METHOD;
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : OTHER_METHOD;
}
