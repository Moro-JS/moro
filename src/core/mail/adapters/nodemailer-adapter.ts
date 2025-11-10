// Nodemailer Adapter - SMTP Email Adapter
// ESM-first module with lazy loading

import { BaseMailAdapter } from '../mail-adapter.js';
import type { MailOptions, MailResult, NodemailerConnection } from '../types.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type { Logger } from '../../../types/logger.js';

/**
 * Nodemailer adapter for SMTP email sending
 * Supports Gmail, Outlook, custom SMTP servers
 */
export class NodemailerAdapter extends BaseMailAdapter {
  private transporter: any;
  private logger: Logger;

  constructor() {
    super();
    this.logger = createFrameworkLogger('Mail:Nodemailer');
  }

  async initialize(config: NodemailerConnection): Promise<void> {
    if (!isPackageAvailable('nodemailer')) {
      throw new Error(
        'Nodemailer is not installed.\n' +
          'Install it with: npm install nodemailer\n' +
          'Or use a different mail adapter.'
      );
    }

    const nodemailerPath = resolveUserPackage('nodemailer');
    const nodemailer = await import(nodemailerPath);

    this.transporter = nodemailer.default.createTransport(config);

    await super.initialize(config);
    this.logger.info('Nodemailer adapter initialized', 'Mail');
  }

  async send(options: MailOptions): Promise<MailResult> {
    this.ensureInitialized();

    if (!this.transporter) {
      throw new Error('Nodemailer transporter not initialized');
    }

    try {
      const mailOptions: any = {
        from: this.formatAddress(options.from),
        to: this.formatAddresses(options.to),
        subject: options.subject,
        text: options.text,
        html: options.html,
      };

      if (options.cc) {
        mailOptions.cc = this.formatAddresses(options.cc);
      }

      if (options.bcc) {
        mailOptions.bcc = this.formatAddresses(options.bcc);
      }

      if (options.replyTo) {
        mailOptions.replyTo = this.formatAddress(options.replyTo);
      }

      if (options.sender) {
        mailOptions.sender = this.formatAddress(options.sender);
      }

      if (options.attachments) {
        mailOptions.attachments = options.attachments.map(att => ({
          filename: att.filename,
          content: att.content,
          encoding: att.encoding,
          contentType: att.contentType,
          cid: att.cid,
        }));
      }

      // Build headers object with compliance fields
      const headers: Record<string, string | string[]> = { ...options.headers };

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

      if (options.listHelp) {
        headers['List-Help'] = `<${options.listHelp}>`;
      }

      if (options.listSubscribe) {
        headers['List-Subscribe'] = `<${options.listSubscribe}>`;
      }

      if (options.listOwner) {
        headers['List-Owner'] = `<${options.listOwner}>`;
      }

      if (options.listArchive) {
        headers['List-Archive'] = `<${options.listArchive}>`;
      }

      if (Object.keys(headers).length > 0) {
        mailOptions.headers = headers;
      }

      if (options.priority) {
        mailOptions.priority = options.priority;
      }

      if (options.returnPath) {
        mailOptions.envelope = {
          from: options.returnPath,
          to: this.formatAddresses(options.to),
        };
      }

      if (options.encoding) {
        mailOptions.encoding = options.encoding;
      }

      if (options.textEncoding) {
        mailOptions.textEncoding = options.textEncoding;
      }

      if (options.date) {
        mailOptions.date = options.date;
      }

      if (options.dsn) {
        mailOptions.dsn = options.dsn;
      }

      const info = await this.transporter.sendMail(mailOptions);

      return {
        success: true,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      };
    } catch (error) {
      this.logger.error('Failed to send email via Nodemailer', 'Mail', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getName(): string {
    return 'Nodemailer';
  }

  async verify(): Promise<boolean> {
    if (!this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      this.logger.error('Nodemailer verification failed', 'Mail', { error });
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
    }
    await super.close();
  }

  private formatAddress(address: any): string {
    if (!address) {
      return '';
    }

    if (typeof address === 'string') {
      return address;
    }

    if (address.name) {
      return `"${address.name}" <${address.email}>`;
    }

    return address.email;
  }

  private formatAddresses(addresses: any): string {
    if (!addresses) {
      return '';
    }

    if (typeof addresses === 'string') {
      return addresses;
    }

    if (Array.isArray(addresses)) {
      return addresses.map(addr => this.formatAddress(addr)).join(', ');
    }

    return this.formatAddress(addresses);
  }
}
