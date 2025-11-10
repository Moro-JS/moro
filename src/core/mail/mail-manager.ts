// Mail Manager - Main Email System Controller
// ESM-first module

import type {
  MailConfig,
  MailOptions,
  MailResult,
  MailAdapter,
  MailAdapterType,
  EmailAddress,
} from './types.js';
import { TemplateEngineManager } from './template-engine.js';
import { createFrameworkLogger } from '../logger/index.js';
import type { Logger } from '../../types/logger.js';

/**
 * Main mail manager class
 * Coordinates adapters, templates, and queue integration
 */
export class MailManager {
  private config: MailConfig;
  private adapter?: MailAdapter;
  private templateEngine?: TemplateEngineManager;
  private logger: Logger;
  private defaultFrom?: string | EmailAddress;
  private queueManager?: any;

  constructor(config: MailConfig = {}) {
    this.config = config;
    this.logger = createFrameworkLogger('Mail');
    this.defaultFrom = config.from;
  }

  /**
   * Initialize mail manager
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing mail system', 'Mail', {
      adapter: this.config.adapter || 'console',
      templates: !!this.config.templates?.path,
      queue: this.config.queue?.enabled || false,
    });

    // Load adapter
    await this.loadAdapter();

    // Initialize template engine if configured
    if (this.config.templates) {
      this.templateEngine = new TemplateEngineManager(this.config.templates);

      if (this.config.templates.engine && this.config.templates.engine !== 'moro') {
        await this.templateEngine.loadExternalEngine(this.config.templates.engine);
      }

      if (this.config.templates.partials) {
        await this.templateEngine.loadPartials();
      }

      if (this.config.templates.helpers) {
        for (const [name, fn] of Object.entries(this.config.templates.helpers)) {
          this.templateEngine.registerHelper(name, fn);
        }
      }
    }

    this.logger.info('Mail system initialized successfully', 'Mail');
  }

  /**
   * Load email adapter based on configuration
   */
  private async loadAdapter(): Promise<void> {
    const adapterType = (this.config.adapter || 'console') as MailAdapterType;

    this.logger.debug(`Loading ${adapterType} adapter`, 'Mail');

    try {
      if (adapterType === 'console') {
        const { ConsoleAdapter } = await import('./adapters/console-adapter.js');
        this.adapter = new ConsoleAdapter();
      } else if (adapterType === 'nodemailer') {
        const { NodemailerAdapter } = await import('./adapters/nodemailer-adapter.js');
        this.adapter = new NodemailerAdapter();
      } else if (adapterType === 'sendgrid') {
        const { SendGridAdapter } = await import('./adapters/sendgrid-adapter.js');
        this.adapter = new SendGridAdapter();
      } else if (adapterType === 'ses') {
        const { SESAdapter } = await import('./adapters/ses-adapter.js');
        this.adapter = new SESAdapter();
      } else if (adapterType === 'resend') {
        const { ResendAdapter } = await import('./adapters/resend-adapter.js');
        this.adapter = new ResendAdapter();
      } else {
        throw new Error(`Unknown mail adapter: ${adapterType}`);
      }

      await this.adapter.initialize(this.config.connection || {});
      this.logger.info(`${this.adapter.getName()} adapter loaded successfully`, 'Mail');
    } catch (error) {
      this.logger.error(`Failed to load ${adapterType} adapter`, 'Mail', { error });
      throw error;
    }
  }

  /**
   * Send an email
   */
  async send(options: MailOptions): Promise<MailResult> {
    if (!this.adapter) {
      throw new Error('Mail adapter not initialized');
    }

    if (!options.from && !this.defaultFrom) {
      throw new Error('Email "from" address not specified');
    }

    const mailOptions: MailOptions = {
      ...options,
      from: options.from || this.defaultFrom,
    };

    if (!mailOptions.from) {
      throw new Error('Email "from" address could not be determined');
    }

    if (options.template && this.templateEngine) {
      try {
        const rendered = await this.templateEngine.renderFile(options.template, options.data || {});

        if (rendered.html) {
          mailOptions.html = rendered.html;
        }
        if (rendered.text) {
          mailOptions.text = rendered.text;
        }
      } catch (error) {
        this.logger.error('Template rendering failed', 'Mail', {
          error,
          template: options.template,
        });
        throw error;
      }
    }

    if (this.config.queue?.enabled && this.queueManager) {
      return this.sendViaQueue(mailOptions);
    }

    return this.sendDirect(mailOptions);
  }

  /**
   * Send email directly (synchronous)
   */
  private async sendDirect(options: MailOptions): Promise<MailResult> {
    if (!this.adapter) {
      throw new Error('Mail adapter not initialized');
    }

    try {
      this.logger.debug('Sending email', 'Mail', {
        to: options.to,
        subject: options.subject,
      });

      const result = await this.adapter.send(options);

      if (result.success) {
        this.logger.info('Email sent successfully', 'Mail', {
          to: options.to,
          subject: options.subject,
          messageId: result.messageId,
        });
      } else {
        this.logger.warn('Email send failed', 'Mail', {
          to: options.to,
          subject: options.subject,
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Email send error', 'Mail', {
        error,
        to: options.to,
        subject: options.subject,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send email via queue (asynchronous)
   */
  private async sendViaQueue(options: MailOptions): Promise<MailResult> {
    if (!this.queueManager) {
      throw new Error('Queue manager not set. Call setQueueManager() first.');
    }

    const queueName = this.config.queue?.name || 'emails';

    try {
      const job = await this.queueManager.addToQueue(queueName, options, {
        priority: this.config.queue?.priority || 0,
        delay: this.config.queue?.delay || 0,
        attempts: this.config.queue?.attempts || 3,
      });

      this.logger.info('Email queued for sending', 'Mail', {
        jobId: job.id,
        to: options.to,
        subject: options.subject,
      });

      return {
        success: true,
        messageId: job.id,
      };
    } catch (error) {
      this.logger.error('Failed to queue email', 'Mail', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send multiple emails in bulk
   */
  async sendBulk(options: MailOptions[]): Promise<MailResult[]> {
    if (!this.adapter) {
      throw new Error('Mail adapter not initialized');
    }

    const mailOptions = options.map(opts => ({
      ...opts,
      from: opts.from || this.defaultFrom,
    }));

    if (mailOptions.some(opts => !opts.from)) {
      throw new Error('Email "from" address not specified for one or more emails');
    }

    if (this.config.queue?.enabled && this.queueManager) {
      return this.sendBulkViaQueue(mailOptions);
    }

    if (this.adapter.sendBulk) {
      return this.adapter.sendBulk(mailOptions);
    }

    const results: MailResult[] = [];
    for (const opts of mailOptions) {
      results.push(await this.send(opts));
    }

    return results;
  }

  /**
   * Send bulk emails via queue
   */
  private async sendBulkViaQueue(options: MailOptions[]): Promise<MailResult[]> {
    if (!this.queueManager) {
      throw new Error('Queue manager not set');
    }

    const queueName = this.config.queue?.name || 'emails';
    const jobs = options.map(opts => ({
      data: opts,
      options: {
        priority: this.config.queue?.priority || 0,
        delay: this.config.queue?.delay || 0,
        attempts: this.config.queue?.attempts || 3,
      },
    }));

    try {
      const queuedJobs = await this.queueManager.addBulkToQueue(queueName, jobs);

      return queuedJobs.map((job: any) => ({
        success: true,
        messageId: job.id,
      }));
    } catch (error) {
      this.logger.error('Failed to queue bulk emails', 'Mail', { error });

      return options.map(() => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * Set queue manager for async email sending
   */
  setQueueManager(queueManager: any): void {
    this.queueManager = queueManager;
  }

  /**
   * Verify adapter connection
   */
  async verify(): Promise<boolean> {
    if (!this.adapter || !this.adapter.verify) {
      return false;
    }

    try {
      return await this.adapter.verify();
    } catch (error) {
      this.logger.error('Adapter verification failed', 'Mail', { error });
      return false;
    }
  }

  /**
   * Close connections and clean up
   */
  async close(): Promise<void> {
    if (this.adapter?.close) {
      await this.adapter.close();
    }

    if (this.templateEngine) {
      this.templateEngine.clearCache();
    }
  }

  /**
   * Get template engine
   */
  getTemplateEngine(): TemplateEngineManager | undefined {
    return this.templateEngine;
  }

  /**
   * Get adapter
   */
  getAdapter(): MailAdapter | undefined {
    return this.adapter;
  }
}
