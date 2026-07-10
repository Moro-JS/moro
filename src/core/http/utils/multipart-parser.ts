// Shared multipart/form-data parser used by both the Node http server and the
// native engine server, so uploads behave identically on either transport.
// Operates on Buffers throughout - converting the payload to a string would
// corrupt binary file content.
//
// RFC 7578 (multipart/form-data) over RFC 2046 §5.1.1 framing:
//   - boundary parameter may be quoted and may be followed by other
//     Content-Type parameters
//   - parts are delimited by CRLF "--" boundary; the first delimiter may
//     appear without the leading CRLF (no preamble)
//   - Content-Disposition parameters are parsed with real quoted-string
//     handling (a `filename` containing `name=` must not corrupt the field
//     name) and RFC 5987 `filename*` extended values are honored
//   - part/header counts are capped so a crafted body cannot amplify one
//     bounded upload into millions of allocations

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<
    string,
    {
      filename: string;
      mimetype: string;
      data: Buffer;
      size: number;
    }
  >;
}

export interface MultipartLimits {
  /** Maximum number of parts (fields + files) before parsing aborts */
  maxParts?: number;
  /** Maximum size of one part's header block in bytes */
  maxPartHeaderBytes?: number;
  /** Maximum number of file parts before parsing aborts (0/undefined = no limit) */
  maxFiles?: number;
  /** Maximum size in bytes of a single file part (0/undefined = no limit) */
  maxFileSize?: number;
}

const DEFAULT_MAX_PARTS = 1000;
const DEFAULT_MAX_PART_HEADER_BYTES = 16 * 1024;

/** Error thrown when a multipart limit is exceeded; carries a 413 statusCode
 *  so every server's existing entity-too-large handling picks it up. */
export class MultipartLimitError extends Error {
  statusCode = 413;
  constructor(message: string) {
    super(message);
    this.name = 'MultipartLimitError';
  }
}

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');
const CRLF_BUF = Buffer.from('\r\n');

/**
 * Extract the boundary parameter from a Content-Type value, honoring quoted
 * boundaries and ignoring any parameters that follow it.
 */
function extractBoundary(contentType: string): string | null {
  const match = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(contentType);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? '').trim();
  return raw || null;
}

/**
 * Parse the parameters of a Content-Disposition value with quoted-string and
 * quoted-pair handling. Returns a Map (not a plain object) so parameter names
 * like __proto__ cannot interfere with lookups. First occurrence wins.
 */
function parseDispositionParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  let i = value.indexOf(';');
  while (i !== -1 && i < value.length) {
    i++; // past ';'
    while (i < value.length && (value[i] === ' ' || value[i] === '\t')) i++;
    const eq = value.indexOf('=', i);
    if (eq === -1) break;
    const key = value.slice(i, eq).trim().toLowerCase();
    let val: string;
    let j = eq + 1;
    while (j < value.length && (value[j] === ' ' || value[j] === '\t')) j++;
    if (value[j] === '"') {
      j++;
      const start = j;
      while (j < value.length && value[j] !== '"') {
        if (value[j] === '\\' && j + 1 < value.length) j++; // quoted-pair
        j++;
      }
      val = value.slice(start, j).replace(/\\(.)/g, '$1');
      i = value.indexOf(';', j + 1);
    } else {
      const end = value.indexOf(';', j);
      val = (end === -1 ? value.slice(j) : value.slice(j, end)).trim();
      i = end;
    }
    if (key && !params.has(key)) params.set(key, val);
  }
  return params;
}

/** Decode an RFC 5987 extended value (charset'lang'percent-encoded). */
function decodeExtendedValue(value: string): string | null {
  const match = /^(utf-8|iso-8859-1)'[^']*'(.+)$/i.exec(value);
  if (!match) return null;
  try {
    if (match[1].toLowerCase() === 'utf-8') {
      return decodeURIComponent(match[2]);
    }
    return match[2].replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  } catch {
    return null;
  }
}

/**
 * Parse a buffered multipart/form-data payload into fields and files.
 * Duplicate part names are last-wins (matching URLSearchParams-style access).
 * @throws Error when the content type carries no boundary or the part count
 *   exceeds the limit
 */
export function parseMultipart(
  buffer: Buffer,
  contentType: string,
  limits?: MultipartLimits
): ParsedMultipart {
  const boundary = extractBoundary(contentType);
  if (!boundary) {
    throw new Error('Invalid multipart boundary');
  }
  const maxParts = limits?.maxParts ?? DEFAULT_MAX_PARTS;
  const maxHeaderBytes = limits?.maxPartHeaderBytes ?? DEFAULT_MAX_PART_HEADER_BYTES;
  const maxFiles = limits?.maxFiles ?? 0; // 0 = no limit
  const maxFileSize = limits?.maxFileSize ?? 0; // 0 = no limit
  const fileCount = { n: 0 };

  // Null-prototype objects: a part named "__proto__" is stored as a plain own
  // key instead of silently vanishing into the prototype setter.
  const fields: ParsedMultipart['fields'] = Object.create(null);
  const files: ParsedMultipart['files'] = Object.create(null);

  const dashBoundary = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);

  // Locate the first delimiter: at the very start it appears without the
  // leading CRLF; otherwise a preamble precedes it (RFC 2046 §5.1.1).
  let pos: number;
  if (buffer.subarray(0, dashBoundary.length).equals(dashBoundary)) {
    pos = dashBoundary.length;
  } else {
    const first = buffer.indexOf(delimiter);
    if (first === -1) return { fields, files };
    pos = first + delimiter.length;
  }

  let partCount = 0;
  for (;;) {
    // After the boundary token: "--" marks the closing delimiter; otherwise
    // optional padding then CRLF starts the part.
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    const lineEnd = buffer.indexOf(CRLF_BUF, pos);
    if (lineEnd === -1) break;
    const partStart = lineEnd + 2;
    const next = buffer.indexOf(delimiter, partStart);
    const partEnd = next === -1 ? buffer.length : next;

    if (++partCount > maxParts) {
      throw new MultipartLimitError(`Multipart payload exceeds ${maxParts} parts`);
    }
    // The delimiter includes the part's trailing CRLF, so the slice is the
    // exact content - no trailing-byte trimming needed.
    parsePart(buffer.subarray(partStart, partEnd), fields, files, maxHeaderBytes, {
      maxFiles,
      maxFileSize,
      fileCount,
    });

    if (next === -1) break;
    pos = next + delimiter.length;
  }

  return { fields, files };
}

function parsePart(
  part: Buffer,
  fields: ParsedMultipart['fields'],
  files: ParsedMultipart['files'],
  maxHeaderBytes: number,
  fileLimits: { maxFiles: number; maxFileSize: number; fileCount: { n: number } }
): void {
  const headerEndPos = part.indexOf(HEADER_SEPARATOR);
  if (headerEndPos === -1 || headerEndPos > maxHeaderBytes) return;

  // Headers are always text - safe to convert to string
  const headerText = part.subarray(0, headerEndPos).toString('utf8');
  // Content stays as Buffer to preserve binary data
  const content = part.subarray(headerEndPos + HEADER_SEPARATOR.length);

  let disposition: string | undefined;
  let partContentType: string | undefined;
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const headerName = line.slice(0, colon).trim().toLowerCase();
    if (headerName === 'content-disposition') {
      disposition = line.slice(colon + 1).trim();
    } else if (headerName === 'content-type') {
      partContentType = line.slice(colon + 1).trim();
    }
  }
  if (!disposition) return;

  const params = parseDispositionParams(disposition);
  const name = params.get('name');
  // A part without a name cannot be keyed - never fall back to the
  // (attacker-controlled) filename as the key.
  if (!name) return;

  // filename* (RFC 5987) takes precedence over filename (RFC 6266 §4.3)
  const extendedFilename = params.has('filename*')
    ? decodeExtendedValue(params.get('filename*') as string)
    : null;
  const filename = extendedFilename ?? params.get('filename');

  if (filename !== undefined && filename !== null) {
    if (fileLimits.maxFileSize && content.length > fileLimits.maxFileSize) {
      throw new MultipartLimitError(
        `Uploaded file '${filename}' exceeds ${fileLimits.maxFileSize} bytes`
      );
    }
    if (fileLimits.maxFiles && ++fileLimits.fileCount.n > fileLimits.maxFiles) {
      throw new MultipartLimitError(`Multipart payload exceeds ${fileLimits.maxFiles} files`);
    }
    files[name] = {
      filename,
      mimetype: partContentType || 'application/octet-stream',
      data: content,
      size: content.length,
    };
  } else {
    fields[name] = content.toString('utf8');
  }
}
