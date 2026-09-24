// Request-body text/binary classification, shared by the Node, uWS and native
// engine servers so `req.body` has the same shape on every backend.
//
// JSON, urlencoded and multipart bodies are parsed into objects upstream of
// this. For everything else the question is whether decoding the bytes as
// UTF-8 is lossless: a text body arriving as a Buffer is one toString() away
// from what the handler wanted, but a binary body decoded to a string is
// corrupted for good (every invalid sequence becomes U+FFFD), and there is no
// other way to reach the bytes. So the default for an unknown type is Buffer.

/** application/* subtypes that are text on the wire */
const TEXT_APPLICATION_SUBTYPES = new Set([
  'json',
  'xml',
  'javascript',
  'ecmascript',
  'x-javascript',
  'x-www-form-urlencoded',
  'graphql',
  'sql',
  'yaml',
  'x-yaml',
  'toml',
  'csv',
  'ndjson',
  'x-ndjson',
  'jsonl',
  'x-sh',
  'xhtml',
  'ld+json',
  'problem+json',
  'soap+xml',
]);

/** Structured-syntax suffixes (RFC 6838) that are always text */
const TEXT_SUFFIXES = ['+json', '+xml', '+yaml', '+toml'];

/**
 * True when a request body with this Content-Type decodes to a string,
 * false when it must stay a Buffer.
 *
 * Rule: a missing Content-Type keeps the historical string behaviour;
 * `text/*` and anything declaring a `charset` are text; `application/*` is
 * text for the JSON/XML/JS/YAML family (including `+json`-style suffixes);
 * every other type (`application/octet-stream`, `image/*`, `audio/*`,
 * `video/*`, `font/*`, `application/pdf`, `application/zip`, protobuf,
 * msgpack, ...) is binary.
 */
export function bodyIsText(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const semi = contentType.indexOf(';');
  const mime = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
  if (mime === '') return true;
  if (mime.startsWith('text/')) return true;
  if (semi !== -1 && /;\s*charset=/i.test(contentType)) return true;
  if (mime.startsWith('application/')) {
    const subtype = mime.slice('application/'.length);
    if (TEXT_APPLICATION_SUBTYPES.has(subtype)) return true;
    for (const suffix of TEXT_SUFFIXES) {
      if (subtype.endsWith(suffix)) return true;
    }
    return false;
  }
  // message/*, model/*, image/*, audio/*, video/*, font/*, ...
  return false;
}
