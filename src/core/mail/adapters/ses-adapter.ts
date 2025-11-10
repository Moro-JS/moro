// AWS SES Adapter - Amazon Simple Email Service
// ESM-first module with lazy loading

import { BaseMailAdapter } from '../mail-adapter.js';
import type { MailOptions, MailResult, SESConnection } from '../types.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type { Logger } from '../../../types/logger.js';

/**
 * AWS SES adapter for email sending
 * Supports AWS Simple Email Service
 */
export class SESAdapter extends BaseMailAdapter {
  private client: any;
  private logger: Logger;
  private configurationSet?: string;

  constructor() {
    super();
    this.logger = createFrameworkLogger('Mail:SES');
  }

  async initialize(config: SESConnection): Promise<void> {
    if (!config.region) {
      throw new Error('AWS region is required for SES adapter');
    }

    if (!isPackageAvailable('@aws-sdk/client-ses')) {
      throw new Error(
        'AWS SES SDK is not installed.\n' +
          'Install it with: npm install @aws-sdk/client-ses\n' +
          'Or use a different mail adapter.'
      );
    }

    const sesPath = resolveUserPackage('@aws-sdk/client-ses');
    const { SESClient } = await import(sesPath);

    const clientConfig: any = {
      region: config.region,
    };

    if (config.credentials) {
      clientConfig.credentials = config.credentials;
    } else if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.client = new SESClient(clientConfig);
    this.configurationSet = config.configurationSet;

    await super.initialize(config);
    this.logger.info('AWS SES adapter initialized', 'Mail');
  }

  async send(options: MailOptions): Promise<MailResult> {
    this.ensureInitialized();

    if (!this.client) {
      throw new Error('SES client not initialized');
    }

    try {
      const sesPath = resolveUserPackage('@aws-sdk/client-ses');
      const { SendEmailCommand } = await import(sesPath);

      const destination: any = {
        ToAddresses: this.formatAddressesArray(options.to),
      };

      if (options.cc) {
        destination.CcAddresses = this.formatAddressesArray(options.cc);
      }

      if (options.bcc) {
        destination.BccAddresses = this.formatAddressesArray(options.bcc);
      }

      const message: any = {
        Subject: {
          Data: options.subject,
          Charset: 'UTF-8',
        },
        Body: {},
      };

      if (options.text) {
        message.Body.Text = {
          Data: options.text,
          Charset: 'UTF-8',
        };
      }

      if (options.html) {
        message.Body.Html = {
          Data: options.html,
          Charset: 'UTF-8',
        };
      }

      const commandParams: any = {
        Source: this.formatSingleAddress(options.from),
        Destination: destination,
        Message: message,
        ReplyToAddresses: options.replyTo ? [this.formatSingleAddress(options.replyTo)] : undefined,
        ConfigurationSetName: this.configurationSet,
      };

      if (options.returnPath) {
        commandParams.ReturnPath = options.returnPath;
      }

      // Add custom headers via Tags (SES limitation - headers must be added via raw email)
      if (options.tags && options.tags.length > 0) {
        commandParams.Tags = options.tags.map((tag: string, index: number) => ({
          Name: `tag-${index}`,
          Value: tag,
        }));
      }

      const command = new SendEmailCommand(commandParams);

      const response = await this.client.send(command);

      return {
        success: true,
        messageId: response.MessageId,
        response: JSON.stringify(response),
      };
    } catch (error: any) {
      this.logger.error('Failed to send email via SES', 'Mail', { error });

      return {
        success: false,
        error: error?.message || String(error),
      };
    }
  }

  getName(): string {
    return 'AWS SES';
  }

  async verify(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const sesPath = resolveUserPackage('@aws-sdk/client-ses');
      const { GetAccountSendingEnabledCommand } = await import(sesPath);

      const command = new GetAccountSendingEnabledCommand({});
      await this.client.send(command);
      return true;
    } catch (error) {
      this.logger.error('SES verification failed', 'Mail', { error });
      return false;
    }
  }

  private formatSingleAddress(address: any): string {
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

  private formatAddressesArray(addresses: any): string[] {
    if (!addresses) {
      return [];
    }

    if (typeof addresses === 'string') {
      return [addresses];
    }

    if (Array.isArray(addresses)) {
      return addresses.map(addr => {
        if (typeof addr === 'string') {
          return addr;
        }
        return addr.email;
      });
    }

    if (typeof addresses === 'object') {
      return [addresses.email];
    }

    return [];
  }
}
