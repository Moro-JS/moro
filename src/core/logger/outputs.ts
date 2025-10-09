// Advanced Logger Outputs
import { writeFile, appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { LogEntry, LogOutput } from '../../types/logger.js';

// File output for persistent logging
export class FileOutput implements LogOutput {
  name = 'file';

  constructor(
    private filePath: string,
    private options: {
      format?: 'json' | 'pretty';
      maxSize?: number; // MB
      rotate?: boolean;
    } = {}
  ) {}

  async write(entry: LogEntry): Promise<void> {
    try {
      // Ensure directory exists
      await mkdir(dirname(this.filePath), { recursive: true });

      const format = this.options.format || 'json';
      const line =
        format === 'json' ? JSON.stringify(entry) + '\n' : this.formatPretty(entry) + '\n';

      await appendFile(this.filePath, line, 'utf8');

      // TODO: Implement log rotation if needed
    } catch (error) {
      console.error('File logger error:', error);
    }
  }

  private formatPretty(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const context = entry.context ? `[${entry.context}] ` : '';
    const metadata =
      entry.metadata && Object.keys(entry.metadata).length > 0
        ? ` ${JSON.stringify(entry.metadata)}`
        : '';

    return `${timestamp} ${level} ${context}${entry.message}${metadata}`;
  }
}

// HTTP webhook output for external logging services
export class WebhookOutput implements LogOutput {
  name = 'webhook';

  constructor(
    private url: string,
    private options: {
      headers?: Record<string, string>;
      batch?: boolean;
      batchSize?: number;
      timeout?: number;
    } = {}
  ) {}

  async write(entry: LogEntry): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(this.options.timeout || 5000),
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status}`);
      }
    } catch (error) {
      console.error('Webhook logger error:', error);
    }
  }
}

// Memory buffer output for testing and debugging
export class MemoryOutput implements LogOutput {
  name = 'memory';
  private buffer: LogEntry[] = [];

  constructor(private maxSize: number = 1000) {}

  write(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getEntries(): LogEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

// Stream output for custom processing
export class StreamOutput implements LogOutput {
  name = 'stream';
  format?: 'pretty' | 'json' | 'compact';

  constructor(
    private stream: NodeJS.WritableStream,
    format: 'json' | 'pretty' = 'json'
  ) {
    this.format = format;
  }

  write(entry: LogEntry): void {
    const data =
      this.format === 'json' ? JSON.stringify(entry) + '\n' : this.formatPretty(entry) + '\n';

    this.stream.write(data);
  }

  private formatPretty(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const context = entry.context ? `[${entry.context}] ` : '';
    return `${timestamp} ${level} ${context}${entry.message}`;
  }
}
