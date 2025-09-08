# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of MoroJS seriously. If you discover a security vulnerability, please follow these steps:

### 🔒 Private Disclosure

**DO NOT** open a public issue for security vulnerabilities.

Instead, please report security issues by:

1. **Email**: Send details to security@morojs.com
2. **GitHub Security Advisory**: Use the "Security" tab → "Report a vulnerability"

### 📝 What to Include

Please include as much of the following information as possible:

- Type of issue (e.g. buffer overflow, SQL injection, XSS, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### 🚀 Response Timeline

- **Initial Response**: Within 48 hours
- **Assessment**: Within 7 days
- **Fix Timeline**: Depends on severity
  - Critical: 1-3 days
  - High: 1-2 weeks
  - Medium: 2-4 weeks
  - Low: Next release cycle

### 🏆 Recognition

We appreciate responsible disclosure and will acknowledge security researchers who report vulnerabilities to us in our security advisories (unless you prefer to remain anonymous).

## Security Best Practices

When using MoroJS in production:

1. Keep dependencies updated
2. Use HTTPS in production
3. Implement proper input validation
4. Follow the principle of least privilege
5. Regular security audits with `npm audit`
6. Monitor for security advisories

## Security Features

MoroJS includes several built-in security features:

- Input validation with Zod schemas
- CSRF protection middleware
- Rate limiting capabilities  
- Content Security Policy (CSP) support
- Secure headers middleware
- Circuit breaker patterns

For more details, see our [Security Documentation](../docs/SECURITY.md). 