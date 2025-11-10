// HTTP Range Requests Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';

export interface RangeOptions {
  acceptRanges?: string;
  maxRanges?: number;
}

export class RangeCore {
  private acceptRanges: string;
  private maxRanges: number;

  constructor(options: RangeOptions = {}) {
    this.acceptRanges = options.acceptRanges || 'bytes';
    this.maxRanges = options.maxRanges || 1;
  }

  addRangeMethod(req: HttpRequest, res: HttpResponse): void {
    (res as any).sendRange = async (filePath: string, stats?: any) => {
      try {
        if (!stats) {
          stats = await fs.stat(filePath);
        }

        const fileSize = stats.size;
        const range = req.headers.range;

        // Set Accept-Ranges header
        res.setHeader('Accept-Ranges', this.acceptRanges);

        if (!range) {
          // No range requested, send entire file
          res.setHeader('Content-Length', fileSize);
          const data = await fs.readFile(filePath);
          res.end(data);
          return;
        }

        // Parse range header
        const ranges = this.parseRangeHeader(range, fileSize);

        if (!ranges) {
          res.status(416);
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          res.json({ success: false, error: 'Range not satisfiable' });
          return;
        }

        // Validate ranges
        if (ranges.length > this.maxRanges) {
          res.status(416).json({ success: false, error: 'Too many ranges' });
          return;
        }

        if (ranges.length === 1) {
          // Single range
          await this.sendSingleRange(filePath, fileSize, ranges[0], res);
        } else {
          // Multiple ranges - multipart response
          await this.sendMultipleRanges(filePath, fileSize, ranges, res);
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Range request failed',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  private parseRangeHeader(
    range: string,
    fileSize: number
  ): Array<{ start: number; end: number }> | null {
    const ranges = range
      .replace(/bytes=/, '')
      .split(',')
      .map(r => {
        const [start, end] = r.split('-');
        return {
          start: start ? parseInt(start) : 0,
          end: end ? parseInt(end) : fileSize - 1,
        };
      });

    // Validate ranges
    for (const r of ranges) {
      if (r.start >= fileSize || r.end >= fileSize || r.start > r.end) {
        return null;
      }
    }

    return ranges;
  }

  private async sendSingleRange(
    filePath: string,
    fileSize: number,
    range: { start: number; end: number },
    res: HttpResponse
  ): Promise<void> {
    const { start, end } = range;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    // Stream the range
    const stream = createReadStream(filePath, { start, end });
    stream.pipe(res);
  }

  private async sendMultipleRanges(
    filePath: string,
    fileSize: number,
    ranges: Array<{ start: number; end: number }>,
    res: HttpResponse
  ): Promise<void> {
    const boundary = 'MULTIPART_BYTERANGES';
    res.status(206);
    res.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);

    for (const { start, end } of ranges) {
      if (start >= fileSize || end >= fileSize) continue;

      res.write(`\r\n--${boundary}\r\n`);
      res.write(`Content-Range: bytes ${start}-${end}/${fileSize}\r\n\r\n`);

      const stream = createReadStream(filePath, { start, end });
      await new Promise<void>(resolve => {
        stream.on('end', () => resolve());
        stream.pipe(res, { end: false });
      });
    }
    res.write(`\r\n--${boundary}--\r\n`);
    res.end();
  }

  getAcceptRanges(): string {
    return this.acceptRanges;
  }

  getMaxRanges(): number {
    return this.maxRanges;
  }
}
