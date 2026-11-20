// File Upload Tests - Binary Data Integrity
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createApp } from '../../../src/index.js';
import { Moro } from '../../../src/moro.js';
import http from 'http';
import { EventEmitter } from 'node:events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { UploadCore } from '../../../src/core/middleware/built-in/upload/index.js';
import { createUploadMiddleware } from '../../../src/core/middleware/built-in/upload/middleware.js';
import { registerUploadHooks } from '../../../src/core/middleware/built-in/upload/hook.js';
import {
  parseMultipart,
  MULTIPART_BODY,
  isMultipartBody,
} from '../../../src/core/http/utils/multipart-parser.js';

describe('File Upload - Binary Data Integrity', () => {
  let app: Moro;
  let server: http.Server;
  const PORT = 3891;

  beforeAll(async () => {
    app = await createApp({
      logging: {
        level: 'error', // Suppress logs during tests
      },
    });

    // Simple upload endpoint - no middleware restrictions
    // Files come from req.body.files (multipart parsing result)
    app.post('/upload', (req, res) => {
      const files = req.body?.files || req.files;

      if (!files || Object.keys(files).length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      return {
        success: true,
        files: Object.values(files).map((f: any) => ({
          filename: f.filename,
          mimetype: f.mimetype,
          size: f.size,
          data: f.data.toString('base64'), // Return as base64 for comparison
        })),
      };
    });

    await new Promise<void>(resolve => app.listen(PORT, () => resolve()));

    server = (app as any).coreFramework.httpServer.getServer();
  });

  afterAll(done => {
    if (server) {
      server.close(() => {
        app.close().then(() => done());
      });
    } else {
      app.close().then(() => done());
    }
  });

  it('should preserve binary data integrity for image files', async () => {
    // Create a fake PNG header (binary data)
    const pngHeader = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46, // Some binary data
    ]);

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    // Build multipart as Buffer to preserve binary data
    const body = Buffer.concat([
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="test.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      pngHeader,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`),
    ]);

    const response = await new Promise<any>(resolve => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path: '/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.files).toHaveLength(1);

    const uploadedFile = response.body.files[0];
    expect(uploadedFile.filename).toBe('test.png');
    expect(uploadedFile.mimetype).toBe('image/png');

    // Verify binary data integrity by comparing base64
    const receivedData = Buffer.from(uploadedFile.data, 'base64');
    expect(receivedData).toEqual(pngHeader);
  });

  it('should handle MP4 video binary data correctly', async () => {
    // MP4 file signature (ftyp box header)
    const mp4Data = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x20,
      0x66,
      0x74,
      0x79,
      0x70, // ftyp box
      0x69,
      0x73,
      0x6f,
      0x6d,
      0x00,
      0x00,
      0x02,
      0x00, // isom
      0x69,
      0x73,
      0x6f,
      0x6d,
      0x69,
      0x73,
      0x6f,
      0x32, // iso2
      0xff,
      0xfe,
      0xfd,
      0xfc,
      0x00,
      0x01,
      0x02,
      0x03, // Random binary
    ]);

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = Buffer.concat([
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="video"; filename="test.mp4"\r\n`),
      Buffer.from(`Content-Type: video/mp4\r\n\r\n`),
      mp4Data,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`),
    ]);

    const response = await new Promise<any>(resolve => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path: '/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const uploadedFile = response.body.files[0];
    expect(uploadedFile.filename).toBe('test.mp4');
    expect(uploadedFile.mimetype).toBe('video/mp4');

    // Verify exact binary match
    const receivedData = Buffer.from(uploadedFile.data, 'base64');
    expect(receivedData).toEqual(mp4Data);
  });

  it('should handle MP3 audio binary data correctly', async () => {
    // MP3 frame header with ID3 tag
    const mp3Data = Buffer.from([
      0x49,
      0x44,
      0x33,
      0x04,
      0x00,
      0x00,
      0x00,
      0x00, // ID3v2.4 header
      0xff,
      0xfb,
      0x90,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // MP3 sync word + header
      0x80,
      0x81,
      0x82,
      0x83,
      0x84,
      0x85,
      0x86,
      0x87, // Random audio data
    ]);

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = Buffer.concat([
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="audio"; filename="test.mp3"\r\n`),
      Buffer.from(`Content-Type: audio/mpeg\r\n\r\n`),
      mp3Data,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`),
    ]);

    const response = await new Promise<any>(resolve => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path: '/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const uploadedFile = response.body.files[0];
    expect(uploadedFile.filename).toBe('test.mp3');
    expect(uploadedFile.mimetype).toBe('audio/mpeg');

    // Verify exact binary match
    const receivedData = Buffer.from(uploadedFile.data, 'base64');
    expect(receivedData).toEqual(mp3Data);
  });

  it('should handle PDF binary data correctly', async () => {
    // PDF file header
    const pdfData = Buffer.from([
      0x25,
      0x50,
      0x44,
      0x46,
      0x2d,
      0x31,
      0x2e,
      0x34, // %PDF-1.4
      0x0a,
      0x25,
      0xe2,
      0xe3,
      0xcf,
      0xd3,
      0x0a,
      0x00, // Binary comment
      0x01,
      0x02,
      0x03,
      0x04,
      0xff,
      0xfe,
      0xfd,
      0xfc, // Random binary
    ]);

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = Buffer.concat([
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="document"; filename="test.pdf"\r\n`),
      Buffer.from(`Content-Type: application/pdf\r\n\r\n`),
      pdfData,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`),
    ]);

    const response = await new Promise<any>(resolve => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path: '/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const uploadedFile = response.body.files[0];
    expect(uploadedFile.filename).toBe('test.pdf');
    expect(uploadedFile.mimetype).toBe('application/pdf');

    // Verify exact binary match
    const receivedData = Buffer.from(uploadedFile.data, 'base64');
    expect(receivedData).toEqual(pdfData);
  });

  it('should handle text fields alongside binary files', async () => {
    const imageData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = Buffer.concat([
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="title"\r\n\r\n`),
      Buffer.from(`My Photo\r\n`),
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="photo"; filename="photo.jpg"\r\n`),
      Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
      imageData,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`),
    ]);

    const response = await new Promise<any>(resolve => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path: '/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const uploadedFile = response.body.files[0];
    expect(uploadedFile.filename).toBe('photo.jpg');

    // Verify binary integrity
    const receivedData = Buffer.from(uploadedFile.data, 'base64');
    expect(receivedData).toEqual(imageData);
  });

  it('should handle multiple binary files in one request', async () => {
    const image1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG
    const image2 = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = Buffer.concat([
      Buffer.from(`------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file1"; filename="image1.jpg"\r\n`),
      Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
      image1,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file2"; filename="image2.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      image2,
      Buffer.from(`\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`),
    ]);

    const response = await new Promise<any>(resolve => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path: '/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.files).toHaveLength(2);

    // Verify both files
    const file1 = response.body.files.find((f: any) => f.filename === 'image1.jpg');
    const file2 = response.body.files.find((f: any) => f.filename === 'image2.png');

    expect(Buffer.from(file1.data, 'base64')).toEqual(image1);
    expect(Buffer.from(file2.data, 'base64')).toEqual(image2);
  });
});

// upload() middleware - where files may come from and what is believed about
// them. Files are taken only from the output of the framework's multipart
// parser, and only on a request whose media type is multipart/form-data; a
// body that merely looks like parser output (a JSON body with a `files` key)
// is never treated as uploads. A file's size is measured from its bytes, not
// read from the object, and nothing is written to `dest` unless validation
// passes.
const BOUNDARY = 'XBOUND';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;

/** A real multipart payload with one file part, run through the framework's parser */
function parsedUpload(filename: string, contents: Buffer | string, type = 'text/plain') {
  const payload = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="doc"; filename="${filename}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`
    ),
    Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return parseMultipart(payload, MULTIPART);
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function through(mw: ReturnType<typeof createUploadMiddleware>, req: any) {
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe('upload() middleware - file sources and validation', () => {
  let dest: string;

  beforeAll(async () => {
    dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-upload-mw-')));
  });

  afterAll(async () => {
    await fs.rm(dest, { recursive: true, force: true });
  });

  describe('the parser brand', () => {
    it('marks parser output, invisibly', () => {
      const body = parsedUpload('a.txt', 'hello');
      expect(isMultipartBody(body)).toBe(true);
      expect((body as any)[MULTIPART_BODY]).toBe(true);
      expect(Object.keys(body)).toEqual(['fields', 'files', 'parts']);
      expect(Object.getOwnPropertyDescriptor(body, MULTIPART_BODY)?.enumerable).toBe(false);
      // a copy is not parser output
      expect(isMultipartBody({ ...body })).toBe(false);
    });

    it('cannot be supplied by a request body', () => {
      const fromJson = JSON.parse(
        '{"files":{"a":{"filename":"x.png","mimetype":"image/png","size":1,"data":"AAAA"}},' +
          '"Symbol(moro.multipart.body)":true,"moro.multipart.body":true}'
      );
      expect(isMultipartBody(fromJson)).toBe(false);
      expect(isMultipartBody(null)).toBe(false);
      expect(isMultipartBody('files')).toBe(false);
    });
  });

  describe('forged file objects', () => {
    const forged = () => ({
      files: {
        a: { filename: 'x.png', mimetype: 'image/png', size: 1, data: 'B'.repeat(200000) },
      },
    });

    it('are ignored when the body did not come from the multipart parser', async () => {
      const mw = createUploadMiddleware({ dest, maxFileSize: 1024 });
      // A multipart Content-Type, but a body no multipart parser produced
      const req: any = { method: 'POST', headers: { 'content-type': MULTIPART }, body: forged() };

      const { res, nextCalled } = await through(mw, req);
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(req.files).toBeUndefined();
      expect(await fs.readdir(dest)).toEqual([]);
    });

    it('are ignored when Content-Type only mentions multipart/form-data', async () => {
      const mw = createUploadMiddleware({ dest, maxFileSize: 1024 });
      for (const contentType of [
        'application/json; x=multipart/form-data',
        'application/x-multipart/form-data',
        'text/plain; boundary="multipart/form-data"',
      ]) {
        // Even a body carrying the brand is not looked at: this is not a
        // multipart request
        const body = parsedUpload('real.txt', 'hello');
        const req: any = { method: 'POST', headers: { 'content-type': contentType }, body };
        const { nextCalled } = await through(mw, req);
        expect(nextCalled).toBe(true);
        expect(req.files).toBeUndefined();
      }
      expect(await fs.readdir(dest)).toEqual([]);
    });

    it('are not attached by the hook form either', async () => {
      const handlers: Array<(context: any) => Promise<void>> = [];
      registerUploadHooks({ on: (_e: string, fn: any) => handlers.push(fn) }, { maxFileSize: 10 });
      const request: any = { headers: { 'content-type': MULTIPART }, body: forged() };
      const response = makeRes();
      await (handlers[0] as (context: any) => Promise<void>)({ request, response });
      expect(request.files).toBeUndefined();
      expect(response.statusCode).toBe(200);
    });
  });

  describe('real uploads', () => {
    it('are attached, validated and written', async () => {
      const mw = createUploadMiddleware({ dest, maxFileSize: 1024, allowedTypes: ['text/plain'] });
      const req: any = {
        method: 'POST',
        headers: { 'content-type': MULTIPART },
        body: parsedUpload('note.txt', 'hello upload'),
      };

      const { nextCalled } = await through(mw, req);
      expect(nextCalled).toBe(true);
      expect(req.files.doc.filename).toBe('note.txt');
      expect(req.files.doc.size).toBe(12);
      expect(await fs.readFile(req.files.doc.path, 'utf8')).toBe('hello upload');
      await fs.rm(req.files.doc.path);
    });

    it('accepts the media type in any case and with parameters', async () => {
      const mw = createUploadMiddleware({});
      const req: any = {
        method: 'POST',
        headers: { 'content-type': `Multipart/Form-Data ; boundary=${BOUNDARY}` },
        body: parsedUpload('note.txt', 'x'),
      };
      await through(mw, req);
      expect(req.files.doc.filename).toBe('note.txt');
    });

    it('rejects a file over maxFileSize by its bytes', async () => {
      const mw = createUploadMiddleware({ dest, maxFileSize: 16 });
      const body = parsedUpload('big.bin', Buffer.alloc(64, 1), 'application/octet-stream');
      const req: any = { method: 'POST', headers: { 'content-type': MULTIPART }, body };

      const { res, nextCalled } = await through(mw, req);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('too large');
      expect(await fs.readdir(dest)).toEqual([]);
    });
  });

  describe('validateUpload', () => {
    const core = new UploadCore({ maxFileSize: 16 });
    const file = (over: Record<string, unknown>) => ({
      f: { filename: 'a.bin', mimetype: 'application/octet-stream', ...over },
    });

    it('measures the Buffer, whatever size the object claims', () => {
      const claimsSmall = file({ data: Buffer.alloc(64), size: 1 });
      expect(core.validateUpload(claimsSmall).valid).toBe(false);
      expect(core.validateUpload(claimsSmall).error).toContain('too large');
      // and the recorded size is corrected to the real one
      expect((claimsSmall.f as any).size).toBe(64);

      const claimsBig = file({ data: Buffer.alloc(8), size: 9999 });
      expect(core.validateUpload(claimsBig)).toEqual({ valid: true });
      expect((claimsBig.f as any).size).toBe(8);
    });

    it.each([
      ['a string', 'B'.repeat(64)],
      ['an array', [1, 2, 3]],
      ['an object', { type: 'Buffer', data: [1] }],
      ['nothing', undefined],
    ])('rejects contents that are %s', (_label, data) => {
      const result = core.validateUpload(file({ data, size: 1 }));
      expect(result.valid).toBe(false);
    });

    it.each([[{ toString: 'x' }], [42], [['a.png']], [null]])(
      'rejects a filename that is not a string (%j) instead of throwing',
      filename => {
        let result: { valid: boolean; error?: string } | undefined;
        expect(() => {
          result = core.validateUpload(file({ filename, data: Buffer.alloc(1) }));
        }).not.toThrow();
        expect(result?.valid).toBe(false);
      }
    );

    it('answers 400 through the middleware for a non-string filename', async () => {
      const mw = createUploadMiddleware({ dest });
      const body = parsedUpload('ok.txt', 'x');
      (body.files.doc as any).filename = { evil: true };
      const req: any = { method: 'POST', headers: { 'content-type': MULTIPART }, body };

      const { res, nextCalled } = await through(mw, req);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(await fs.readdir(dest)).toEqual([]);
    });
  });
});

// upload() middleware - when files reach `dest`, and when they leave it again.
// The middleware runs ahead of routing when it is registered with app.use(),
// so it writes nothing itself: a file is stored when the handler asks for it
// (`file.path`, `file.destination`, `await file.save()`), and what a request
// stored is removed if the request is then answered with an error.
describe('upload() middleware - storing files', () => {
  let dest: string;

  beforeAll(async () => {
    dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-upload-store-')));
  });

  afterAll(async () => {
    await fs.rm(dest, { recursive: true, force: true });
  });

  const stored = () => fs.readdir(dest);
  const clear = async () => {
    for (const name of await stored()) await fs.rm(path.join(dest, name), { force: true });
  };

  /** A response that can be finished or dropped, like the servers' own */
  function makeLiveRes() {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload: unknown) => {
      res.body = payload;
      return res;
    };
    res.finish = (status: number) => {
      res.statusCode = status;
      res.emit('finish');
      res.emit('close');
    };
    res.abort = () => res.emit('close');
    return res;
  }

  async function upload(
    options: Parameters<typeof createUploadMiddleware>[0],
    body = parsedUpload('note.txt', 'hello upload')
  ) {
    const req: any = { method: 'POST', headers: { 'content-type': MULTIPART }, body };
    const res = makeLiveRes();
    let nextCalled = false;
    await createUploadMiddleware(options)(req, res, () => {
      nextCalled = true;
    });
    return { req, res, nextCalled };
  }

  const gone = async (file: string) => {
    for (let i = 0; i < 100; i++) {
      try {
        await fs.access(file);
      } catch {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  };

  describe('when a file is written', () => {
    it('writes nothing before the handler asks for the file', async () => {
      const { req, res, nextCalled } = await upload({ dest });
      expect(nextCalled).toBe(true);
      expect(req.files.doc.data.toString()).toBe('hello upload');
      expect(await stored()).toEqual([]);

      // a request that ends without its handler looking at the file: a 404,
      // a guard that refused it, a handler that had no use for it
      res.finish(404);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(await stored()).toEqual([]);

      // and without a dest there is nowhere to store it at all
      const memoryOnly = await upload({});
      expect(memoryOnly.req.files.doc.path).toBeUndefined();
      expect(memoryOnly.req.files.doc.destination).toBeUndefined();
      expect(memoryOnly.req.files.doc.save).toBeUndefined();
    });

    it('stores the file, once, when file.path is read', async () => {
      const { req, res } = await upload({ dest });
      const file = req.files.doc;

      const where = file.path;
      expect(path.dirname(where)).toBe(dest);
      expect(path.basename(where)).toMatch(/^[0-9a-f]{16}-note\.txt$/);
      expect(await fs.readFile(where, 'utf8')).toBe('hello upload');
      expect(file.path).toBe(where);
      expect(file.destination).toBe(dest);
      expect(await stored()).toHaveLength(1);

      res.finish(200);
      await clear();
    });

    it('stores it without blocking through file.save()', async () => {
      const { req, res } = await upload({ dest });
      const file = req.files.doc;

      const [first, second] = await Promise.all([file.save(), file.save()]);
      expect(second).toBe(first);
      expect(file.path).toBe(first);
      expect(await fs.readFile(first, 'utf8')).toBe('hello upload');
      expect(await stored()).toHaveLength(1);

      res.finish(200);
      await clear();
    });

    it('stores it when file.destination is read or the file is serialized', async () => {
      const first = await upload({ dest });
      expect(first.req.files.doc.destination).toBe(dest);
      expect(await stored()).toHaveLength(1);

      const second = await upload({ dest });
      const copy = JSON.parse(JSON.stringify({ ...second.req.files.doc, data: undefined }));
      expect(copy.path).toBe(second.req.files.doc.path);
      expect(copy.destination).toBe(dest);
      // save() is a method, not data
      expect(Object.keys(second.req.files.doc)).not.toContain('save');
      expect(await stored()).toHaveLength(2);

      first.res.finish(200);
      second.res.finish(200);
      await clear();
    });

    it('does not answer for the handler when the file cannot be stored', async () => {
      const blocked = path.join(dest, 'not-a-directory');
      await fs.writeFile(blocked, 'x');
      const { req, res, nextCalled } = await upload({ dest: path.join(blocked, 'uploads') });

      // nothing was attempted yet, so nothing was answered - least of all
      // with the filesystem's own error text
      expect(nextCalled).toBe(true);
      expect(res.body).toBeUndefined();
      expect(() => req.files.doc.path).toThrow();
      await expect(req.files.doc.save()).rejects.toThrow();

      await clear();
    });
  });

  describe('what a failed request leaves behind', () => {
    it('removes the file after an error response and keeps it after any other', async () => {
      for (const status of [400, 401, 404, 500]) {
        const { req, res } = await upload({ dest });
        const where = req.files.doc.path;
        expect(await stored()).toHaveLength(1);

        res.finish(status);
        expect({ status, removed: await gone(where) }).toEqual({ status, removed: true });
      }

      for (const status of [200, 201, 204, 303]) {
        const { req, res } = await upload({ dest });
        const where = req.files.doc.path;

        res.finish(status);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(await fs.readFile(where, 'utf8')).toBe('hello upload');
        await clear();
      }

      // A client that goes away before the handler has answered is not a
      // failure: the handler may still finish and record the file
      const dropped = await upload({ dest });
      const where = await dropped.req.files.doc.save();
      dropped.res.abort();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(await fs.readFile(where, 'utf8')).toBe('hello upload');
      await clear();
    });

    it("cleanup: 'always' removes it after a successful response, unless it was moved", async () => {
      const left = await upload({ dest, cleanup: 'always' });
      const leftPath = left.req.files.doc.path;
      left.res.finish(200);
      expect(await gone(leftPath)).toBe(true);

      // ...and when the client goes away without one
      const dropped = await upload({ dest, cleanup: 'always' });
      const droppedPath = dropped.req.files.doc.path;
      dropped.res.abort();
      expect(await gone(droppedPath)).toBe(true);

      const moved = await upload({ dest, cleanup: 'always' });
      const kept = path.join(dest, 'kept.txt');
      await fs.rename(moved.req.files.doc.path, kept);
      // the handler may record where the file went
      moved.req.files.doc.path = kept;
      expect(moved.req.files.doc.path).toBe(kept);
      moved.res.finish(200);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(await fs.readFile(kept, 'utf8')).toBe('hello upload');
      await clear();
    });

    it("cleanup: 'never' leaves the file whatever the response, 'failed' is the default", async () => {
      const never = await upload({ dest, cleanup: 'never' });
      const neverPath = never.req.files.doc.path;
      const byDefault = await upload({ dest });
      const defaultPath = byDefault.req.files.doc.path;

      never.res.finish(500);
      byDefault.res.finish(500);
      expect(await gone(defaultPath)).toBe(true);
      expect(await fs.readFile(neverPath, 'utf8')).toBe('hello upload');
      await clear();
    });
  });

  describe('verifyContent', () => {
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 1),
    ]);
    const HTML = '<script>alert(1)</script>';

    it('refuses a file whose bytes are not what it is declared as', async () => {
      // Off by default: the declared type is what allowedTypes checks
      const unchecked = await upload(
        { allowedTypes: ['image/png'] },
        parsedUpload('page.html', HTML, 'image/png')
      );
      expect(unchecked.nextCalled).toBe(true);

      const { res, nextCalled } = await upload(
        { dest, allowedTypes: ['image/png'], verifyContent: true },
        parsedUpload('page.html', HTML, 'image/png')
      );
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: 'File page.html is not a valid image/png file.',
      });
      expect(await stored()).toEqual([]);
    });

    it.each([
      ['image/png', PNG],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])],
      ['image/gif', Buffer.from('GIF89a\u0001\u0000\u0001\u0000')],
      ['image/webp', Buffer.from('RIFF\u0010\u0000\u0000\u0000WEBPVP8 ')],
      ['application/pdf', Buffer.from('%PDF-1.7\n')],
      ['application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0])],
      [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]),
      ],
      ['video/mp4', Buffer.from('\u0000\u0000\u0000\u0018ftypisom\u0000\u0000')],
      ['audio/mpeg', Buffer.from('ID3\u0003\u0000')],
    ])('tells a real %s file from one that only says it is', async (type, contents) => {
      const options = { allowedTypes: [type], verifyContent: true };

      const real = await upload(options, parsedUpload('file', contents, type));
      expect(real.nextCalled).toBe(true);

      const claimed = await upload(options, parsedUpload('file', HTML, type));
      expect(claimed.nextCalled).toBe(false);
      expect(claimed.res.statusCode).toBe(400);
    });

    it('refuses a recognisable type sent under a declared type that cannot be checked', async () => {
      const disguised = await upload(
        { allowedTypes: ['text/plain'], verifyContent: true },
        parsedUpload('notes.txt', PNG, 'text/plain')
      );
      expect(disguised.nextCalled).toBe(false);
      expect(disguised.res.statusCode).toBe(400);

      // text has no signature to check: it passes as before
      const text = await upload(
        { allowedTypes: ['text/plain'], verifyContent: true },
        parsedUpload('notes.txt', 'just text', 'text/plain')
      );
      expect(text.nextCalled).toBe(true);
    });

    it('stores a verified file under the extension of its type', async () => {
      const polyglot = Buffer.concat([PNG, Buffer.from(HTML)]);
      const checked = await upload(
        { dest, allowedTypes: ['image/png'], verifyContent: true },
        parsedUpload('page.html', polyglot, 'image/png')
      );
      expect(checked.nextCalled).toBe(true);
      expect(path.basename(checked.req.files.doc.path)).toMatch(/^[0-9a-f]{16}-page\.png$/);
      // the name the client sent is still what `filename` says
      expect(checked.req.files.doc.filename).toBe('page.html');

      const matching = await upload(
        { dest, verifyContent: true },
        parsedUpload('photo.PNG', PNG, 'image/png')
      );
      expect(path.basename(matching.req.files.doc.path)).toMatch(/-photo\.PNG$/);

      const text = await upload(
        { dest, verifyContent: true },
        parsedUpload('page.html', HTML, 'text/plain')
      );
      expect(path.basename(text.req.files.doc.path)).toMatch(/-page\.txt$/);

      // without the option the client's name is kept, as before
      const unchecked = await upload({ dest }, parsedUpload('page.html', polyglot, 'image/png'));
      expect(path.basename(unchecked.req.files.doc.path)).toMatch(/-page\.html$/);

      for (const each of [checked, matching, text, unchecked]) each.res.finish(200);
      await clear();
    });
  });
});
