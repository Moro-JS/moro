// The parsing step of a buffered request body, shared by the Node http server
// and the HTTP/2 server so the same bytes fail (or parse) the same way on
// both: which media types are parsed, what an empty JSON body means, and
// which status a body that cannot be parsed is answered with.
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

/**
 * Parse a fully-read body by its Content-Type: JSON (an empty body is null),
 * urlencoded and multipart become objects; anything else is returned as text,
 * or as the Buffer itself when `keepBinary` is set and the type is not text.
 *
 * A body that cannot be parsed is a client error: the error thrown carries
 * `statusCode` 400 unless the parser already gave it one (a multipart limit
 * is a 413).
 */
export function parseBufferedBody(
  body: Buffer,
  contentType: string,
  multipartLimits: MultipartLimits | undefined,
  keepBinary: boolean
): any {
  try {
    if (isJsonMediaType(contentType)) {
      // Empty JSON body -> null (parity with the engine server, and avoids
      // JSON.parse('') throwing on an empty POST).
      return body.length === 0 ? null : JSON.parse(body.toString());
    }
    if (isUrlEncodedMediaType(contentType)) {
      const result: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body.toString())) {
        result[key] = value;
      }
      return result;
    }
    if (isMultipartMediaType(contentType)) {
      return parseMultipart(body, contentType, multipartLimits);
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
