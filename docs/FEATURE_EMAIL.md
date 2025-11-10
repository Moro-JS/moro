# Feature Specification: Email System

## Overview

Add production-ready email support to MoroJS following the framework's adapter pattern and optional dependency philosophy.

---

## Design Principles

1. **ESM First** - Pure ESM module with `.js` imports, dynamic imports
2. **Adapter Pattern** - Multiple email providers (Nodemailer, SendGrid, AWS SES, Resend)
3. **Optional Dependencies** - All email packages as peer dependencies
4. **Lazy Loading** - Load packages only when `app.mailInit()` is called via dynamic import
5. **Template Support** - Built-in template rendering
6. **Moro Integration** - Works with queue system for async sending

---

## Core Architecture

### File Structure
```
src/core/mail/
├── index.ts                      # Public exports (ESM)
├── types.ts                      # TypeScript interfaces
├── mail-manager.ts               # Main manager
├── mail-adapter.ts               # Base adapter interface
├── template-engine.ts            # Email template rendering
├── adapters/
│   ├── index.ts                  # Adapter exports
│   ├── nodemailer-adapter.ts     # SMTP via Nodemailer
│   ├── sendgrid-adapter.ts       # SendGrid API
│   ├── ses-adapter.ts            # AWS SES
│   ├── resend-adapter.ts         # Resend API
│   └── console-adapter.ts        # Console logging (testing)
└── templates/
    └── default-templates/        # Built-in email templates

Note: All imports use .js extension (e.g., './mail-manager.js')
```

### Adapters

**NodemailerAdapter** (Default)
- Package: `nodemailer`
- Use case: SMTP, Gmail, custom mail servers
- Features: Universal SMTP support

**SendGridAdapter**
- Package: `@sendgrid/mail`
- Use case: SendGrid service
- Features: Templates, analytics, deliverability

**SESAdapter**
- Package: `@aws-sdk/client-ses`
- Use case: AWS ecosystem
- Features: High volume, cost-effective

**ResendAdapter**
- Package: `resend`
- Use case: Modern email API
- Features: Simple API, developer-friendly

**ConsoleAdapter** (Built-in)
- Package: None (built-in)
- Use case: Development and testing
- Features: Logs to console

---

## API Design

### Configuration

```typescript
app.mailInit({
  adapter: 'nodemailer',
  from: {
    name: 'My App',
    email: 'noreply@myapp.com'
  },
  connection: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  },
  templates: {
    path: './emails',
    engine: 'moro', // or 'handlebars', 'ejs'
    cache: true
  },
  queue: {
    enabled: true,
    name: 'emails'
  }
});
```

### Sending Emails

```typescript
// Simple email
await app.sendMail({
  to: 'user@example.com',
  subject: 'Welcome',
  text: 'Welcome to our app!',
  html: '<h1>Welcome to our app!</h1>'
});

// With template
await app.sendMail({
  to: 'user@example.com',
  subject: 'Password Reset',
  template: 'password-reset',
  data: {
    name: 'John',
    resetUrl: 'https://myapp.com/reset/token123'
  }
});

// With attachments
await app.sendMail({
  to: 'user@example.com',
  subject: 'Invoice',
  template: 'invoice',
  data: { invoice },
  attachments: [
    {
      filename: 'invoice.pdf',
      content: pdfBuffer
    }
  ]
});

// Batch emails
await app.sendBulkMail([
  { to: 'user1@example.com', subject: 'Hello', text: 'Hi!' },
  { to: 'user2@example.com', subject: 'Hello', text: 'Hi!' }
]);
```

### Template System

```typescript
// Built-in Moro template syntax
// emails/welcome.html
`
<h1>Welcome {{name}}!</h1>
<p>Thanks for joining {{appName}}</p>

{{#if isPremium}}
  <p>You have premium features enabled!</p>
{{/if}}

{{#each features}}
  <li>{{name}}: {{description}}</li>
{{/each}}
`

// Use template
await app.sendMail({
  to: user.email,
  template: 'welcome',
  data: {
    name: user.name,
    appName: 'My App',
    isPremium: user.plan === 'premium',
    features: user.features
  }
});
```

---

## Optional Dependencies

### package.json
```json
{
  "peerDependencies": {
    "nodemailer": "^6.9.0",
    "@sendgrid/mail": "^8.0.0",
    "@aws-sdk/client-ses": "^3.0.0",
    "resend": "^3.0.0",
    "handlebars": "^4.7.0",
    "ejs": "^3.1.0"
  },
  "peerDependenciesMeta": {
    "nodemailer": { "optional": true },
    "@sendgrid/mail": { "optional": true },
    "@aws-sdk/client-ses": { "optional": true },
    "resend": { "optional": true },
    "handlebars": { "optional": true },
    "ejs": { "optional": true }
  }
}
```

### Dependency Detection (ESM)
- Use `isPackageAvailable('nodemailer')` before loading
- Throw helpful error with install instructions if missing
- Lazy load with `resolveUserPackage()` and **dynamic import** (`await import()`)
- All imports must use `.js` extension (TypeScript → JavaScript)

```typescript
// ESM lazy loading pattern
let Nodemailer: any = null;

async function loadNodemailer() {
  if (!Nodemailer) {
    const mailerPath = resolveUserPackage('nodemailer');
    Nodemailer = await import(mailerPath); // Dynamic ESM import
  }
  return Nodemailer;
}
```

---

## Features

### Core Capabilities
- ✅ Multiple provider support
- ✅ Template rendering (Moro, Handlebars, EJS)
- ✅ Attachment support
- ✅ HTML and text emails
- ✅ CC, BCC support
- ✅ Custom headers
- ✅ Reply-to configuration

### Template Features
- ✅ Variable interpolation
- ✅ Conditionals (if/else)
- ✅ Loops (each)
- ✅ Partials/layouts
- ✅ Template caching
- ✅ Custom helpers

### Async Processing
- ✅ Queue integration
- ✅ Retry on failure
- ✅ Batch sending
- ✅ Rate limiting
- ✅ Scheduled sending

### Monitoring
- ✅ Send success/failure tracking
- ✅ Delivery status (if supported by provider)
- ✅ Event emission
- ✅ Error logging

### Moro Integration
- ✅ Works with message queue
- ✅ Event bus integration
- ✅ Logger integration
- ✅ Validation support
- ✅ Configuration system

---

## Use Cases

### User Registration
```typescript
app.post('/register')
  .body(RegisterSchema)
  .handler(async (req, res) => {
    const user = await createUser(req.body);

    // Send welcome email (queued)
    await app.sendMail({
      to: user.email,
      template: 'welcome',
      data: {
        name: user.name,
        verifyUrl: generateVerifyUrl(user)
      }
    });

    return { success: true };
  });
```

### Password Reset
```typescript
app.post('/forgot-password')
  .body(z.object({ email: z.string().email() }))
  .handler(async (req, res) => {
    const user = await findUser(req.body.email);
    const token = generateResetToken(user);

    await app.sendMail({
      to: user.email,
      template: 'password-reset',
      data: {
        name: user.name,
        resetUrl: `https://myapp.com/reset/${token}`,
        expiresIn: '1 hour'
      }
    });

    return { success: true };
  });
```

### Transactional Emails
```typescript
// Order confirmation
await app.sendMail({
  to: order.customerEmail,
  template: 'order-confirmation',
  data: {
    orderNumber: order.id,
    items: order.items,
    total: order.total,
    trackingUrl: order.trackingUrl
  },
  attachments: [
    {
      filename: 'invoice.pdf',
      content: await generateInvoice(order)
    }
  ]
});
```

### Bulk/Newsletter Emails
```typescript
// Send to subscribers (queued in batches)
const subscribers = await getSubscribers();

for (const batch of chunk(subscribers, 100)) {
  await app.sendBulkMail(
    batch.map(sub => ({
      to: sub.email,
      template: 'newsletter',
      data: {
        name: sub.name,
        unsubscribeUrl: generateUnsubUrl(sub)
      }
    }))
  );
}
```

---

## Adapter-Specific Features

### Nodemailer (SMTP)
- Works with any SMTP server
- Gmail, Outlook, custom servers
- OAuth2 authentication support

### SendGrid
- Template management in SendGrid
- Click/open tracking
- Suppression list management
- Webhook integration

### AWS SES
- Configuration sets
- Bounce/complaint handling
- Email verification
- High volume sending

### Resend
- Modern REST API
- Simple authentication
- Domain verification
- Batch sending

---

## CLI Integration

```bash
# Setup email
morojs-cli mail:setup --adapter=sendgrid

# Create template
morojs-cli mail:template welcome --fields=name,email

# Test email
morojs-cli mail:test --to=test@example.com --template=welcome

# View queue status
morojs-cli mail:queue-status
```

---

## Testing Strategy

### Unit Tests
- Test template rendering
- Mock email adapters
- Validate email content

### Integration Tests
- Use console adapter
- Test full email flow
- Verify queue integration

### Example
```typescript
describe('Email System', () => {
  beforeAll(() => {
    app.mailInit({
      adapter: 'console',
      templates: { path: './test-emails' }
    });
  });

  test('sends welcome email', async () => {
    const result = await app.sendMail({
      to: 'test@example.com',
      template: 'welcome',
      data: { name: 'Test User' }
    });

    expect(result.success).toBe(true);
  });
});
```

---

## Template Examples

### Welcome Email
```html
<!-- emails/welcome.html -->
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; }
    .button { background: #007bff; color: white; padding: 10px 20px; }
  </style>
</head>
<body>
  <h1>Welcome {{name}}!</h1>
  <p>Thanks for joining {{appName}}. We're excited to have you.</p>

  {{#if verifyUrl}}
    <a href="{{verifyUrl}}" class="button">Verify Your Email</a>
  {{/if}}

  <p>Best regards,<br>The {{appName}} Team</p>
</body>
</html>
```

### Password Reset
```html
<!-- emails/password-reset.html -->
<h1>Password Reset Request</h1>
<p>Hi {{name}},</p>
<p>We received a request to reset your password.</p>
<a href="{{resetUrl}}">Reset Password</a>
<p>This link expires in {{expiresIn}}.</p>
<p>If you didn't request this, please ignore this email.</p>
```

---

## Documentation Requirements

### User Guide
- Getting started with email
- Choosing an email provider
- Template creation
- Sending strategies
- Testing emails
- Best practices

### API Reference
- Configuration options
- Send API
- Template API
- Adapter API
- Event reference

---

## Success Criteria

✅ Zero forced dependencies
✅ Unified API across all adapters
✅ Template support with multiple engines
✅ Queue integration for async sending
✅ Full Moro integration (events, logging, config)
✅ Type-safe with TypeScript
✅ Comprehensive tests (>80% coverage)
✅ Complete documentation
✅ CLI tooling support
✅ Console adapter for testing

---

## ESM Requirements

### Module System
- **Pure ESM** - No CommonJS support
- All imports use `.js` extension (TypeScript compiles .ts → .js)
- Dynamic imports for lazy loading: `await import()`
- No `require()` - use `import` only

### Import Examples
```typescript
// Static imports (types, interfaces)
import type { MailOptions, MailAdapter } from './types.js';
import { createFrameworkLogger } from '../logger/index.js';
import { isPackageAvailable, resolveUserPackage } from '../utilities/package-utils.js';

// Dynamic imports (lazy loading adapters)
const { NodemailerAdapter } = await import('./adapters/nodemailer-adapter.js');

// User package resolution
const nodemailerPath = resolveUserPackage('nodemailer');
const nodemailer = await import(nodemailerPath);
```

### Package.json
```json
{
  "type": "module",
  "exports": {
    "./mail": {
      "types": "./dist/core/mail/index.d.ts",
      "import": "./dist/core/mail/index.js"
    }
  }
}
```

### Adapter ESM Compatibility
All email adapters must be ESM-compatible:
- ✅ `nodemailer` - ESM support (v7+)
- ✅ `@sendgrid/mail` - Pure ESM
- ✅ `@aws-sdk/client-ses` - Pure ESM
- ✅ `resend` - Pure ESM
- ⚠️ Older packages may need ESM wrappers

---

## Related Features

- Integrates with Message Queue for async processing
- Works with existing template middleware
- Uses Moro's configuration system
- Compatible with all validation libraries

---

## Implementation Priority

**Phase 1: Core**
- Adapter interface
- Nodemailer adapter
- Basic sending API
- Console adapter for testing

**Phase 2: Templates**
- Template engine integration
- Moro template syntax
- Template caching
- Partial support

**Phase 3: Additional Adapters**
- SendGrid adapter
- SES adapter
- Resend adapter

**Phase 4: Integration**
- Queue integration
- Event bus integration
- Rate limiting
- CLI tools

