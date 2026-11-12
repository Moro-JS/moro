// Unit tests for the shared multipart/form-data parser (RFC 7578).
// These exercise the parser directly (not over HTTP) so boundary/header edge
// cases and DoS limits are asserted precisely.
import { describe, it, expect } from '@jest/globals';
import { parseMultipart } from '../../../src/core/http/utils/multipart-parser.js';

const CRLF = '\r\n';

// Build a well-formed multipart body from parts.
function buildBody(
  boundary: string,
  parts: Array<{ headers: string[]; body: string | Buffer }>
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`));
    chunks.push(Buffer.from(part.headers.join(CRLF) + CRLF + CRLF));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(chunks);
}

describe('multipart-parser', () => {
  it('parses a simple field', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="a"'], body: 'hello' },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(result.fields.a).toBe('hello');
  });

  it('handles a QUOTED boundary parameter', () => {
    const body = buildBody('ABC123', [
      { headers: ['Content-Disposition: form-data; name="a"'], body: 'v' },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary="ABC123"');
    expect(result.fields.a).toBe('v');
  });

  it('handles a boundary followed by other Content-Type parameters', () => {
    const body = buildBody('ABC123', [
      { headers: ['Content-Disposition: form-data; name="a"'], body: 'v' },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=ABC123; charset=utf-8');
    expect(result.fields.a).toBe('v');
  });

  it('keys a file by its name even when filename appears before name', () => {
    const body = buildBody('X', [
      {
        headers: ['Content-Disposition: form-data; filename="up.txt"; name="avatar"'],
        body: 'FILEDATA',
      },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(result.files.avatar).toBeDefined();
    expect(result.files.avatar.filename).toBe('up.txt');
    expect(result.files.up).toBeUndefined();
  });

  it('drops a part with no name rather than keying by filename', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; filename="secret.txt"'], body: 'x' },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(Object.keys(result.files)).toHaveLength(0);
    expect(Object.keys(result.fields)).toHaveLength(0);
  });

  it('decodes RFC 5987 filename* extended values and classifies as a file', () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const body = buildBody('X', [
      {
        headers: [
          'Content-Disposition: form-data; name="f"; filename*=UTF-8\'\'na%C3%AFve.txt',
          'Content-Type: application/octet-stream',
        ],
        body: binary,
      },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(result.files.f).toBeDefined();
    expect(result.files.f.filename).toBe('naïve.txt');
    expect(Buffer.compare(result.files.f.data, binary)).toBe(0);
    expect(result.fields.f).toBeUndefined();
  });

  it('preserves binary file content exactly (no CRLF/byte corruption)', () => {
    const binary = Buffer.from([0x0d, 0x0a, 0x00, 0xff, 0x2d, 0x2d, 0x42]);
    const body = buildBody('BOUND', [
      {
        headers: ['Content-Disposition: form-data; name="f"; filename="b.bin"'],
        body: binary,
      },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=BOUND');
    expect(Buffer.compare(result.files.f.data, binary)).toBe(0);
    expect(result.files.f.size).toBe(binary.length);
  });

  it('does not truncate a field value that contains the boundary token as text', () => {
    // Field value literally contains "--X" but not as a real CRLF-delimited boundary
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="note"'], body: 'see --X in text' },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(result.fields.note).toBe('see --X in text');
  });

  it('stores a field literally named __proto__ as an own property (no pollution, no loss)', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="__proto__"'], body: 'x' },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(Object.prototype.hasOwnProperty.call(result.fields, '__proto__')).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('enforces a maxParts limit (DoS defense)', () => {
    const parts = [];
    for (let i = 0; i < 50; i++) {
      parts.push({ headers: [`Content-Disposition: form-data; name="f${i}"`], body: 'x' });
    }
    const body = buildBody('X', parts);
    expect(() => parseMultipart(body, 'multipart/form-data; boundary=X', { maxParts: 10 })).toThrow(
      /parts/
    );
  });

  it('throws when the content type has no boundary', () => {
    expect(() => parseMultipart(Buffer.from('x'), 'multipart/form-data')).toThrow(/boundary/);
  });

  it('parses fields and files together in one body', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="user"'], body: 'moro' },
      {
        headers: ['Content-Disposition: form-data; name="doc"; filename="a.txt"'],
        body: 'DOC',
      },
    ]);
    const result = parseMultipart(body, 'multipart/form-data; boundary=X');
    expect(result.fields.user).toBe('moro');
    expect(result.files.doc.filename).toBe('a.txt');
    expect(result.files.doc.data.toString()).toBe('DOC');
  });
});

describe('multipart-parser: ordered parts and strict framing', () => {
  const type = 'multipart/form-data; boundary=X';

  it('keeps every part in order, repeated names included', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="file"; filename="a.bin"'], body: 'first' },
      { headers: ['Content-Disposition: form-data; name="note"'], body: 'text' },
      {
        headers: ['Content-Disposition: form-data; name="file"; filename="b.bin"'],
        body: 'second',
      },
    ]);
    const result = parseMultipart(body, type);
    expect(result.parts.map(p => [p.name, p.filename, p.data.toString()])).toEqual([
      ['file', 'a.bin', 'first'],
      ['note', undefined, 'text'],
      ['file', 'b.bin', 'second'],
    ]);
    // fields/files keep their last-wins shape
    expect(result.files.file.filename).toBe('b.bin');
    expect(result.fields.note).toBe('text');
  });

  it('records an unselected file input as a file part with an empty filename', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="file"; filename=""'], body: '' },
    ]);
    const result = parseMultipart(body, type);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.filename).toBe('');
    expect(result.parts[0]?.size).toBe(0);
  });

  it('records a text part with no filename as a non-file part', () => {
    const body = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="file"'], body: 'plain' },
    ]);
    const result = parseMultipart(body, type);
    expect(result.parts[0]?.filename).toBeUndefined();
    expect(result.files.file).toBeUndefined();
    expect(result.fields.file).toBe('plain');
  });

  it('throws when the closing delimiter is missing', () => {
    const complete = buildBody('X', [
      { headers: ['Content-Disposition: form-data; name="a"'], body: 'v' },
    ]);
    const truncated = complete.subarray(0, complete.length - Buffer.from(`--X--${CRLF}`).length);
    expect(() => parseMultipart(truncated, type)).toThrow(/closing delimiter/);
  });

  it('throws when the body never contains the boundary', () => {
    expect(() => parseMultipart(Buffer.from('--wrong--\r\n'), type)).toThrow(/boundary not found/);
    expect(() => parseMultipart(Buffer.alloc(0), type)).toThrow(/boundary not found/);
  });

  it('throws when a part has no header block', () => {
    const body = Buffer.from(`--X${CRLF}Content-Disposition: form-data; name="a"`);
    expect(() => parseMultipart(body, type)).toThrow();
  });
});
