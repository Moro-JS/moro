// Minimal stand-in for the parts of `jsonwebtoken` the framework uses:
// verify(token, secret, options) for HS256 with the algorithm allow-list, the
// signature, `exp`, `nbf`, `audience` and `issuer` checks and the package's
// error names, and sign(payload, secret) to make tokens for it.
// jsonwebtoken is an optional peer and is not installed in this repository.
/* global Buffer */
'use strict';

const crypto = require('crypto');

const b64url = value => Buffer.from(value).toString('base64url');

function fail(name, message, extra) {
  const error = new Error(message);
  error.name = name;
  throw Object.assign(error, extra);
}

function sign(payload, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  if (header.alg === 'none') return `${head}.`;
  return `${head}.${crypto.createHmac('sha256', secret).update(head).digest('base64url')}`;
}

function verify(token, secret, options = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) fail('JsonWebTokenError', 'jwt malformed');
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    fail('JsonWebTokenError', 'invalid token');
  }
  if (!parts[2]) fail('JsonWebTokenError', 'jwt signature is required');
  const algorithms = options.algorithms || ['HS256'];
  if (!algorithms.includes(header.alg)) fail('JsonWebTokenError', 'invalid algorithm');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest('base64url');
  if (expected !== parts[2]) fail('JsonWebTokenError', 'invalid signature');

  const now = Date.now();
  if (payload.nbf !== undefined && payload.nbf * 1000 > now) {
    fail('NotBeforeError', 'jwt not active', { date: new Date(payload.nbf * 1000) });
  }
  if (payload.exp !== undefined && payload.exp * 1000 <= now) {
    fail('TokenExpiredError', 'jwt expired', { expiredAt: new Date(payload.exp * 1000) });
  }
  if (options.audience !== undefined) {
    const wanted = [].concat(options.audience);
    const given = [].concat(payload.aud === undefined ? [] : payload.aud);
    if (!given.some(aud => wanted.includes(aud))) {
      fail('JsonWebTokenError', `jwt audience invalid. expected: ${wanted.join(' or ')}`);
    }
  }
  if (options.issuer !== undefined && ![].concat(options.issuer).includes(payload.iss)) {
    fail('JsonWebTokenError', 'jwt issuer invalid');
  }
  return payload;
}

module.exports = { sign, verify };
