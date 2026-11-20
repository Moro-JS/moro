// File System Cache Adapter
import { CacheAdapter } from '../../../../../../types/cache.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';
import crypto from 'crypto';
import { keyTag } from './log-key.js';

const logger = createFrameworkLogger('FileCacheAdapter');

export class FileCacheAdapter implements CacheAdapter {
  private cacheDir: string;
  /**
   * Log a short tag in place of each key. For stores whose keys are secrets:
   * the session middleware sets it on the store it uses.
   */
  redactKeys: boolean;

  constructor(options: { cacheDir?: string; redactKeys?: boolean } = {}) {
    this.cacheDir = options.cacheDir || './cache';
    this.redactKeys = options.redactKeys === true;
    void this.ensureCacheDir().catch(() => {
      // best-effort cache directory creation; write paths re-check/create
    });
  }

  private async ensureCacheDir(): Promise<void> {
    const fs = await import('fs/promises');
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create cache directory', 'FileCache', { error });
    }
  }

  private getFilePath(key: string): string {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return `${this.cacheDir}/${hash}.json`;
  }

  async get(key: string): Promise<any> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(key);
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);

      if (Date.now() > parsed.expires) {
        await this.del(key);
        return null;
      }

      return parsed.value;
    } catch {
      return null;
    }
  }

  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(key);
      const expires = Date.now() + ttl * 1000;
      const data = JSON.stringify({ value, expires });

      await fs.writeFile(filePath, data);
      logger.debug(
        `Cached item to file: ${this.redactKeys ? keyTag(key) : key} (TTL: ${ttl}s)`,
        'FileCache'
      );
    } catch (error) {
      logger.error('File cache set error', 'FileCache', {
        key: this.redactKeys ? keyTag(key) : key,
        error,
      });
    }
  }

  async del(key: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(key);
      await fs.unlink(filePath);
      logger.debug(`Deleted file cache item: ${this.redactKeys ? keyTag(key) : key}`, 'FileCache');
    } catch {
      // File might not exist, which is okay
    }
  }

  async clear(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir(this.cacheDir);

      await Promise.all(files.map(file => fs.unlink(`${this.cacheDir}/${file}`)));

      logger.debug('Cleared all file cache items', 'FileCache');
    } catch (error) {
      logger.error('File cache clear error', 'FileCache', { error });
    }
  }

  async exists(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  async ttl(key: string): Promise<number> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(key);
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);

      const remaining = Math.floor((parsed.expires - Date.now()) / 1000);
      return remaining > 0 ? remaining : -1;
    } catch {
      return -1;
    }
  }
}
