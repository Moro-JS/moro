/**
 * Unified SSL/TLS configuration.
 *
 * MoroJS historically carried TWO incompatible SSL shapes:
 *   - `config.server.ssl` = file paths         { key_file_name, cert_file_name, passphrase }
 *   - `options.https`      = node-style buffers { key, cert, ca }
 * and each reached only one runtime. This module normalizes both into ONE
 * internal shape and projects it back out for each server (the native engine,
 * Node https, HTTP/2), so a single `server.ssl` config flows everywhere.
 */
import { readFileSync } from 'fs';
import type { MoroLogger } from '../../logger/index.js';

/** Raw, un-normalized SSL config as a user may supply it (either shape). */
export interface SSLConfigInput {
  // File-path shape (also accepted: node-style keyFile/certFile)
  key_file_name?: string;
  cert_file_name?: string;
  ca_file_name?: string | string[];
  keyFile?: string;
  certFile?: string;
  caFile?: string | string[];
  // Inline shape (node-style)
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer | Array<string | Buffer>;
  passphrase?: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  // Handshake policy, with the meaning Node's tls.createSecureContext gives
  // each key (see TLS_POLICY_KEYS for which server applies which)
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
  honorCipherOrder?: boolean;
  ecdhCurve?: string;
  sigalgs?: string;
  crl?: string | Buffer | Array<string | Buffer>;
  /**
   * Watch the key/cert (and CA) files and reload the certificate when they
   * change (`app.reloadTLS()` under the hood), the way an ACME client rotates
   * them. File-path shape only. `true` = 1000 ms debounce.
   */
  watch?: boolean | { debounceMs?: number };
}

/** Canonical internal SSL config after normalization. */
export interface NormalizedSSLConfig {
  keyFile?: string | undefined;
  certFile?: string | undefined;
  caFile?: string[] | undefined;
  key?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  ca?: Array<string | Buffer> | undefined;
  passphrase?: string | undefined;
  minVersion?: 'TLSv1.2' | 'TLSv1.3' | undefined;
  requestCert?: boolean | undefined;
  rejectUnauthorized?: boolean | undefined;
  maxVersion?: 'TLSv1.2' | 'TLSv1.3' | undefined;
  ciphers?: string | undefined;
  honorCipherOrder?: boolean | undefined;
  ecdhCurve?: string | undefined;
  sigalgs?: string | undefined;
  crl?: string | Buffer | Array<string | Buffer> | undefined;
}

/**
 * The handshake-policy keys of server.ssl beyond the certificate material.
 * Each is handed to Node's TLS (the Node HTTPS server and the HTTP/2 server)
 * exactly as written.
 */
export const TLS_POLICY_KEYS = [
  'minVersion',
  'maxVersion',
  'requestCert',
  'rejectUnauthorized',
  'ciphers',
  'honorCipherOrder',
  'ecdhCurve',
  'sigalgs',
  'crl',
] as const;

/**
 * Every option the Node projection (sslForNode) can carry, which is what the
 * HTTPS and HTTP/2 servers copy into tls.createServer.
 */
export const NODE_TLS_OPTION_KEYS = [
  'key',
  'cert',
  'ca',
  'passphrase',
  ...TLS_POLICY_KEYS,
] as const;

/** server.ssl as Node's tls.createServer / tls.createSecureContext take it. */
export interface NodeTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  ca?: Array<string | Buffer>;
  passphrase?: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  ciphers?: string;
  honorCipherOrder?: boolean;
  ecdhCurve?: string;
  sigalgs?: string;
  crl?: string | Buffer | Array<string | Buffer>;
}

/**
 * Policy keys the native engine has no option for. `ciphers` and `ecdhCurve`
 * are applied by engines that report the `tlsPolicy` capability.
 */
const ENGINE_UNSUPPORTED_POLICY_KEYS = [
  'maxVersion',
  'honorCipherOrder',
  'sigalgs',
  'crl',
] as const;
const ENGINE_TLS_POLICY_CAPABILITY_KEYS = ['ciphers', 'ecdhCurve'] as const;

/**
 * The keys of a normalized config that the native engine will not apply:
 * those it has no option for, and the cipher / curve policy on an engine
 * build without the `tlsPolicy` capability. Empty when everything that is set
 * reaches the engine.
 */
export function engineUnappliedSSLKeys(ssl: NormalizedSSLConfig, tlsPolicy: boolean): string[] {
  const keys: string[] = ENGINE_UNSUPPORTED_POLICY_KEYS.filter(key => ssl[key] !== undefined);
  if (!tlsPolicy) {
    keys.push(...ENGINE_TLS_POLICY_CAPABILITY_KEYS.filter(key => ssl[key] !== undefined));
  }
  return keys;
}

// Every server.ssl / options.https key that is read somewhere. A key outside
// this set is carried by neither the validator nor the per-server projections
// below, so it never reaches a TLS context.
const APPLIED_SSL_KEYS: ReadonlySet<string> = new Set([
  'key_file_name',
  'cert_file_name',
  'ca_file_name',
  'keyFile',
  'certFile',
  'caFile',
  'key',
  'cert',
  'ca',
  'passphrase',
  ...TLS_POLICY_KEYS,
  'library',
  'watch',
]);

/**
 * The keys of an SSL config that are set but not applied to the listener:
 * any key the framework does not read (`dhparam`, `secureOptions`,
 * `sessionTimeout`, a misspelling, ...). Empty for a config made of supported
 * keys only.
 */
export function unappliedSSLKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const source = input as Record<string, unknown>;
  return Object.keys(source).filter(key => source[key] !== undefined && !APPLIED_SSL_KEYS.has(key));
}

/** One warning line naming the keys of `path` that are set but not applied. */
export function unappliedSSLKeysWarning(path: string, keys: string[]): string {
  return (
    `${path}: ${keys.map(key => `'${key}'`).join(', ')} ${keys.length > 1 ? 'are' : 'is'} set but NOT applied - ` +
    `the TLS listener runs without ${keys.length > 1 ? 'them' : 'it'}. ` +
    `Supported keys: key/cert/ca (or keyFile/certFile/caFile), passphrase, minVersion, ` +
    `maxVersion, requestCert, rejectUnauthorized, ciphers, honorCipherOrder, ecdhCurve, ` +
    `sigalgs, crl, library, watch.`
  );
}

const toArray = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

/**
 * Normalize the two historical SSL shapes into one. `serverSsl`
 * (config.server.ssl) wins over `optionsHttps` (options.https) when both are
 * present, matching the pre-existing precedence in framework.ts. Returns null
 * when neither carries any key/cert material (TLS simply off).
 */
export function normalizeSSLConfig(
  serverSsl?: SSLConfigInput | null,
  optionsHttps?: SSLConfigInput | null,
  logger?: MoroLogger
): NormalizedSSLConfig | null {
  if (serverSsl && optionsHttps) {
    logger?.warn('Both server.ssl and options.https are set; server.ssl takes precedence', 'SSL');
  }
  const src = serverSsl ?? optionsHttps;
  if (!src) return null;

  // server.ssl has been through the config validator, which reports and drops
  // these keys itself; this covers a config handed over directly
  // (options.https, app.reloadTLS()).
  if (logger) {
    const unapplied = unappliedSSLKeys(src);
    if (unapplied.length > 0) {
      logger.warn(
        unappliedSSLKeysWarning(serverSsl ? 'server.ssl' : 'options.https', unapplied),
        'SSL'
      );
    }
  }

  const out: NormalizedSSLConfig = {
    keyFile: src.keyFile ?? src.key_file_name,
    certFile: src.certFile ?? src.cert_file_name,
    caFile: toArray(src.caFile ?? src.ca_file_name),
    key: src.key,
    cert: src.cert,
    ca: toArray(src.ca),
    passphrase: src.passphrase,
    minVersion: src.minVersion,
    requestCert: src.requestCert,
    rejectUnauthorized: src.rejectUnauthorized,
    maxVersion: src.maxVersion,
    ciphers: src.ciphers,
    honorCipherOrder: src.honorCipherOrder,
    ecdhCurve: src.ecdhCurve,
    sigalgs: src.sigalgs,
    crl: src.crl,
  };

  const hasKey = Boolean(out.key || out.keyFile);
  const hasCert = Boolean(out.cert || out.certFile);
  if (!hasKey && !hasCert) return null; // nothing usable -> TLS off
  return out;
}

/** True when the config actually carries a key+cert (complete TLS material). */
export function sslIsComplete(ssl: NormalizedSSLConfig): boolean {
  return Boolean((ssl.key || ssl.keyFile) && (ssl.cert || ssl.certFile));
}

/**
 * Project for the Node http/https and HTTP/2 servers: node's tls API wants
 * key/cert/ca as strings or Buffers, so any file paths are read here.
 */
export function sslForNode(ssl: NormalizedSSLConfig): NodeTlsOptions {
  const key = ssl.key ?? (ssl.keyFile ? readFileSync(ssl.keyFile) : undefined);
  const cert = ssl.cert ?? (ssl.certFile ? readFileSync(ssl.certFile) : undefined);
  const ca = ssl.ca ?? (ssl.caFile ? ssl.caFile.map(p => readFileSync(p)) : undefined);
  if (!key || !cert) {
    throw new Error('sslForNode requires both a key and a certificate');
  }
  return {
    key,
    cert,
    ...(ca && { ca }),
    ...(ssl.passphrase && { passphrase: ssl.passphrase }),
    ...(ssl.minVersion && { minVersion: ssl.minVersion }),
    ...(ssl.requestCert !== undefined && { requestCert: ssl.requestCert }),
    ...(ssl.rejectUnauthorized !== undefined && {
      rejectUnauthorized: ssl.rejectUnauthorized,
    }),
    ...(ssl.maxVersion && { maxVersion: ssl.maxVersion }),
    ...(ssl.ciphers && { ciphers: ssl.ciphers }),
    ...(ssl.honorCipherOrder !== undefined && { honorCipherOrder: ssl.honorCipherOrder }),
    ...(ssl.ecdhCurve && { ecdhCurve: ssl.ecdhCurve }),
    ...(ssl.sigalgs && { sigalgs: ssl.sigalgs }),
    ...(ssl.crl !== undefined && { crl: ssl.crl }),
  };
}

/** Several PEM certificates as one PEM bundle. */
function pemBundle(parts: Array<string | Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(typeof part === 'string' ? Buffer.from(part) : part, Buffer.from('\n'));
  }
  return Buffer.concat(chunks);
}

/**
 * A `ciphers` value as Node reads it: names that start with `TLS_` select
 * the TLS 1.3 suites, everything else is the OpenSSL cipher list for TLS 1.2
 * and below. The engine takes the two as separate options.
 */
function splitCiphers(ciphers: string): { list: string; suites: string } {
  const list: string[] = [];
  const suites: string[] = [];
  for (const name of ciphers.split(':')) {
    if (name === '') continue;
    (name.startsWith('TLS_') || name.startsWith('!TLS_') ? suites : list).push(name);
  }
  return { list: list.join(':'), suites: suites.join(':') };
}

/**
 * Project for the native @morojs/engine serve() options.ssl, which accepts
 * BOTH shapes (file paths and inline PEM) and prefers inline. Pass everything
 * through; the engine decides.
 *
 * The engine takes ONE CA per slot (`ca_file_name` / `ca`). A list of
 * certificates is handed over as one PEM bundle, which the engine reads in
 * full, so every CA of the list is trusted as on the Node servers; a list of
 * CA files is read here for the same reason.
 */
export function sslForEngine(ssl: NormalizedSSLConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ssl.keyFile) out.key_file_name = ssl.keyFile;
  if (ssl.certFile) out.cert_file_name = ssl.certFile;
  if (ssl.key) out.key = ssl.key;
  if (ssl.cert) out.cert = ssl.cert;
  if (ssl.ca && ssl.ca[0]) {
    out.ca = ssl.ca.length === 1 ? ssl.ca[0] : pemBundle(ssl.ca);
  } else if (ssl.caFile && ssl.caFile[0]) {
    if (ssl.caFile.length === 1) out.ca_file_name = ssl.caFile[0];
    else out.ca = pemBundle(ssl.caFile.map(file => readFileSync(file)));
  }
  if (ssl.passphrase) out.passphrase = ssl.passphrase;
  if (ssl.minVersion) out.minVersion = ssl.minVersion;
  if (ssl.requestCert !== undefined) out.requestCert = ssl.requestCert;
  if (ssl.rejectUnauthorized !== undefined) out.rejectUnauthorized = ssl.rejectUnauthorized;
  // Cipher and curve policy (engines with the tlsPolicy capability). The
  // other policy keys have no engine option: engineUnappliedSSLKeys() names
  // them for the start-up warning.
  if (ssl.ciphers) {
    const { list, suites } = splitCiphers(ssl.ciphers);
    if (list) out.ciphers = list;
    if (suites) out.ciphersuites = suites;
  }
  if (ssl.ecdhCurve) out.ecdhCurve = ssl.ecdhCurve;
  return out;
}
