// What a request is told when no route and no middleware answered it. Shared
// by the three servers so a request gets the same reply on each.

/** The methods routes can be registered for. */
export const ROUTED_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
]);

/** The Allow value of a server-wide OPTIONS. */
export const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS';

export const NOT_FOUND_BODY = '{"success":false,"error":"Not found"}';
export const NOT_IMPLEMENTED_BODY = '{"success":false,"error":"Not implemented"}';

export type UnroutedReply = 404 | 204 | 501;

/**
 * The status of the reply to a request nothing answered:
 *
 * - 204 with `Allow` for `OPTIONS *`, the request for what the server as a
 *   whole supports (RFC 9110 §9.3.7). It names no resource, so there is
 *   nothing for it not to be found.
 * - 501 for a method no route can be registered for (RFC 9110 §15.6.2): the
 *   server does not implement it for any resource, which is a different
 *   statement from "this resource does not exist". Middleware that serves
 *   such a method itself (WebDAV, PURGE) has answered before this is asked.
 * - 404 otherwise.
 */
export function unroutedStatus(
  method: string | undefined,
  path: string | undefined
): UnroutedReply {
  if (method === undefined || ROUTED_METHODS.has(method)) {
    return method === 'OPTIONS' && path === '*' ? 204 : 404;
  }
  return ROUTED_METHODS.has(method.toUpperCase()) ? 404 : 501;
}
