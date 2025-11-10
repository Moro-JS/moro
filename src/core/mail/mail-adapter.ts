// Base Mail Adapter Interface
// ESM-first module

import type { MailAdapter, MailOptions, MailResult } from './types.js';

/**
 * Abstract base class for mail adapters
 * Provides common functionality and interface
 */
export abstract class BaseMailAdapter implements MailAdapter {
  protected config: any;
  protected initialized = false;

  /**
   * Initialize adapter with configuration
   */
  async initialize(config: any): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  /**
   * Send an email (must be implemented by subclasses)
   */
  abstract send(options: MailOptions): Promise<MailResult>;

  /**
   * Get adapter name (must be implemented by subclasses)
   */
  abstract getName(): string;

  /**
   * Send multiple emails in bulk
   * Default implementation sends one by one
   * Override for better performance
   */
  async sendBulk(options: MailOptions[]): Promise<MailResult[]> {
    if (!this.initialized) {
      throw new Error(`${this.getName()} adapter not initialized`);
    }

    const results: MailResult[] = [];

    for (const mailOptions of options) {
      try {
        const result = await this.send(mailOptions);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Verify adapter connection (optional)
   */
  async verify(): Promise<boolean> {
    return this.initialized;
  }

  /**
   * Close adapter connections (optional)
   */
  async close(): Promise<void> {
    this.initialized = false;
  }

  /**
   * Normalize email address
   */
  protected normalizeAddress(address: string | { name?: string; email: string }): {
    name?: string;
    email: string;
  } {
    if (typeof address === 'string') {
      return { email: address };
    }
    return address;
  }

  /**
   * Normalize email addresses array
   */
  protected normalizeAddresses(
    addresses:
      | string
      | string[]
      | { name?: string; email: string }
      | { name?: string; email: string }[]
  ): { name?: string; email: string }[] {
    if (!addresses) {
      return [];
    }

    if (Array.isArray(addresses)) {
      return addresses.map(addr => this.normalizeAddress(addr));
    }

    return [this.normalizeAddress(addresses)];
  }

  /**
   * Check if adapter is initialized
   */
  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.getName()} adapter not initialized. Call initialize() first.`);
    }
  }
}
