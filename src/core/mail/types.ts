// Email System Types
// ESM-first module with full TypeScript support

/**
 * Email address representation
 */
export interface EmailAddress {
  name?: string;
  email: string;
}

/**
 * Email attachment
 */
export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  encoding?: string;
  contentType?: string;
  cid?: string;
}

/**
 * Core email options
 */
export interface MailOptions {
  to: string | string[] | EmailAddress | EmailAddress[];
  from?: string | EmailAddress;
  subject: string;
  text?: string;
  html?: string;
  template?: string;
  data?: Record<string, any>;
  cc?: string | string[] | EmailAddress | EmailAddress[];
  bcc?: string | string[] | EmailAddress | EmailAddress[];
  replyTo?: string | EmailAddress;
  attachments?: EmailAttachment[];

  // Custom headers - add ANY headers you need
  // Common examples: X-Mailer, X-Priority, X-Request-ID, X-Campaign-ID, etc.
  headers?: Record<string, string>;

  priority?: 'high' | 'normal' | 'low';

  // Compliance and threading headers
  messageId?: string;
  references?: string | string[];
  inReplyTo?: string;

  // Sender identification (RFC 5322)
  sender?: string | EmailAddress;
  returnPath?: string;

  // List management (RFC 2369 - Required for bulk email compliance)
  listUnsubscribe?: string | string[];
  listUnsubscribePost?: string;
  listId?: string;
  listHelp?: string;
  listSubscribe?: string;
  listOwner?: string;
  listArchive?: string;

  // Delivery and tracking
  dsn?: {
    notify?: 'never' | 'success' | 'failure' | 'delay';
    returnFull?: boolean;
    returnHeaders?: boolean;
  };

  // Encoding and content
  encoding?: string;
  textEncoding?: string;

  // Additional metadata
  date?: Date;
  messageIdDomain?: string;

  // Tags for tracking/categorization (provider-specific)
  tags?: string[];
  metadata?: Record<string, string>;

  // Scheduling (if supported by adapter)
  scheduledAt?: Date;
}

/**
 * Email send result
 */
export interface MailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
}

/**
 * Adapter types
 */
export type MailAdapterType = 'nodemailer' | 'sendgrid' | 'ses' | 'resend' | 'console';

/**
 * Template engine types
 */
export type TemplateEngine = 'moro' | 'handlebars' | 'ejs';

/**
 * Template configuration
 */
export interface TemplateConfig {
  path?: string;
  engine?: TemplateEngine;
  cache?: boolean;
  partials?: string;
  layouts?: string;
  helpers?: Record<string, (...args: any[]) => any>;
}

/**
 * Queue configuration for async email sending
 */
export interface MailQueueConfig {
  enabled?: boolean;
  name?: string;
  priority?: number;
  delay?: number;
  attempts?: number;
}

/**
 * Mail manager configuration
 */
export interface MailConfig {
  adapter?: MailAdapterType | string;
  from?: string | EmailAddress;
  connection?: any;
  templates?: TemplateConfig;
  queue?: MailQueueConfig;
  debug?: boolean;
}

/**
 * Nodemailer-specific connection options
 */
export interface NodemailerConnection {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  service?: string;
  pool?: boolean;
  maxConnections?: number;
  maxMessages?: number;
}

/**
 * SendGrid-specific connection options
 */
export interface SendGridConnection {
  apiKey: string;
  sandboxMode?: boolean;
}

/**
 * AWS SES-specific connection options
 */
export interface SESConnection {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  credentials?: any;
  configurationSet?: string;
}

/**
 * Resend-specific connection options
 */
export interface ResendConnection {
  apiKey: string;
}

/**
 * Template render result
 */
export interface TemplateResult {
  html?: string;
  text?: string;
}

/**
 * Base mail adapter interface
 */
export interface MailAdapter {
  /**
   * Initialize the adapter with configuration
   */
  initialize(config: any): Promise<void>;

  /**
   * Send an email
   */
  send(options: MailOptions): Promise<MailResult>;

  /**
   * Send multiple emails in bulk
   */
  sendBulk?(options: MailOptions[]): Promise<MailResult[]>;

  /**
   * Verify adapter connection
   */
  verify?(): Promise<boolean>;

  /**
   * Close adapter connections
   */
  close?(): Promise<void>;

  /**
   * Get adapter name
   */
  getName(): string;
}

/**
 * Template engine interface
 */
export interface TemplateEngineInterface {
  /**
   * Render a template with data
   */
  render(template: string, data: Record<string, any>): Promise<string>;

  /**
   * Compile a template for caching
   */
  compile?(template: string): any;

  /**
   * Register a helper function
   */
  registerHelper?(name: string, fn: (...args: any[]) => any): void;

  /**
   * Register a partial template
   */
  registerPartial?(name: string, template: string): void;
}

/**
 * Mail events
 */
export interface MailEvents {
  'mail:configured': { config: MailConfig };
  'mail:sending': { options: MailOptions };
  'mail:sent': { result: MailResult; options: MailOptions };
  'mail:failed': { error: Error; options: MailOptions };
  'mail:queued': { jobId: string; options: MailOptions };
  'template:rendered': { template: string; data: Record<string, any> };
  'template:error': { error: Error; template: string };
}
