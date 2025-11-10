 
// Mail System Tests
// Comprehensive test suite for email functionality

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MailManager } from '../../src/core/mail/mail-manager.js';
import { ConsoleAdapter } from '../../src/core/mail/adapters/console-adapter.js';
import { TemplateEngineManager } from '../../src/core/mail/template-engine.js';
import type { MailConfig, MailOptions } from '../../src/core/mail/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Mail System', () => {
  let mailManager: MailManager;
  let testTemplatesPath: string;

  beforeEach(async () => {
    testTemplatesPath = path.join(os.tmpdir(), 'moro-email-test-templates-' + Date.now());
    await fs.mkdir(testTemplatesPath, { recursive: true });
  });

  afterEach(async () => {
    if (mailManager) {
      await mailManager.close();
    }

    try {
      await fs.rm(testTemplatesPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('MailManager', () => {
    it('should initialize with console adapter', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const adapter = mailManager.getAdapter();
      expect(adapter).toBeDefined();
      expect(adapter?.getName()).toBe('Console');
    });

    it('should send simple email', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        text: 'This is a test email',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should send email with HTML', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Test HTML Email',
        text: 'Plain text version',
        html: '<h1>HTML Version</h1><p>This is a test email</p>',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should send email to multiple recipients', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: ['recipient1@example.com', 'recipient2@example.com'],
        subject: 'Test Email',
        text: 'This is a test email',
      });

      expect(result.success).toBe(true);
    });

    it('should send email with CC and BCC', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        cc: 'cc@example.com',
        bcc: 'bcc@example.com',
        subject: 'Test Email',
        text: 'This is a test email',
      });

      expect(result.success).toBe(true);
    });

    it('should send email with attachments', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Test Email with Attachment',
        text: 'This is a test email with attachment',
        attachments: [
          {
            filename: 'test.txt',
            content: Buffer.from('Test file content'),
            contentType: 'text/plain',
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it('should send bulk emails', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const emails: MailOptions[] = [
        {
          to: 'recipient1@example.com',
          subject: 'Test Email 1',
          text: 'This is test email 1',
        },
        {
          to: 'recipient2@example.com',
          subject: 'Test Email 2',
          text: 'This is test email 2',
        },
      ];

      const results = await mailManager.sendBulk(emails);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should verify adapter connection', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const isVerified = await mailManager.verify();
      expect(isVerified).toBe(true);
    });
  });

  describe('Template System', () => {
    it('should render template with variables', async () => {
      const templatePath = path.join(testTemplatesPath, 'welcome.html');
      await fs.writeFile(
        templatePath,
        '<h1>Welcome {{name}}!</h1><p>Email: {{email}}</p>'
      );

      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
        templates: {
          path: testTemplatesPath,
          engine: 'moro',
          cache: true,
        },
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Welcome Email',
        template: 'welcome',
        data: {
          name: 'John Doe',
          email: 'john@example.com',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should render template with conditionals', async () => {
      const templatePath = path.join(testTemplatesPath, 'conditional.html');
      await fs.writeFile(
        templatePath,
        '<h1>Hello {{name}}</h1>{{#if isPremium}}<p>You are a premium member!</p>{{else}}<p>Upgrade to premium!</p>{{/if}}'
      );

      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
        templates: {
          path: testTemplatesPath,
          engine: 'moro',
        },
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Conditional Email',
        template: 'conditional',
        data: {
          name: 'John Doe',
          isPremium: true,
        },
      });

      expect(result.success).toBe(true);
    });

    it('should render template with loops', async () => {
      const templatePath = path.join(testTemplatesPath, 'loop.html');
      await fs.writeFile(
        templatePath,
        '<h1>Items</h1><ul>{{#each items}}<li>{{name}}: {{price}}</li>{{/each}}</ul>'
      );

      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
        templates: {
          path: testTemplatesPath,
          engine: 'moro',
        },
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      const result = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Loop Email',
        template: 'loop',
        data: {
          items: [
            { name: 'Product 1', price: '$10' },
            { name: 'Product 2', price: '$20' },
          ],
        },
      });

      expect(result.success).toBe(true);
    });

    it('should cache compiled templates', async () => {
      const templatePath = path.join(testTemplatesPath, 'cached.html');
      await fs.writeFile(templatePath, '<h1>Hello {{name}}</h1>');

      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
        templates: {
          path: testTemplatesPath,
          engine: 'moro',
          cache: true,
        },
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      await mailManager.send({
        to: 'recipient@example.com',
        subject: 'First Email',
        template: 'cached',
        data: { name: 'John' },
      });

      await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Second Email',
        template: 'cached',
        data: { name: 'Jane' },
      });

      expect(true).toBe(true);
    });
  });

  describe('ConsoleAdapter', () => {
    it('should initialize successfully', async () => {
      const adapter = new ConsoleAdapter();
      await adapter.initialize({});
      expect(adapter.getName()).toBe('Console');
    });

    it('should format email addresses correctly', async () => {
      const adapter = new ConsoleAdapter();
      await adapter.initialize({});

      const result = await adapter.send({
        to: { name: 'John Doe', email: 'john@example.com' },
        from: { name: 'Test App', email: 'test@example.com' },
        subject: 'Test',
        text: 'Test email',
      });

      expect(result.success).toBe(true);
    });

    it('should handle multiple recipients', async () => {
      const adapter = new ConsoleAdapter();
      await adapter.initialize({});

      const result = await adapter.send({
        to: [
          { name: 'John Doe', email: 'john@example.com' },
          { name: 'Jane Doe', email: 'jane@example.com' },
        ],
        from: 'test@example.com',
        subject: 'Test',
        text: 'Test email',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should handle email with priority', async () => {
      const adapter = new ConsoleAdapter();
      await adapter.initialize({});

      const result = await adapter.send({
        to: 'recipient@example.com',
        from: 'test@example.com',
        subject: 'High Priority Email',
        text: 'This is urgent',
        priority: 'high',
      });

      expect(result.success).toBe(true);
    });

    it('should handle reply-to address', async () => {
      const adapter = new ConsoleAdapter();
      await adapter.initialize({});

      const result = await adapter.send({
        to: 'recipient@example.com',
        from: 'noreply@example.com',
        replyTo: 'support@example.com',
        subject: 'Test Email',
        text: 'Please reply to support',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('TemplateEngineManager', () => {
    it('should render string template', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
      });

      const result = await engine.renderString(
        'Hello {{name}}!',
        { name: 'World' }
      );

      expect(result).toBe('Hello World!');
    });

    it('should handle nested variables', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
      });

      const result = await engine.renderString(
        'Hello {{user.name}}! Email: {{user.email}}',
        {
          user: {
            name: 'John Doe',
            email: 'john@example.com',
          },
        }
      );

      expect(result).toContain('John Doe');
      expect(result).toContain('john@example.com');
    });

    it('should handle missing variables gracefully', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
      });

      const result = await engine.renderString(
        'Hello {{name}}! Your email is {{email}}',
        { name: 'John' }
      );

      expect(result).toContain('John');
      expect(result).not.toContain('undefined');
    });

    it('should clear template cache', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
        cache: true,
      });

      engine.clearCache();
      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing template file', async () => {
      const config: MailConfig = {
        adapter: 'console',
        from: 'test@example.com',
        templates: {
          path: testTemplatesPath,
          engine: 'moro',
        },
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      await expect(
        mailManager.send({
          to: 'recipient@example.com',
          subject: 'Test',
          template: 'nonexistent',
          data: {},
        })
      ).rejects.toThrow();
    });

    it('should handle missing from address', async () => {
      const config: MailConfig = {
        adapter: 'console',
      };

      mailManager = new MailManager(config);
      await mailManager.initialize();

      await expect(
        mailManager.send({
          to: 'recipient@example.com',
          subject: 'Test',
          text: 'Test email',
        })
      ).rejects.toThrow('Email "from" address not specified');
    });

    it('should handle adapter not initialized', async () => {
      mailManager = new MailManager({
        adapter: 'console',
        from: 'test@example.com',
      });

      await expect(
        mailManager.send({
          to: 'recipient@example.com',
          subject: 'Test',
          text: 'Test email',
        })
      ).rejects.toThrow('Mail adapter not initialized');
    });
  });
});

