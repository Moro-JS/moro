// SendGrid Adapter - SendGrid Email Service
// ESM-first module with lazy loading

import { BaseMailAdapter } from '../mail-adapter.js';
import type { MailOptions, MailResult, SendGridConnection } from '../types.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type { Logger } from '../../../types/logger.js';

/**
 * SendGrid adapter for email sending
 * Supports SendGrid API features
 */
export class SendGridAdapter extends BaseMailAdapter {
  private client: any;
  private logger: Logger;
  private sandboxMode: boolean;

  constructor() {
    super();
    this.logger = createFrameworkLogger('Mail:SendGrid');
    this.sandboxMode = false;
  }

  async initialize(config: SendGridConnection): Promise<void> {
    if (!config.apiKey) {
      throw new Error('SendGrid API key is required');
    }

    if (!isPackageAvailable('@sendgrid/mail')) {
      throw new Error(
        'SendGrid mail package is not installed.\n' +
          'Install it with: npm install @sendgrid/mail\n' +
          'Or use a different mail adapter.'
      );
    }

    const sendgridPath = resolveUserPackage('@sendgrid/mail');
    const sgMail = await import(sendgridPath);

    sgMail.default.setApiKey(config.apiKey);
    this.client = sgMail.default;
    this.sandboxMode = config.sandboxMode || false;

    await super.initialize(config);
    this.logger.info('SendGrid adapter initialized', 'Mail');
  }

  async send(options: MailOptions): Promise<MailResult> {
    this.ensureInitialized();

    if (!this.client) {
      throw new Error('SendGrid client not initialized');
    }

    try {
      const msg: any = {
        from: this.formatAddress(options.from),
        to: this.formatAddressesArray(options.to),
        subject: options.subject,
        text: options.text,
        html: options.html,
      };

      if (options.cc) {
        msg.cc = this.formatAddressesArray(options.cc);
      }

      if (options.bcc) {
        msg.bcc = this.formatAddressesArray(options.bcc);
      }

      if (options.replyTo) {
        msg.replyTo = this.formatAddress(options.replyTo);
      }

      if (options.attachments) {
        msg.attachments = options.attachments.map(att => ({
          filename: att.filename,
          content: Buffer.isBuffer(att.content) ? att.content.toString('base64') : att.content,
          type: att.contentType,
          disposition: 'attachment',
          contentId: att.cid,
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
        msg.headers = headers;
      }

      // SendGrid-specific features
      if (options.tags && options.tags.length > 0) {
        msg.categories = options.tags;
      }

      if (options.metadata) {
        msg.customArgs = options.metadata;
      }

      if (options.scheduledAt) {
        msg.sendAt = Math.floor(options.scheduledAt.getTime() / 1000);
      }

      if (this.sandboxMode) {
        msg.mailSettings = {
          sandboxMode: {
            enable: true,
          },
        };
      }

      const response = await this.client.send(msg);

      return {
        success: true,
        messageId: response[0]?.headers?.['x-message-id'],
        response: JSON.stringify(response[0]),
      };
    } catch (error: any) {
      this.logger.error('Failed to send email via SendGrid', 'Mail', { error });

      return {
        success: false,
        error: error?.message || String(error),
      };
    }
  }

  async sendBulk(options: MailOptions[]): Promise<MailResult[]> {
    this.ensureInitialized();

    if (!this.client) {
      throw new Error('SendGrid client not initialized');
    }

    try {
      const messages = options.map(opts => ({
        from: this.formatAddress(opts.from),
        to: this.formatAddressesArray(opts.to),
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }));

      const response = await this.client.send(messages);

      return response.map((res: any) => ({
        success: true,
        messageId: res?.headers?.['x-message-id'],
        response: JSON.stringify(res),
      }));
    } catch (error: any) {
      this.logger.error('Failed to send bulk emails via SendGrid', 'Mail', { error });

      return options.map(() => ({
        success: false,
        error: error?.message || String(error),
      }));
    }
  }

  getName(): string {
    return 'SendGrid';
  }

  async verify(): Promise<boolean> {
    return this.initialized;
  }

  private formatAddress(address: any): any {
    if (!address) {
      return '';
    }

    if (typeof address === 'string') {
      return { email: address };
    }

    return {
      email: address.email,
      name: address.name,
    };
  }

  private formatAddressesArray(addresses: any): any[] {
    if (!addresses) {
      return [];
    }

    if (typeof addresses === 'string') {
      return [{ email: addresses }];
    }

    if (Array.isArray(addresses)) {
      return addresses.map(addr => this.formatAddress(addr));
    }

    return [this.formatAddress(addresses)];
  }
}
