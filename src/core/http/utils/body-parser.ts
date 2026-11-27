// The parsing step of a buffered request body, shared by the Node http server
// and the HTTP/2 server so the same bytes fail (or parse) the same way on
// both: which media types are parsed, what an empty JSON body means, and
// which status a body that cannot be parsed is answered with. The urlencoded
// parser, with its cap on the number of fields, is the native engine server's
// as well.
import {
  bodyIsText,
  isJsonMediaType,
  isMultipartMediaType,
  isUrlEncodedMediaType,
} from './body-type.js';
import { parseMultipart, type MultipartLimits } from './multipart-parser.js';

/** A request body over its size limit: answered 413 by the server's error path. */
export function payloadTooLarge(message: string, limit: number, received?: number): Error {
  const error: any = new Error(message);
  error.statusCode = 413;
  error.limit = limit;
  if (received !== undefined) error.received = received;
  return error;
}

/** server.limits.form.maxFields when no configuration reaches the parser. */
export const DEFAULT_MAX_FORM_FIELDS = 1000;

export interface FormLimits {
  /** Maximum number of fields in one urlencoded body before parsing aborts */
  maxFields?: number;
}

/** The limits a buffered body is parsed under (server.limits.multipart / .form). */
export interface BodyParseLimits {
  multipart?: MultipartLimits;
  form?: FormLimits;
}

/** Error thrown for a urlencoded body with more fields than the limit; carries
 *  a 413 statusCode, as a multipart body over one of its limits does, so every
 *  server's existing entity-too-large handling picks it up. */
export class FormLimitError extends Error {
  statusCode = 413;
  /** The limit the body went over */
  limit: number;
  constructor(maxFields: number) {
    super(`Form body exceeds ${maxFields} fields (server.limits.form.maxFields)`);
    this.name = 'FormLimitError';
    this.limit = maxFields;
  }
}

/**
 * Parse the text of an application/x-www-form-urlencoded body into an object
 * of its fields, the last value of a repeated name winning. Shared by every
 * server, so the same body parses, or is refused, the same way on each.
 *
 * A body of more than `maxFields` fields throws a FormLimitError (413), and
 * does so before anything is parsed: decoding 100,000 one-byte fields takes
 * tens of milliseconds of CPU for a body of under a megabyte, which the body
 * size limit lets through. The fields are counted by their separators alone,
 * and the count stops as soon as it is over the limit, so a refused body
 * costs a scan of its first `maxFields` fields, and an accepted one a scan
 * that is small beside the parse that follows. An empty segment (`a=1&&b=2`,
 * a trailing `&`) is counted as a field although the parser skips it: the
 * count can be over by those, never under.
 */
export function parseUrlEncodedBody(
  text: string,
  maxFields: number = DEFAULT_MAX_FORM_FIELDS
): Record<string, string> {
  let fields = text.length === 0 ? 0 : 1;
  let at = -1;
  while (fields <= maxFields && (at = text.indexOf('&', at + 1)) !== -1) fields++;
  if (fields > maxFields) throw new FormLimitError(maxFields);

  const result: Record<string, string> = {};
  new URLSearchParams(text).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Parse a fully-read body by its Content-Type: JSON (an empty body is null),
 * urlencoded and multipart become objects; anything else is returned as text,
 * or as the Buffer itself when `keepBinary` is set and the type is not text.
 *
 * A body that cannot be parsed is a client error: the error thrown carries
 * `statusCode` 400 unless the parser already gave it one (a multipart or
 * form limit is a 413).
 */
export function parseBufferedBody(
  body: Buffer,
  contentType: string,
  limits: BodyParseLimits | undefined,
  keepBinary: boolean
): any {
  try {
    if (isJsonMediaType(contentType)) {
      // Empty JSON body -> null (parity with the engine server, and avoids
      // JSON.parse('') throwing on an empty POST).
      return body.length === 0 ? null : JSON.parse(body.toString());
    }
    if (isUrlEncodedMediaType(contentType)) {
      return parseUrlEncodedBody(body.toString(), limits?.form?.maxFields);
    }
    if (isMultipartMediaType(contentType)) {
      return parseMultipart(body, contentType, limits?.multipart);
    }
    // Text decodes to a string; binary (octet-stream, images, protobuf, ...)
    // stays a Buffer where the server keeps it - decoding it would corrupt it
    // irreversibly.
    return !keepBinary || bodyIsText(contentType) ? body.toString() : body;
  } catch (error) {
    if (error instanceof Error && (error as any).statusCode === undefined) {
      (error as any).statusCode = 400;
    }
    throw error;
  }
}
