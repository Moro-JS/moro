/**
 * `server.trustProxy`: which proxies in front of the app are believed when
 * they say who the client is.
 *
 * A proxy passes the client on in `X-Forwarded-For`, `X-Forwarded-Proto` and
 * `X-Forwarded-Host`. Any client can send those headers too, so they mean
 * something only when the connection they arrived on comes from a proxy the
 * operator named. The setting is compiled once, when the server is created,
 * into a function the request getters call; the semantics are those of
 * Express's `trust proxy`:
 *
 *   false            nothing is trusted: the forwarded headers are ignored
 *   true             every hop is trusted: the left-most X-Forwarded-For entry
 *                    is the client
 *   n (integer)      the n hops nearest to this server are trusted
 *   address / CIDR   a hop is trusted when its address is in the list;
 *   (or a list)      `loopback`, `linklocal` and `uniquelocal` name the usual
 *                    private ranges
 *
 * Hop 0 is the peer the socket is connected to, hop 1 the last
 * X-Forwarded-For entry, and so on leftwards. The client is the first
 * address, walking outwards from the socket, that is not trusted (or the
 * left-most entry when every hop is).
 */
import { requireBuiltin } from '../../utilities/builtin.js';

/** What `server.trustProxy` accepts. */
export type TrustProxySetting = boolean | number | string | readonly string[];

/**
 * A compiled `server.trustProxy`: whether the address `hop` proxies away from
 * this server (0 = the connected peer) is a trusted proxy.
 */
export interface ProxyTrust {
  (address: string, hop: number): boolean;
  /**
   * Set when trust in the connected peer is the same whatever its address
   * (`true`, `false`, a hop count), so that address need not be read to
   * decide whether X-Forwarded-Proto / X-Forwarded-Host count.
   */
  readonly peer?: boolean;
}

const NAMED_RANGES: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** `::ffff:10.0.0.1` (an IPv4 peer on a dual-stack socket) as `10.0.0.1`. */
function plainAddress(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  return mapped ? (mapped[1] as string) : address;
}

function withPeer(fn: (address: string, hop: number) => boolean, peer?: boolean): ProxyTrust {
  return peer === undefined ? fn : Object.assign(fn, { peer });
}

/** The entries of a list setting: an array, or one string with commas. */
function listEntries(setting: string | readonly string[]): string[] {
  const parts = typeof setting === 'string' ? setting.split(',') : setting;
  const entries: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      throw new TypeError(`trustProxy entries must be strings, got ${typeof part}`);
    }
    const entry = part.trim();
    if (entry !== '') entries.push(entry);
  }
  return entries;
}

function compileList(setting: string | readonly string[]): ProxyTrust {
  const net = requireBuiltin<typeof import('net')>('net');
  const entries = listEntries(setting);
  if (entries.length === 0) {
    throw new TypeError('trustProxy list is empty: name at least one address or range');
  }

  const trusted = new net.BlockList();
  const add = (range: string, written: string): void => {
    const slash = range.indexOf('/');
    const address = plainAddress(slash === -1 ? range : range.slice(0, slash));
    const family = net.isIP(address);
    if (family === 0) {
      throw new TypeError(
        `trustProxy: '${written}' is not an IP address, a CIDR range, or one of ` +
          `'loopback', 'linklocal', 'uniquelocal'`
      );
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (slash === -1) {
      trusted.addAddress(address, type);
      return;
    }
    const bits = range.slice(slash + 1);
    const prefix = Number(bits);
    if (!/^\d{1,3}$/.test(bits) || prefix > (family === 6 ? 128 : 32)) {
      throw new TypeError(`trustProxy: '${written}' has an invalid prefix length`);
    }
    trusted.addSubnet(address, prefix, type);
  };

  for (const entry of entries) {
    const named = NAMED_RANGES[entry.toLowerCase()];
    if (named) {
      for (const range of named) add(range, entry);
    } else {
      add(entry, entry);
    }
  }

  return (address: string): boolean => {
    const plain = plainAddress(address);
    const family = net.isIP(plain);
    return family !== 0 && trusted.check(plain, family === 6 ? 'ipv6' : 'ipv4');
  };
}

/**
 * Compile a `server.trustProxy` value. Returns undefined when the setting is
 * absent, which the servers read as "handle forwarded headers as before the
 * setting existed". Throws a TypeError naming the problem for a value that is
 * not one of the accepted forms.
 */
export function compileTrustProxy(setting: unknown): ProxyTrust | undefined {
  if (setting === undefined || setting === null) return undefined;

  if (setting === true) return withPeer(() => true, true);
  if (setting === false) return withPeer(() => false, false);

  if (typeof setting === 'number') {
    if (!Number.isInteger(setting) || setting < 0) {
      throw new TypeError('trustProxy as a number is a hop count: a whole number, 0 or more');
    }
    const hops = setting;
    return withPeer((_address, hop) => hop < hops, hops > 0);
  }

  if (typeof setting === 'string' || Array.isArray(setting)) {
    return compileList(setting as string | readonly string[]);
  }

  throw new TypeError(
    'trustProxy must be true, false, a hop count, an address / CIDR range, or a list of them'
  );
}

/** The entries of an X-Forwarded-For value, left to right. */
function forwardedEntries(forwardedFor: string | undefined): string[] {
  if (!forwardedFor) return [];
  const entries: string[] = [];
  for (const part of forwardedFor.split(',')) {
    const entry = part.trim();
    if (entry !== '') entries.push(entry);
  }
  return entries;
}

/**
 * The connection's address chain, nearest first: the connected peer, then
 * the X-Forwarded-For entries from right to left, ending with the first
 * address that is not a trusted proxy (the client).
 */
function trustedChain(peer: string, forwardedFor: string | undefined, trust: ProxyTrust): string[] {
  const chain = [peer];
  const entries = forwardedEntries(forwardedFor);
  for (let i = entries.length - 1; i >= 0; i--) {
    // The address just added is hop chain.length - 1: go further out only
    // when it is a proxy that is believed
    if (!trust(chain[chain.length - 1] as string, chain.length - 1)) break;
    chain.push(entries[i] as string);
  }
  return chain;
}

/** `req.ip`: the client's address as far as the trusted proxies vouch for it. */
export function clientAddress(
  peer: string,
  forwardedFor: string | undefined,
  trust: ProxyTrust
): string {
  // Nothing forwarded, or a peer that is not believed: the peer is the client
  if (!forwardedFor || trust.peer === false) return peer;
  const chain = trustedChain(peer, forwardedFor, trust);
  return chain[chain.length - 1] as string;
}

/**
 * `req.ips`: the client followed by each trusted proxy it came through,
 * without the connected peer. Empty when the peer is not trusted.
 */
export function forwardedAddresses(
  peer: string,
  forwardedFor: string | undefined,
  trust: ProxyTrust
): string[] {
  if (!forwardedFor || trust.peer === false) return [];
  const chain = trustedChain(peer, forwardedFor, trust);
  chain.shift();
  return chain.reverse();
}

/** The first value of a forwarded header that may list several (`https, http`). */
export function firstForwarded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const comma = value.indexOf(',');
  const first = (comma === -1 ? value : value.slice(0, comma)).trim();
  return first === '' ? undefined : first;
}
