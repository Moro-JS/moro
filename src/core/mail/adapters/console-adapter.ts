// Console Adapter - Built-in Email Adapter for Testing
// ESM-first module

import { BaseMailAdapter } from '../mail-adapter.js';
import type { MailOptions, MailResult } from '../types.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type { Logger } from '../../../types/logger.js';

/**
 * Console adapter for development and testing
 * Logs emails to console instead of sending them
 */
export class ConsoleAdapter extends BaseMailAdapter {
  private logger: Logger;

  constructor() {
    super();
    this.logger = createFrameworkLogger('Mail:Console');
  }

  async initialize(config: any): Promise<void> {
    await super.initialize(config);
    this.logger.info('Console adapter initialized', 'Mail');
  }

  async send(options: MailOptions): Promise<MailResult> {
    this.ensureInitialized();

    const from = options.from
      ? typeof options.from === 'string'
        ? options.from
        : `${options.from.name} <${options.from.email}>`
      : 'unknown@sender.com';

    const to = Array.isArray(options.to)
      ? options.to.map(addr => (typeof addr === 'string' ? addr : addr.email)).join(', ')
      : typeof options.to === 'string'
        ? options.to
        : options.to.email;

    /* eslint-disable no-console */
    console.log('\n========== EMAIL ==========');
    console.log(`From: ${from}`);
    console.log(`To: ${to}`);

    if (options.cc) {
      const cc = Array.isArray(options.cc)
        ? options.cc.map(addr => (typeof addr === 'string' ? addr : addr.email)).join(', ')
        : typeof options.cc === 'string'
          ? options.cc
          : options.cc.email;
      console.log(`CC: ${cc}`);
    }

    if (options.bcc) {
      const bcc = Array.isArray(options.bcc)
        ? options.bcc.map(addr => (typeof addr === 'string' ? addr : addr.email)).join(', ')
        : typeof options.bcc === 'string'
          ? options.bcc
          : options.bcc.email;
      console.log(`BCC: ${bcc}`);
    }

    console.log(`Subject: ${options.subject}`);

    if (options.priority) {
      console.log(`Priority: ${options.priority}`);
    }

    if (options.replyTo) {
      const replyTo =
        typeof options.replyTo === 'string'
          ? options.replyTo
          : `${options.replyTo.name} <${options.replyTo.email}>`;
      console.log(`Reply-To: ${replyTo}`);
    }

    if (options.attachments && options.attachments.length > 0) {
      console.log(`Attachments: ${options.attachments.map(a => a.filename).join(', ')}`);
    }

    console.log('\n--- Body ---');

    if (options.text) {
      console.log(options.text);
    }

    if (options.html) {
      console.log('\n--- HTML ---');
      console.log(options.html.substring(0, 200) + (options.html.length > 200 ? '...' : ''));
    }

    console.log('===========================\n');
    /* eslint-enable no-console */

    const messageId = `console-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    return {
      success: true,
      messageId,
      accepted: [to],
      response: 'Email logged to console',
    };
  }

  getName(): string {
    return 'Console';
  }

  async verify(): Promise<boolean> {
    return true;
  }
}
