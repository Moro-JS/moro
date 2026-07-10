/**
 * Unified SSL/TLS configuration.
 *
 * MoroJS historically carried TWO incompatible SSL shapes:
 *   - `config.server.ssl` = uWS-style file paths { key_file_name, cert_file_name, passphrase }
 *   - `options.https`      = node-style buffers    { key, cert, ca }
 * and each reached only one runtime (uWS / http2 respectively). This module
 * normalizes both into ONE internal shape and projects it back out for each
 * of the four servers (Node https, uWS SSLApp, HTTP/2, the native engine), so
 * a single `server.ssl` config flows everywhere.
 */
import { readFileSync } from 'fs';
import type { MoroLogger } from '../../logger/index.js';

/** Raw, un-normalized SSL config as a user may supply it (either shape). */
export interface SSLConfigInput {
  // File-path shape (uWS-style; also accepted node-style keyFile/certFile)
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
}

/** Canonical internal SSL config after normalization. */
export interface NormalizedSSLConfig {
  keyFile?: string;
  certFile?: string;
  caFile?: string[];
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: Array<string | Buffer>;
  passphrase?: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
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
export function sslForNode(ssl: NormalizedSSLConfig): {
  key: string | Buffer;
  cert: string | Buffer;
  ca?: Array<string | Buffer>;
  passphrase?: string;
  minVersion?: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
} {
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
  };
}

/**
 * Project for uWebSockets.js SSLApp, which requires FILE PATHS (it has no
 * inline-PEM option). Returns null when only inline PEM is available so the
 * caller can log a clear error instead of silently booting plain HTTP.
 */
export function sslForUws(ssl: NormalizedSSLConfig): {
  key_file_name: string;
  cert_file_name: string;
  ca_file_name?: string;
  passphrase?: string;
} | null {
  if (!ssl.keyFile || !ssl.certFile) return null;
  return {
    key_file_name: ssl.keyFile,
    cert_file_name: ssl.certFile,
    ...(ssl.caFile && ssl.caFile[0] && { ca_file_name: ssl.caFile[0] }),
    ...(ssl.passphrase && { passphrase: ssl.passphrase }),
  };
}

/**
 * Project for the native @morojs/engine serve() options.ssl, which accepts
 * BOTH shapes (file paths and inline PEM) and prefers inline. Pass everything
 * through; the engine decides.
 */
export function sslForEngine(ssl: NormalizedSSLConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ssl.keyFile) out.key_file_name = ssl.keyFile;
  if (ssl.certFile) out.cert_file_name = ssl.certFile;
  if (ssl.caFile && ssl.caFile[0]) out.ca_file_name = ssl.caFile[0];
  if (ssl.key) out.key = ssl.key;
  if (ssl.cert) out.cert = ssl.cert;
  if (ssl.ca && ssl.ca[0]) out.ca = ssl.ca[0];
  if (ssl.passphrase) out.passphrase = ssl.passphrase;
  if (ssl.minVersion) out.minVersion = ssl.minVersion;
  if (ssl.requestCert !== undefined) out.requestCert = ssl.requestCert;
  if (ssl.rejectUnauthorized !== undefined) out.rejectUnauthorized = ssl.rejectUnauthorized;
  return out;
}
