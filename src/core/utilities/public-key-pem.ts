// Recognising PEM public key material handed to a JWT verifier.
// Shared by safeVerifyJWT and the worker-thread JWT task.

// What an RS256 / ES256 / PS256 token is verified with: a public key (SPKI or
// PKCS#1) or a certificate
const PUBLIC_KEY_PEM = /-----BEGIN (?:CERTIFICATE|PUBLIC KEY|RSA PUBLIC KEY)-----/;

/**
 * Whether `secret` is a PEM public key or certificate, as a string or as bytes.
 *
 * Such a key must never be the secret of an HMAC algorithm: anyone who holds
 * the public key could sign an HS256 token with it, and jsonwebtoken 8 and
 * earlier accept that token.
 */
export function isPublicKeyPem(secret: unknown): boolean {
  if (typeof secret === 'string') return PUBLIC_KEY_PEM.test(secret);
  if (secret instanceof Uint8Array) return PUBLIC_KEY_PEM.test(Buffer.from(secret).toString());
  return false;
}

/** What a verifier says when it is given a public key and no algorithms. */
export const PUBLIC_KEY_NEEDS_ALGORITHMS =
  "JWT verification with a public key requires options.algorithms, for example { algorithms: ['RS256'] }";
