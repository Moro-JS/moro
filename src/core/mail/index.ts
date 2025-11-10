// Mail System - Public API
// ESM-first module

export type {
  MailConfig,
  MailOptions,
  MailResult,
  MailAdapter,
  MailAdapterType,
  EmailAddress,
  EmailAttachment,
  TemplateConfig,
  TemplateEngine,
  MailQueueConfig,
  NodemailerConnection,
  SendGridConnection,
  SESConnection,
  ResendConnection,
} from './types.js';

export { MailManager } from './mail-manager.js';
export { TemplateEngineManager } from './template-engine.js';
export { BaseMailAdapter } from './mail-adapter.js';

// Export adapters
export {
  ConsoleAdapter,
  NodemailerAdapter,
  SendGridAdapter,
  SESAdapter,
  ResendAdapter,
} from './adapters/index.js';
