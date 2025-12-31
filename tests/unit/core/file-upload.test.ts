// File Upload Tests - Binary Data Integrity
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createApp } from '../../../src/index.js';
import { Moro } from '../../../src/moro.js';
import http from 'http';

describe('File Upload - Binary Data Integrity', () => {
  let app: Moro;
  let server: http.Server;
  const PORT = 3891;

  beforeAll(done => {
    app = createApp();

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

    app.listen(PORT, () => {
      done();
    });

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
