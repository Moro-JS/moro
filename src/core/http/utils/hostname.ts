/**
 * The host of a Host / :authority value without its port, as req.hostname
 * reports it on every server. An IPv6 literal is bracketed (RFC 3986 3.2.2)
 * and its colons are part of the address: `[::1]:3000` is the host `[::1]`.
 */
export function hostnameOf(host: string): string {
  if (!host) return '';
  if (host.charCodeAt(0) === 91 /* [ */) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * A request target in absolute-form (RFC 9112 3.2.2): `http://host[:port]/path`,
 * with its query already split off. Such a request is routed by the path of
 * that URL, and takes the URL's host in place of its Host header, which the
 * same section says to ignore. Anything else that does not start with '/'
 * ('*', an authority, another scheme, a URL with no host) gives undefined and
 * is left to match no route.
 */
export function absoluteTargetOf(target: string): { path: string; host: string } | undefined {
  const scheme = target.slice(0, 8).toLowerCase();
  const start = scheme.startsWith('http://') ? 7 : scheme === 'https://' ? 8 : 0;
  if (start === 0) return undefined;
  const slash = target.indexOf('/', start);
  let host = slash === -1 ? target.slice(start) : target.slice(start, slash);
  const userinfo = host.lastIndexOf('@');
  if (userinfo !== -1) host = host.slice(userinfo + 1);
  if (host === '' || host.charCodeAt(0) === 58 /* : */) return undefined;
  return { path: slash === -1 ? '/' : target.slice(slash), host };
}
