// Resend Adapter - Modern Email API
// ESM-first module with lazy loading

import { BaseMailAdapter } from '../mail-adapter.js';
import type { MailOptions, MailResult, ResendConnection } from '../types.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type { Logger } from '../../../types/logger.js';

/**
 * Resend adapter for email sending
 * Supports Resend's modern email API
 */
export class ResendAdapter extends BaseMailAdapter {
  private client: any;
  private logger: Logger;

  constructor() {
    super();
    this.logger = createFrameworkLogger('Mail:Resend');
  }

  async initialize(config: ResendConnection): Promise<void> {
    if (!config.apiKey) {
      throw new Error('Resend API key is required');
    }

    if (!isPackageAvailable('resend')) {
      throw new Error(
        'Resend package is not installed.\n' +
          'Install it with: npm install resend\n' +
          'Or use a different mail adapter.'
      );
    }

    const resendPath = resolveUserPackage('resend');
    const { Resend } = await import(resendPath);

    this.client = new Resend(config.apiKey);

    await super.initialize(config);
    this.logger.info('Resend adapter initialized', 'Mail');
  }

  async send(options: MailOptions): Promise<MailResult> {
    this.ensureInitialized();

    if (!this.client) {
      throw new Error('Resend client not initialized');
    }

    try {
      const emailData: any = {
        from: this.formatAddress(options.from),
        to: this.formatAddressesArray(options.to),
        subject: options.subject,
        text: options.text,
        html: options.html,
      };

      if (options.cc) {
        emailData.cc = this.formatAddressesArray(options.cc);
      }

      if (options.bcc) {
        emailData.bcc = this.formatAddressesArray(options.bcc);
      }

      if (options.replyTo) {
        emailData.reply_to = this.formatAddress(options.replyTo);
      }

      if (options.attachments) {
        emailData.attachments = options.attachments.map(att => ({
          filename: att.filename,
          content: Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content),
        }));
      }

      // Build headers with compliance fields
      const headers: Record<string, string> = { ...options.headers };

      if (options.messageId) {
        headers['Message-ID'] = options.messageId;
      }

      if (options.references) {
        headers['References'] = Array.isArray(options.references)
          ? options.references.join(' ')
          : options.references;
      }

      if (options.inReplyTo) {
        headers['In-Reply-To'] = options.inReplyTo;
      }

      // List management headers (RFC 2369)
      if (options.listUnsubscribe) {
        headers['List-Unsubscribe'] = Array.isArray(options.listUnsubscribe)
          ? `<${options.listUnsubscribe.join('>, <')}>`
          : `<${options.listUnsubscribe}>`;
      }

      if (options.listUnsubscribePost) {
        headers['List-Unsubscribe-Post'] = options.listUnsubscribePost;
      }

      if (options.listId) {
        headers['List-ID'] = options.listId;
      }

      if (Object.keys(headers).length > 0) {
        emailData.headers = headers;
      }

      // Resend-specific features
      if (options.tags && options.tags.length > 0) {
        emailData.tags = options.tags.map(tag => ({ name: tag }));
      }

      if (options.scheduledAt) {
        emailData.scheduledAt = options.scheduledAt.toISOString();
      }

      const response = await this.client.emails.send(emailData);

      return {
        success: true,
        messageId: response.id,
        response: JSON.stringify(response),
      };
    } catch (error: any) {
      this.logger.error('Failed to send email via Resend', 'Mail', { error });

      return {
        success: false,
        error: error?.message || String(error),
      };
    }
  }

  async sendBulk(options: MailOptions[]): Promise<MailResult[]> {
    this.ensureInitialized();

    if (!this.client) {
      throw new Error('Resend client not initialized');
    }

    try {
      const emails = options.map(opts => ({
        from: this.formatAddress(opts.from),
        to: this.formatAddressesArray(opts.to),
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }));

      const response = await this.client.batch.send(emails);

      return response.data.map((res: any) => ({
        success: true,
        messageId: res.id,
        response: JSON.stringify(res),
      }));
    } catch (error: any) {
      this.logger.error('Failed to send bulk emails via Resend', 'Mail', { error });

      return options.map(() => ({
        success: false,
        error: error?.message || String(error),
      }));
    }
  }

  getName(): string {
    return 'Resend';
  }

  async verify(): Promise<boolean> {
    return this.initialized;
  }

  private formatAddress(address: any): string {
    if (!address) {
      return '';
    }

    if (typeof address === 'string') {
      return address;
    }

    if (address.name) {
      return `${address.name} <${address.email}>`;
    }

    return address.email;
  }

  private formatAddressesArray(addresses: any): string[] {
    if (!addresses) {
      return [];
    }

    if (typeof addresses === 'string') {
      return [addresses];
    }

    if (Array.isArray(addresses)) {
      return addresses.map(addr => this.formatAddress(addr));
    }

    return [this.formatAddress(addresses)];
  }
}
