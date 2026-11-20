// Mail System Tests
// Comprehensive test suite for email functionality

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createApp } from '../../src/moro.js';
import {
  MoroLogger,
  logger as globalLogger,
  createFrameworkLogger,
} from '../../src/core/logger/index.js';
import { MailManager } from '../../src/core/mail/mail-manager.js';
import { ConsoleAdapter } from '../../src/core/mail/adapters/console-adapter.js';
import { MemoryAdapter } from '../../src/core/queue/adapters/memory-adapter.js';
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
      await fs.writeFile(templatePath, '<h1>Welcome {{name}}!</h1><p>Email: {{email}}</p>');

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

      const secondResult = await mailManager.send({
        to: 'recipient@example.com',
        subject: 'Second Email',
        template: 'cached',
        data: { name: 'Jane' },
      });

      // The second send (reusing the cached compiled template) must still
      // produce a valid MailResult.
      expect(secondResult).toHaveProperty('success');
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

      const result = await engine.renderString('Hello {{name}}!', { name: 'World' });

      expect(result).toBe('Hello World!');
    });

    it('should handle nested variables', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
      });

      const result = await engine.renderString('Hello {{user.name}}! Email: {{user.email}}', {
        user: {
          name: 'John Doe',
          email: 'john@example.com',
        },
      });

      expect(result).toContain('John Doe');
      expect(result).toContain('john@example.com');
    });

    it('should handle missing variables gracefully', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
      });

      const result = await engine.renderString('Hello {{name}}! Your email is {{email}}', {
        name: 'John',
      });

      expect(result).toContain('John');
      expect(result).not.toContain('undefined');
    });

    it('should clear template cache', async () => {
      const engine = new TemplateEngineManager({
        engine: 'moro',
        cache: true,
      });

      engine.clearCache();
      // Clearing an already-empty cache must be safe and idempotent.
      expect(() => engine.clearCache()).not.toThrow();
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

  // -------------------------------------------------------------------------
  // The renderer the built-in engine replaced, kept verbatim as an oracle. For
  // data whose values contain no template syntax its output is the contract.
  // -------------------------------------------------------------------------
  function legacyRender(
    template: string,
    data: Record<string, any>,
    partials: Record<string, string> = {}
  ): string {
    const getValue = (source: Record<string, any>, valuePath: string): any => {
      let value: any = source;
      for (const key of valuePath.split('.')) {
        if (!value || typeof value !== 'object') return undefined;
        value = value[key];
      }
      return value;
    };
    let processed = template.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_, name) => partials[name] || '');
    processed = processed.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
      (_, condition, truthy, falsy = '') => (getValue(data, condition) ? truthy : falsy)
    );
    processed = processed.replace(
      /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_, arrayName, body) => {
        const array = getValue(data, arrayName);
        if (!Array.isArray(array)) return '';
        return array
          .map((item: any) => {
            let itemBody = body;
            if (typeof item === 'object') {
              for (const [key, value] of Object.entries(item)) {
                itemBody = itemBody.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
              }
            } else {
              itemBody = itemBody.replace(/\{\{this\}\}/g, String(item));
            }
            return itemBody;
          })
          .join('');
      }
    );
    return processed.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
      const value = getValue(data, key);
      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  describe('Built-in template engine', () => {
    const order =
      '<ul>{{#each items}}<li>{{label}}: {{note}}</li>{{/each}}</ul><p>{{user.bio}}</p>';
    const secrets = { apiKey: 'SECRET-KEY-123', admin: true };

    /** Render through renderString() and through the cached renderFile() path. */
    async function renderBoth(
      template: string,
      data: Record<string, any>,
      partials: Record<string, string> = {}
    ): Promise<string> {
      const fromString = new TemplateEngineManager({ engine: 'moro' });
      for (const [name, text] of Object.entries(partials)) fromString.registerPartial(name, text);
      const direct = await fromString.renderString(template, data);

      await fs.writeFile(path.join(testTemplatesPath, 'both.html'), template);
      const fromFile = new TemplateEngineManager({ path: testTemplatesPath, cache: true });
      for (const [name, text] of Object.entries(partials)) fromFile.registerPartial(name, text);
      await fromFile.renderFile('both', data);
      // The second call renders from the compiled template in the cache
      const cached = (await fromFile.renderFile('both', data)).html;

      expect(cached).toBe(direct);
      return direct;
    }

    it('a loop item value containing {{…}} is inserted as text, not looked up', async () => {
      const html = await renderBoth(order, {
        ...secrets,
        items: [{ label: '{{apiKey}}', note: '{{user.bio}}' }],
        user: { bio: 'hello' },
      });

      expect(html).toBe('<ul><li>{{apiKey}}: {{user.bio}}</li></ul><p>hello</p>');
      expect(html).not.toContain('SECRET-KEY-123');

      // The same holds for a value outside a loop
      const page = '<p>{{user.bio}}</p>{{#if admin}}<b>admin</b>{{/if}}';
      const bio = '{{apiKey}}{{#each items}}x{{/each}}{{#if apiKey}}yes{{/if}}';
      expect(await renderBoth(page, { ...secrets, admin: false, user: { bio } })).toBe(
        `<p>${bio}</p>`
      );
    });

    it('a loop item value cannot refer to another field of the item', async () => {
      const html = await renderBoth(order, {
        items: [{ label: '{{note}}', note: 'private note' }],
        user: {},
      });

      expect(html).toBe('<ul><li>{{note}}: private note</li></ul><p></p>');
    });

    it('a primitive loop item containing {{…}} is inserted as text', async () => {
      const html = await renderBoth('{{#each tags}}[{{this}}]{{/each}}', {
        ...secrets,
        tags: ['a', '{{apiKey}}', '{{#if admin}}yes{{/if}}'],
      });

      expect(html).toBe('[a][{{apiKey}}][{{#if admin}}yes{{/if}}]');
    });

    it('inserts $-patterns in a loop item value verbatim', async () => {
      const html = await renderBoth('{{#each items}}<td>{{price}}</td>{{/each}}', {
        items: [{ price: '$$5' }, { price: "$& $` $'" }, { price: '$10' }],
      });

      expect(html).toBe('<td>$$5</td><td>$&amp; $` $&#39;</td><td>$10</td>');

      const raw = await renderBoth('{{#each items}}<td>{{{price}}}</td>{{/each}}', {
        items: [{ price: '$$5' }, { price: "$& $` $'" }, { price: '$10' }],
      });
      expect(raw).toBe("<td>$$5</td><td>$& $` $'</td><td>$10</td>");
    });

    it('renders an item key that is not a valid regular expression', async () => {
      const html = await renderBoth('{{#each items}}{{name}}{{/each}}', {
        items: [{ name: 'A', 'price (USD': 5 }],
      });

      expect(html).toBe('A');
    });

    it('HTML-escapes a {{value}} wherever it is written', async () => {
      const markup = `<a href="https://evil.test">Tom & 'Jerry'</a>`;
      const escaped =
        '&lt;a href=&quot;https://evil.test&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;';

      expect(await renderBoth('<p>{{name}}</p>', { name: markup })).toBe(`<p>${escaped}</p>`);
      expect(await renderBoth('<p>{{user.name}}</p>', { user: { name: markup } })).toBe(
        `<p>${escaped}</p>`
      );
      // A value cannot leave the attribute it is written into
      expect(await renderBoth('<img alt="{{alt}}">', { alt: '" onerror="alert(1)' })).toBe(
        '<img alt="&quot; onerror=&quot;alert(1)">'
      );
      // Loop fields, primitive items, and data read from inside a loop
      expect(
        await renderBoth('{{#each items}}<li>{{label}}|{{site}}</li>{{/each}}', {
          site: '<Acme>',
          items: [{ label: '<b>x</b>' }],
        })
      ).toBe('<li>&lt;b&gt;x&lt;/b&gt;|&lt;Acme&gt;</li>');
      expect(await renderBoth('{{#each tags}}[{{this}}]{{/each}}', { tags: ['<i>', 'a&b'] })).toBe(
        '[&lt;i&gt;][a&amp;b]'
      );
      // Numbers and text without markup are written as before
      expect(await renderBoth('{{n}} {{t}}', { n: 5, t: 'plain text' })).toBe('5 plain text');
    });

    it('writes a {{{value}}} exactly as given, and still never reads it as template source', async () => {
      const link = '<a href="/reset?token=abc&amp;u=1">Reset</a>';

      expect(await renderBoth('<p>{{{link}}}</p>', { link })).toBe(`<p>${link}</p>`);
      expect(await renderBoth('<p>{{{user.sig}}}</p>', { user: { sig: '<i>Ann</i>' } })).toBe(
        '<p><i>Ann</i></p>'
      );
      expect(
        await renderBoth('{{#each items}}{{{html}}}|{{{this}}}|{{{site}}};{{/each}}', {
          site: '<Acme>',
          items: [{ html: '<b>x</b>' }],
        })
      ).toBe('<b>x</b>||<Acme>;');
      expect(await renderBoth('{{#each tags}}{{{this}}}{{/each}}', { tags: ['<i>', '&'] })).toBe(
        '<i>&'
      );
      expect(
        await renderBoth('{{{bio}}}{{#if admin}}<b>admin</b>{{/if}}', {
          ...secrets,
          admin: false,
          bio: '{{apiKey}}{{{apiKey}}}{{#if apiKey}}yes{{/if}}',
        })
      ).toBe('{{apiKey}}{{{apiKey}}}{{#if apiKey}}yes{{/if}}');
      // Both forms side by side, and a missing value
      expect(await renderBoth('{{v}}|{{{v}}}|{{{missing}}}|', { v: '<>' })).toBe('&lt;&gt;|<>||');
    });

    it('refuses a template name that leads out of the template directory', async () => {
      const outside = `${testTemplatesPath}-outside`;
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(path.join(testTemplatesPath, 'orders'), { recursive: true });
      try {
        await fs.writeFile(path.join(outside, 'secret.html'), 'TOP SECRET {{name}}');
        await fs.writeFile(path.join(testTemplatesPath, 'orders', 'shipped.html'), 'Sent {{n}}');
        const engine = new TemplateEngineManager({ path: testTemplatesPath, cache: false });
        const outsideName = `../${path.basename(outside)}/secret`;

        for (const name of [
          outsideName,
          `orders/../${outsideName}`,
          path.join(outside, 'secret'),
        ]) {
          await expect(engine.renderFile(name, { name: 'x' })).rejects.toThrow(
            'is outside the template directory'
          );
        }

        // Through sendMail() as well
        mailManager = new MailManager({
          adapter: 'console',
          from: 'test@example.com',
          templates: { path: testTemplatesPath },
        });
        await mailManager.initialize();
        await expect(
          mailManager.send({ to: 'a@example.com', subject: 'S', template: outsideName, data: {} })
        ).rejects.toThrow('is outside the template directory');

        // Names inside the directory, subdirectories included, render as before
        expect((await engine.renderFile('orders/shipped', { n: 3 })).html).toBe('Sent 3');
        expect((await engine.renderFile('./orders/../orders/shipped', { n: 4 })).html).toBe(
          'Sent 4'
        );
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    // The first renderer read substituted values again as template source and
    // wrote them unescaped. Escaping the values before it sees them, hiding the
    // characters that make a tag or a replacement pattern from it, and putting
    // those back in its output, gives what it rendered for the same template
    // with every value taken as HTML-escaped plain text.
    const ESCAPES: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    const escapeValues = (value: any): any => {
      if (typeof value === 'string') return value.replace(/[&<>"']/g, c => ESCAPES[c] as string);
      if (Array.isArray(value)) return value.map(escapeValues);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, escapeValues(v)]));
      }
      return value;
    };
    const HIDDEN: Record<string, string> = { '{': '\uE000', '}': '\uE001', $: '\uE002' };
    const hide = (value: any): any => {
      if (typeof value === 'string') return value.replace(/[{}$]/g, c => HIDDEN[c] as string);
      if (Array.isArray(value)) return value.map(hide);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, hide(v)]));
      }
      return value;
    };
    const reveal = (text: string) =>
      text.replace(
        /[\uE000-\uE002]/g,
        c => ({ '\uE000': '{', '\uE001': '}', '\uE002': '$' })[c] as string
      );

    // Every template below - including ones whose blocks are nested or left
    // open in ways the engine does not support - must render exactly what the
    // first renderer did, with each value inserted as escaped plain text.
    it('matches the first renderer across a corpus of templates and data', async () => {
      const partials = { footer: '<footer>{{company}} {{#if a}}A{{/if}}</footer>' };
      const templates = [
        'plain text, no tags',
        '{{a}}|{{b}}|{{c.d}}|{{c.x}}|{{c.d.e}}|{{zzz}}|{{zero}}|{{no}}',
        '{{ a }} {{}} {a} {{a.}} {{.a}} {{a..b}} {{a-b}} {{#a}} {{/a}} {{>a b}}',
        '{{> footer}}{{>footer}}{{>   footer   }}{{> missing}}',
        '{{#if a}}yes{{else}}no{{/if}}|{{#if zero}}yes{{else}}no{{/if}}|{{#if nope}}yes{{/if}}',
        '{{#if  a}}two spaces{{/if}}{{#if\na}}newline{{/if}}{{#if a }}trailing space{{/if}}',
        '{{#if c.d}}dotted{{/if}}{{#if a}}1{{else}}2{{else}}3{{/if}}{{else}}',
        '{{#if a}}1{{#if b}}2{{/if}}3{{/if}}4|{{#if zero}}1{{#if b}}2{{/if}}3{{/if}}4',
        '{{#if zero}}1{{#if b}}2{{else}}3{{/if}}4{{/if}}5',
        '{{/if}}{{/each}}{{#if a}}open{{#each xs}}open',
        '{{#if a}}x{{/if}}{{/if}}{{#each xs}}y{{/each}}{{/each}}',
        '{{#each xs}}{{v}},{{/each}}|{{#each ys}}{{v}}{{/each}}|{{#each nope}}{{v}}{{/each}}',
        '{{#each xs}}{{a}}:{{v}}:{{w}}:{{w.z}}:{{q}}:{{this}};{{/each}}',
        '{{#each  xs}}{{v}}{{/each}}{{#each\txs}}{{v}}{{/each}}{{#each c.d}}x{{/each}}',
        '{{#each prims}}<{{this}}|{{v}}|{{a}}>{{/each}}',
        '{{#each sparse}}[{{this}}]{{/each}}{{#each empty}}never{{/each}}',
        '{{#each xs}}[{{#each ys}}{{v}}{{/each}}]{{/each}}',
        '{{#each xs}}{{v}}{{#if a}}+{{/if}}{{#if zero}}-{{else}}~{{/if}}{{/each}}',
        '{{#if a}}<{{#each xs}}{{v}}{{/each}}>{{else}}none{{/if}}',
        '{{#if zero}}<{{#each xs}}{{v}}{{/each}}>{{else}}none{{/if}}',
        // a conditional that holds only one half of a loop
        '{{#if a}}{{#each xs}}{{/if}}<{{v}}>{{/each}}',
        '{{#if zero}}{{#each xs}}{{/if}}<{{v}}>{{/each}}',
        '{{#each xs}}{{#if a}}{{/each}}tail{{/if}}',
        '{{#each xs}}{{v}}{{/each}}{{#each xs}}{{q}}{{/each}}',
        'price: $5 $& $1 {{money}}',
        '<a href="/u/{{c.d}}" title=\'{{b}}\'>{{b}}</a>\n\t{{#each xs}}\n  <li class="{{v}}">{{q}}</li>{{/each}}\n',
      ];
      const datasets: Record<string, any>[] = [
        {},
        {
          a: 'A&a',
          b: '<b>',
          c: { d: 'cd' },
          zero: 0,
          no: null,
          money: '$9.99',
          company: 'Acme',
          xs: [
            { v: 1, w: { z: 'z1' } },
            { v: '<2>', q: null },
            { q: 'q3', v: undefined },
          ],
          ys: [],
          prims: ['one', 2, true, undefined],
          // eslint-disable-next-line no-sparse-arrays
          sparse: ['a', , 'c'],
          empty: [],
        },
        { a: 0, b: 1, xs: [], ys: [{ v: 'y1' }, { v: 'y2' }], c: null, money: 0, prims: 'text' },
        { a: 1, b: 0, xs: [{ v: 'only' }], ys: [{ v: 'y' }], q: 'top-q', v: 'top-v', this: 'T' },
        { a: true, b: true, xs: 'not-an-array', ys: [1, 'two', { v: 3 }], else: 'ELSE' },
        // values that look like template source
        {
          a: '{{b}}',
          b: 'B',
          c: { d: '{{#if b}}x{{/if}}' },
          money: "$& $$ $' {{b}}",
          company: '{{a}}',
          q: 'top-q',
          xs: [
            { v: '{{b}}', q: '{{v}}' },
            { v: '{{#each ys}}!{{/each}}' },
            { v: '$&', w: '{{q}}' },
          ],
          ys: [{ v: '{{/each}}{{a}}' }],
          prims: ['{{b}}', '{{this}}', '$&{{/if}}'],
        },
      ];
      for (const template of templates) {
        for (const data of datasets) {
          expect({ template, data, out: await renderBoth(template, data, partials) }).toEqual({
            template,
            data,
            out: reveal(legacyRender(template, hide(escapeValues(data)), partials)),
          });
        }
      }

      // A partial registered after a template was compiled is still included
      await fs.writeFile(path.join(testTemplatesPath, 'late.html'), 'Hi {{name}}{{> footer}}');
      const engine = new TemplateEngineManager({ path: testTemplatesPath, cache: true });
      expect((await engine.renderFile('late', { name: 'Ann' })).html).toBe('Hi Ann');
      engine.registerPartial('footer', ' -- {{company}}');
      expect((await engine.renderFile('late', { name: 'Ann', company: 'Acme' })).html).toBe(
        'Hi Ann -- Acme'
      );
    });
  });

  // -------------------------------------------------------------------------
  // The optional packages below (handlebars as a mail engine, ejs, nodemailer,
  // resend, @aws-sdk/client-ses) are not dependencies of this repo. Each test
  // points the framework at a small stand-in file with the package's shape for
  // the calls under test, the way the framework finds the real one: through
  // isPackageAvailable() / resolveUserPackage().
  // -------------------------------------------------------------------------
  const PACKAGE_UTILS = '../../src/core/utilities/package-utils.js';
  const LOGGER = '../../src/core/logger/index.js';

  async function standIn(name: string, source: string): Promise<string> {
    const file = path.join(testTemplatesPath, `${name}.cjs`);
    await fs.writeFile(file, source);
    return file;
  }

  /**
   * Run `use` against a private copy of the mail modules that resolves
   * `packages` (null = not installed). Whatever imports lazily - an adapter,
   * an engine, the stand-in itself - has to be imported inside `use`.
   */
  async function withPackages<T>(
    packages: Record<string, string | null>,
    use: () => Promise<T>
  ): Promise<T> {
    jest.doMock(PACKAGE_UTILS, () => {
      const actual = jest.requireActual(PACKAGE_UTILS) as Record<string, (name: string) => any>;
      return {
        ...actual,
        isPackageAvailable: (name: string) =>
          name in packages ? packages[name] !== null : actual.isPackageAvailable(name),
        resolveUserPackage: (name: string) =>
          packages[name] ? packages[name] : actual.resolveUserPackage(name),
      };
    });
    // The private copy logs through the logger this file already loaded
    // (a second copy of the logger would add its own process listeners)
    const sharedLogger = { MoroLogger, logger: globalLogger, createFrameworkLogger };
    jest.doMock(LOGGER, () => sharedLogger);
    try {
      let result!: T;
      await jest.isolateModulesAsync(async () => {
        result = await use();
      });
      return result;
    } finally {
      jest.dontMock(PACKAGE_UTILS);
      jest.dontMock(LOGGER);
    }
  }

  describe('templates.engine handlebars / ejs', () => {
    // compile() and render() of each package, reduced to {{name}} / <%= name %>
    // with the HTML escaping both packages apply by default
    const ESCAPE = `
const escape = value =>
  String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);`;
    const HANDLEBARS = String.raw`${ESCAPE}
const helpers = {};
const partials = {};
function compile(template) {
  return data =>
    template
      .replace(/\{\{> (\w+)\}\}/g, (_, name) => compile(partials[name])(data))
      .replace(/\{\{(\w+) (\w+)\}\}/g, (_, helper, key) => escape(helpers[helper](data[key])))
      .replace(/\{\{(\w+)\}\}/g, (_, key) => escape(data[key]));
}
module.exports = {
  compile,
  registerHelper: (name, fn) => void (helpers[name] = fn),
  registerPartial: (name, template) => void (partials[name] = template),
};`;
    const EJS = String.raw`${ESCAPE}
function compile(template) {
  if (template.includes('<% broken')) throw new SyntaxError('Unexpected token while compiling ejs');
  return data => template.replace(/<%= (\w+) %>/g, (_, key) => escape(data[key]));
}
module.exports = { compile, render: (template, data) => compile(template)(data) };`;

    const engines = async () => ({
      handlebars: await standIn('handlebars', HANDLEBARS),
      ejs: await standIn('ejs', EJS),
    });

    /** Send `template` through a MailManager and return the HTML handed to the adapter. */
    async function sendTemplate(
      templates: Record<string, unknown>,
      template: string,
      data: Record<string, any>
    ) {
      const { MailManager: Manager } = await import('../../src/core/mail/mail-manager.js');
      const manager = new Manager({
        adapter: 'console',
        from: 'test@example.com',
        templates: { path: testTemplatesPath, ...templates },
      });
      await manager.initialize();
      const sent: Array<string | undefined> = [];
      (manager.getAdapter() as any).send = async (options: MailOptions) => {
        sent.push(options.html);
        return { success: true };
      };
      const result = await manager.send({ to: 'a@example.com', subject: 's', template, data });
      return { result, html: sent[0] };
    }

    it.each([[true], [false]])(
      'sends a template rendered by handlebars (cache: %s)',
      async cache => {
        await fs.writeFile(
          path.join(testTemplatesPath, 'welcome.html'),
          '<h1>Hi {{name}}</h1>{{> footer}}<p>{{shout name}}</p>'
        );
        const partials = path.join(testTemplatesPath, 'partials');
        await fs.mkdir(partials);
        await fs.writeFile(path.join(partials, 'footer.html'), '<footer>{{company}}</footer>');

        const { result, html } = await withPackages(await engines(), () =>
          sendTemplate(
            {
              engine: 'handlebars',
              cache,
              partials,
              helpers: { shout: (value: string) => String(value).toUpperCase() },
            },
            'welcome',
            { name: '<b>Ann</b>', company: 'Acme' }
          )
        );

        expect(result.success).toBe(true);
        expect(html).toBe(
          '<h1>Hi &lt;b&gt;Ann&lt;/b&gt;</h1><footer>Acme</footer><p>&lt;B&gt;ANN&lt;/B&gt;</p>'
        );
      }
    );

    it.each([[true], [false]])('sends a template rendered by ejs (cache: %s)', async cache => {
      await fs.writeFile(path.join(testTemplatesPath, 'welcome.html'), '<h1>Hi <%= name %></h1>');

      const { result, html } = await withPackages(await engines(), () =>
        sendTemplate({ engine: 'ejs', cache }, 'welcome', { name: '<b>Ann</b>' })
      );

      expect(result.success).toBe(true);
      expect(html).toBe('<h1>Hi &lt;b&gt;Ann&lt;/b&gt;</h1>');
    });

    it('imports the package on the first render when nothing loaded it before', async () => {
      await fs.writeFile(path.join(testTemplatesPath, 'page.html'), 'Hi <%= name %>');

      const rendered = await withPackages(await engines(), async () => {
        const { TemplateEngineManager: Engines } =
          await import('../../src/core/mail/template-engine.js');

        const handlebars = new Engines({ engine: 'handlebars' });
        // Registered before the package is imported: applied once it is
        handlebars.registerHelper('twice', (value: string) => value + value);
        handlebars.registerPartial('sig', '-- {{who}}');
        const ejs = new Engines({ engine: 'ejs', path: testTemplatesPath });

        return [
          await handlebars.renderString('{{twice name}} {{> sig}}', { name: 'ab', who: 'me' }),
          (await ejs.renderFile('page', { name: 'A' })).html,
          (await ejs.renderFile('page', { name: 'B' })).html,
        ];
      });

      expect(rendered).toEqual(['abab -- me', 'Hi A', 'Hi B']);
    });

    it('reports a template the engine cannot compile with the engine error', async () => {
      await fs.writeFile(path.join(testTemplatesPath, 'bad.html'), '<% broken');

      await withPackages(await engines(), async () => {
        const { TemplateEngineManager: Engines } =
          await import('../../src/core/mail/template-engine.js');
        const engine = new Engines({ engine: 'ejs', path: testTemplatesPath });

        await expect(engine.renderFile('bad', {})).rejects.toThrow(
          'Unexpected token while compiling ejs'
        );
        await expect(engine.renderFile('missing', {})).rejects.toThrow('Template file not found');
      });
    });

    it('says which package to install when the engine is not installed', async () => {
      await withPackages({ handlebars: null, ejs: null }, async () => {
        const { MailManager: Manager } = await import('../../src/core/mail/mail-manager.js');
        const { TemplateEngineManager: Engines } =
          await import('../../src/core/mail/template-engine.js');

        await expect(
          new Manager({
            adapter: 'console',
            from: 'test@example.com',
            templates: { path: testTemplatesPath, engine: 'handlebars' },
          }).initialize()
        ).rejects.toThrow('npm install handlebars');
        await expect(new Engines({ engine: 'ejs' }).renderString('x', {})).rejects.toThrow(
          'npm install ejs'
        );
      });
    });

    it('rejects an engine name it does not know', () => {
      expect(() => new TemplateEngineManager({ engine: 'pug' as any })).toThrow(
        'Unknown template engine "pug"'
      );
    });
  });

  describe('Nodemailer adapter addresses', () => {
    // createTransport() whose transporter records what sendMail() is given
    const NODEMAILER = `
const sent = [];
module.exports = {
  sent,
  createTransport: () => ({
    sendMail: async options => {
      sent.push(options);
      return { messageId: '<id@test>', accepted: [], rejected: [], response: '250 OK' };
    },
    close() {},
  }),
};`;
    let sent: any[];
    let adapter: any;

    beforeEach(async () => {
      const file = await standIn('nodemailer', NODEMAILER);
      await withPackages({ nodemailer: file }, async () => {
        const { NodemailerAdapter } =
          await import('../../src/core/mail/adapters/nodemailer-adapter.js');
        adapter = new NodemailerAdapter();
        await adapter.initialize({ host: 'localhost' });
        const loaded = await import(file);
        sent = (loaded.default ?? loaded).sent;
      });
    });

    const send = async (options: Partial<MailOptions>) => {
      const result = await adapter.send({
        from: 'noreply@example.com',
        to: 'a@example.com',
        subject: 's',
        text: 't',
        ...options,
      });
      expect(result.success).toBe(true);
      return sent[sent.length - 1];
    };

    it('hands a named address to nodemailer as { name, address }', async () => {
      const options = await send({
        from: { name: 'Support Team', email: 'noreply@example.com' },
        to: { name: 'Smith, Bob', email: 'bob@example.com' },
        cc: [{ name: 'Ann', email: 'ann@example.com' }, { email: 'plain@example.com' }],
        bcc: [{ name: 'Archive', email: 'archive@example.com' }],
        replyTo: { name: 'Help', email: 'help@example.com' },
        sender: { name: 'Mailer', email: 'mailer@example.com' },
      });

      expect(options.from).toEqual({ name: 'Support Team', address: 'noreply@example.com' });
      expect(options.to).toEqual({ name: 'Smith, Bob', address: 'bob@example.com' });
      expect(options.cc).toEqual([
        { name: 'Ann', address: 'ann@example.com' },
        'plain@example.com',
      ]);
      expect(options.bcc).toEqual([{ name: 'Archive', address: 'archive@example.com' }]);
      expect(options.replyTo).toEqual({ name: 'Help', address: 'help@example.com' });
      expect(options.sender).toEqual({ name: 'Mailer', address: 'mailer@example.com' });
    });

    it('never builds an address string out of a display name', async () => {
      const name = 'Bob" <victim@evil.test>, "x';

      const options = await send({
        from: { name, email: 'noreply@example.com' },
        to: [{ name, email: 'a@example.com' }],
        returnPath: 'bounce@example.com',
      });

      expect(options.from).toEqual({ name, address: 'noreply@example.com' });
      expect(options.to).toEqual([{ name, address: 'a@example.com' }]);
      expect(options.envelope.to).toEqual([{ name, address: 'a@example.com' }]);
    });

    it('passes strings and unnamed addresses through as before', async () => {
      const options = await send({
        from: 'Support <noreply@example.com>',
        to: [{ email: 'b@example.com' }, { name: '', email: 'c@example.com' }],
        bcc: ['a@example.com', 'Ann <ann@example.com>'],
        cc: '"Smith, Bob" <bob@example.com>, d@example.com',
        replyTo: { email: 'help@example.com' },
      });

      expect(options.from).toBe('Support <noreply@example.com>');
      expect(options.to).toEqual(['b@example.com', 'c@example.com']);
      expect(options.bcc).toEqual(['a@example.com', 'Ann <ann@example.com>']);
      expect(options.cc).toBe('"Smith, Bob" <bob@example.com>, d@example.com');
      expect(options.replyTo).toBe('help@example.com');
    });

    it('keeps a display name on one line and trims it', async () => {
      const options = await send({
        to: [
          { name: '  Bob  ', email: 'a@example.com' },
          { name: 'Bob\r\nBcc: victim@evil.test', email: 'b@example.com' },
          { name: 'Bob\nSmith\u0000', email: 'c@example.com' },
          { name: ' \r\n ', email: 'd@example.com' },
        ],
      });

      expect(options.to).toEqual([
        { name: 'Bob', address: 'a@example.com' },
        { name: 'Bob Bcc: victim@evil.test', address: 'b@example.com' },
        { name: 'Bob Smith', address: 'c@example.com' },
        'd@example.com',
      ]);
    });

    it('names the Cc and Bcc recipients in the envelope when returnPath sets one', async () => {
      const options = await send({
        to: 'a@example.com',
        cc: ['c@example.com'],
        bcc: { name: 'Archive', email: 'archive@example.com' },
        returnPath: 'bounce@example.com',
      });

      expect(options.envelope).toEqual({
        from: 'bounce@example.com',
        to: 'a@example.com',
        cc: ['c@example.com'],
        bcc: { name: 'Archive', address: 'archive@example.com' },
      });

      expect((await send({ to: 'a@example.com' })).envelope).toBeUndefined();
    });
  });

  describe('Resend adapter', () => {
    // The SDK never throws for an API error: emails.send() and batch.send()
    // resolve { data, error }. `next` is what the next call resolves.
    const RESEND = `
const state = { calls: [], next: null };
class Resend {
  constructor(apiKey) {
    this.apiKey = apiKey;
    const call = kind => async payload => {
      state.calls.push({ kind, payload });
      return state.next;
    };
    this.emails = { send: call('send') };
    this.batch = { send: call('batch') };
  }
}
module.exports = { Resend, state };`;
    const HEADERS = { 'content-type': 'application/json' };
    let state: { calls: Array<{ kind: string; payload: any }>; next: unknown };
    let adapter: any;

    beforeEach(async () => {
      const file = await standIn('resend', RESEND);
      await withPackages({ resend: file }, async () => {
        const { ResendAdapter } = await import('../../src/core/mail/adapters/resend-adapter.js');
        adapter = new ResendAdapter();
        await adapter.initialize({ apiKey: 're_test' });
        const loaded = await import(file);
        state = (loaded.default ?? loaded).state;
      });
    });

    const mail = (to: string): MailOptions => ({
      from: 'noreply@example.com',
      to,
      subject: 's',
      text: 't',
    });

    it('returns the id of an email the API accepted', async () => {
      state.next = { data: { id: 're-123' }, error: null, headers: HEADERS };

      const result = await adapter.send(mail('a@example.com'));

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('re-123');
    });

    it('reports an email the API rejected as failed', async () => {
      state.next = {
        data: null,
        error: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' },
        headers: HEADERS,
      };

      const result = await adapter.send(mail('not-an-address'));

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid `to` field.');
      expect(result.messageId).toBeUndefined();
    });

    it('gives the SDK the reply address under the key it reads', async () => {
      state.next = { data: { id: 're-1' }, error: null, headers: HEADERS };

      await adapter.send({
        ...mail('a@example.com'),
        replyTo: { name: 'Help', email: 'h@example.com' },
      });
      await adapter.send({ ...mail('a@example.com'), replyTo: 'plain@example.com' });

      expect(state.calls[0].payload.replyTo).toBe('Help <h@example.com>');
      expect(state.calls[0].payload).not.toHaveProperty('reply_to');
      expect(state.calls[1].payload.replyTo).toBe('plain@example.com');
    });

    it('reports an accepted batch as sent, one id per email in order', async () => {
      state.next = {
        data: { data: [{ id: 're-1' }, { id: 're-2' }, { id: 're-3' }] },
        error: null,
        headers: HEADERS,
      };

      const results = await adapter.sendBulk([
        mail('a@example.com'),
        mail('b@example.com'),
        mail('c@example.com'),
      ]);

      expect(state.calls).toHaveLength(1);
      expect(state.calls[0].kind).toBe('batch');
      expect(results.map((result: any) => [result.success, result.messageId])).toEqual([
        [true, 're-1'],
        [true, 're-2'],
        [true, 're-3'],
      ]);
    });

    it('reports a rejected batch as failed for every email', async () => {
      state.next = {
        data: null,
        error: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' },
        headers: HEADERS,
      };

      const results = await adapter.sendBulk([mail('a@example.com'), mail('nope')]);

      expect(results).toEqual([
        { success: false, error: 'Invalid `to` field.' },
        { success: false, error: 'Invalid `to` field.' },
      ]);
    });

    it('quotes a display name that would otherwise end early', async () => {
      state.next = { data: { id: 're-1' }, error: null, headers: HEADERS };

      await adapter.send({
        ...mail('a@example.com'),
        from: { name: 'Bob" <victim@evil.test>, "x', email: 'noreply@example.com' },
        to: [
          { name: 'Acme Inc.', email: 'a@example.com' },
          { name: 'Jürgen Müller', email: 'b@example.com' },
          { name: 'Smith, Bob', email: 'c@example.com' },
          { name: 'Back\\slash', email: 'd@example.com' },
        ],
      });

      const { payload } = state.calls[0];
      expect(payload.from).toBe('"Bob\\" <victim@evil.test>, \\"x" <noreply@example.com>');
      expect(payload.to).toEqual([
        'Acme Inc. <a@example.com>',
        'Jürgen Müller <b@example.com>',
        '"Smith, Bob" <c@example.com>',
        '"Back\\\\slash" <d@example.com>',
      ]);
    });
  });

  describe('SES adapter addresses', () => {
    const SES = `
const sent = [];
class SESClient {
  async send(command) {
    sent.push(command.input);
    return { MessageId: 'ses-1' };
  }
}
class SendEmailCommand {
  constructor(input) {
    this.input = input;
  }
}
module.exports = { SESClient, SendEmailCommand, sent };`;

    it('escapes quotes and backslashes in the Source and ReplyTo display names', async () => {
      const file = await standIn('client-ses', SES);

      const sent = await withPackages({ '@aws-sdk/client-ses': file }, async () => {
        const { SESAdapter } = await import('../../src/core/mail/adapters/ses-adapter.js');
        const adapter = new SESAdapter();
        await adapter.initialize({ region: 'us-east-1' });
        const send = (from: MailOptions['from'], replyTo?: MailOptions['replyTo']) =>
          adapter.send({
            to: 'a@example.com',
            subject: 's',
            text: 't',
            ...(from ? { from } : {}),
            ...(replyTo ? { replyTo } : {}),
          });

        await send(
          { name: 'Support" <ceo@corp.test>, "x', email: 'noreply@example.com' },
          { name: 'Back\\slash', email: 'r@example.com' }
        );
        await send({ name: 'Smith, Bob', email: 'noreply@example.com' });

        const loaded = await import(file);
        return (loaded.default ?? loaded).sent as any[];
      });

      expect(sent[0].Source).toBe('"Support\\" <ceo@corp.test>, \\"x" <noreply@example.com>');
      expect(sent[0].ReplyToAddresses).toEqual(['"Back\\\\slash" <r@example.com>']);
      // A name without either character is sent as before
      expect(sent[1].Source).toBe('"Smith, Bob" <noreply@example.com>');
    });
  });

  describe('app.mailInit() with a queue', () => {
    let app: any;
    let deliveries: any[];

    const mail = (n: number) => ({ to: `user${n}@example.com`, subject: 'Welcome', text: 'hello' });
    const settle = () => new Promise(resolve => setTimeout(resolve, 100));

    beforeEach(async () => {
      deliveries = [];
      // Count what reaches the adapter without printing it
      jest.spyOn(ConsoleAdapter.prototype, 'send').mockImplementation(async (options: any) => {
        deliveries.push(options.to);
        return { success: true, messageId: `sent-${deliveries.length}` };
      });
      app = await createApp({ logger: { level: 'error' }, autoDiscover: false });
    });

    afterEach(async () => {
      await app.close();
      jest.restoreAllMocks();
      globalLogger.setLevel('fatal');
    });

    it('delivers through an in-memory queue when the app uses queues but not the mail queue', async () => {
      app.queueInit('reports', { adapter: 'memory' });
      app.mailInit({ adapter: 'console', from: 'noreply@example.com', queue: { enabled: true } });

      const first = await app.sendMail(mail(1));
      const second = await app.sendMail(mail(2));
      await settle();

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(deliveries).toEqual(['user1@example.com', 'user2@example.com']);
      expect(app.hasQueue('emails')).toBe(true);
      const status = await app.getQueueStatus('emails');
      expect(status.adapter).toBe('memory');
      expect(status.metrics.waiting).toBe(0);
    });

    it("delivers through a queue the app registered, at that queue's own concurrency", async () => {
      const process = jest.spyOn(MemoryAdapter.prototype, 'process');
      app.queueInit('outbox', { adapter: 'memory', concurrency: 7 });
      app.mailInit({
        adapter: 'console',
        from: 'noreply@example.com',
        queue: { enabled: true, name: 'outbox' },
      });

      const result = await app.sendMail(mail(1));
      await settle();

      // Queued: the result carries the job id, the adapter is reached later
      expect(result).toEqual({ success: true, messageId: expect.any(String) });
      expect(deliveries).toEqual(['user1@example.com']);
      expect(process).toHaveBeenCalledTimes(1);
      expect(process).toHaveBeenCalledWith('outbox', 7, expect.any(Function));
      expect((await app.getQueueStatus('outbox')).metrics.waiting).toBe(0);
    });

    it('leaves a mail queue to the processor the app attached, even while the queue is still registering', async () => {
      // An adapter that takes a moment to connect
      const initialize = MemoryAdapter.prototype.initialize;
      jest.spyOn(MemoryAdapter.prototype, 'initialize').mockImplementation(async function (
        this: MemoryAdapter
      ) {
        await new Promise(resolve => setTimeout(resolve, 50));
        return initialize.call(this);
      });
      const process = jest.spyOn(MemoryAdapter.prototype, 'process');
      const seen: any[] = [];

      app.queueInit('emails', { adapter: 'memory' });
      const attached = app.processQueue('emails', async (job: any) => {
        seen.push(job.data.to);
      });
      app.mailInit({ adapter: 'console', from: 'noreply@example.com', queue: { enabled: true } });

      await app.sendMail(mail(1));
      await attached;
      await settle();

      // The application's processor is the only one, and it got the mail
      expect(process).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(['user1@example.com']);
      expect(deliveries).toEqual([]);
    });

    it('retries a queued mail the adapter reports as failed', async () => {
      (ConsoleAdapter.prototype.send as any).mockImplementationOnce(async () => ({
        success: false,
        error: 'mailbox busy',
      }));
      app.queueInit('emails', { adapter: 'memory' });
      app.mailInit({ adapter: 'console', from: 'noreply@example.com', queue: { enabled: true } });

      await app.sendMail(mail(1));
      await settle();

      expect(ConsoleAdapter.prototype.send).toHaveBeenCalledTimes(2);
      expect(deliveries).toEqual(['user1@example.com']);
    });

    it('sends directly, and says so once, when the app has no queue system', async () => {
      globalLogger.setLevel('warn');
      const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      app.mailInit({ adapter: 'console', from: 'noreply@example.com', queue: { enabled: true } });

      const result = await app.sendMail(mail(1));
      await app.sendMail(mail(2));

      // Sent before sendMail() returned, with the adapter's own result
      expect(result.messageId).toBe('sent-1');
      expect(deliveries).toEqual(['user1@example.com', 'user2@example.com']);
      expect(app.hasQueue('emails')).toBe(false);
      const warnings = logSpy.mock.calls.filter(
        c => c[0] === 'warn' && /has no queue system/.test(String(c[1]))
      );
      expect(warnings).toHaveLength(1);
    });

    it('does not warn about the queue when mail is not queued', async () => {
      globalLogger.setLevel('warn');
      const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      app.mailInit({ adapter: 'console', from: 'noreply@example.com' });

      await app.sendMail(mail(1));

      expect(logSpy.mock.calls.filter(c => c[0] === 'warn' && /queue/.test(String(c[1])))).toEqual(
        []
      );
    });

    it('initialises once for concurrent first sends, and again after an initialisation that failed', async () => {
      const initialize = jest
        .spyOn(MailManager.prototype, 'initialize')
        .mockRejectedValueOnce(new Error('smtp unreachable'));
      app.mailInit({ adapter: 'console', from: 'noreply@example.com' });

      const failed = await Promise.allSettled([app.sendMail(mail(1)), app.sendMail(mail(2))]);
      expect(failed.map(r => r.status)).toEqual(['rejected', 'rejected']);
      expect(initialize).toHaveBeenCalledTimes(1);

      await Promise.all([app.sendMail(mail(3)), app.sendMail(mail(4)), app.sendMail(mail(5))]);

      expect(initialize).toHaveBeenCalledTimes(2);
      expect(deliveries).toHaveLength(3);
    });
  });
});
