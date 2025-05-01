# Contributing to MoroJS

Thank you for considering contributing to MoroJS! This guide will help you get started with contributing to the framework.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Contributing Guidelines](#contributing-guidelines)
- [Testing](#testing)
- [Documentation](#documentation)
- [Pull Request Process](#pull-request-process)
- [Community](#community)

---

## Getting Started

### Ways to Contribute

- **Bug Reports** - Help us identify and fix issues
- **Feature Requests** - Suggest new capabilities
- **Code Contributions** - Implement features or fix bugs
- **Documentation** - Improve guides, examples, and API docs
- **Examples** - Create real-world usage examples
- **Testing** - Help improve test coverage and quality

### Before You Start

1. Check existing [issues](https://github.com/MoroJS/moro/issues) and [pull requests](https://github.com/MoroJS/moro/pulls)
2. Join our [Discord community](https://discord.gg/morojs) for discussions
3. Read our [Code of Conduct](./CODE_OF_CONDUCT.md)
4. Review this contributing guide

---

## Development Setup

### Prerequisites

- **Node.js** 18.0.0 or higher
- **npm** 8.0.0 or higher
- **Git**

### Fork and Clone

```bash
# Fork the repository on GitHub
# Then clone your fork
git clone https://github.com/YOUR_USERNAME/moro.git
cd moro

# Add upstream remote
git remote add upstream https://github.com/MoroJS/moro.git
```

### Install Dependencies

```bash
# Install dependencies
npm install

# Install development dependencies
npm install --dev
```

### Build the Project

```bash
# Build TypeScript
npm run build

# Build and watch for changes
npm run build:watch
```

### Run Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test files
npm test -- --testNamePattern="validation"

# Run tests with coverage
npm run test:coverage
```

### Start Development Server

```bash
# Run example application
npm run dev

# Run with specific runtime
npm run dev:edge
npm run dev:lambda
npm run dev:worker
```

---

## Project Structure

```
moro/
├── src/                    # Source code
│   ├── core/              # Core framework functionality
│   │   ├── framework.ts   # Main framework class
│   │   ├── http/          # HTTP server and routing
│   │   ├── validation/    # Zod validation system
│   │   ├── middleware/    # Built-in middleware
│   │   ├── runtime/       # Runtime adapters
│   │   └── modules/       # Module system
│   ├── types/             # TypeScript type definitions
│   ├── index.ts           # Main entry point
│   └── moro.ts           # Framework exports
├── tests/                 # Test files
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   └── e2e/              # End-to-end tests
├── docs/                  # Documentation
├── examples/              # Example applications
└── scripts/               # Build and utility scripts
```

### Key Files

- **`src/core/framework.ts`** - Main framework class and initialization
- **`src/core/http/router.ts`** - Intelligent routing system
- **`src/core/validation/index.ts`** - Zod validation integration
- **`src/core/runtime/`** - Runtime adapters for different environments
- **`src/types/`** - TypeScript type definitions

---

## Contributing Guidelines

### Code Style

We use ESLint and Prettier for code formatting:

```bash
# Check linting
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

### Coding Standards

1. **TypeScript First** - All code should be written in TypeScript
2. **Functional Programming** - Prefer pure functions and immutable data
3. **Type Safety** - Use strict TypeScript settings, avoid `any`
4. **Documentation** - Document public APIs with JSDoc
5. **Testing** - Include tests for all new functionality

### Example Code Style

```typescript
/**
 * Creates a new route builder for the specified HTTP method
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Route path pattern
 * @returns RouteBuilder instance for method chaining
 */
export function createRouteBuilder(
  method: HttpMethod,
  path: string
): RouteBuilder {
  return new RouteBuilder(method, path);
}

// Use explicit types
interface RouteConfig {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  validation?: ValidationConfig;
}

// Prefer functional patterns
const validateRequest = (schema: ZodSchema) => 
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    req.body = result.data;
    next();
  };
```

### Commit Messages

Use conventional commit messages:

```
feat: add WebSocket support to all runtimes
fix: resolve middleware ordering issue in edge runtime
docs: update API reference for validation system
test: add integration tests for rate limiting
refactor: simplify route builder implementation
perf: optimize validation performance by 15%
```

### Branch Naming

Use descriptive branch names:

```
feature/websocket-support
bugfix/middleware-ordering
docs/api-reference-update
refactor/route-builder-simplification
```

---

## Testing

### Test Structure

- **Unit Tests** - Test individual functions and classes
- **Integration Tests** - Test module interactions
- **E2E Tests** - Test complete application flows
- **Runtime Tests** - Test across different runtimes

### Writing Tests

```typescript
// tests/unit/validation.test.ts
import { describe, test, expect } from '@jest/globals';
import { z } from 'zod';
import { validate } from '../../src/core/validation';

describe('Validation System', () => {
  test('should validate valid data', () => {
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email()
    });
    
    const validData = {
      name: 'John Doe',
      email: 'john@example.com'
    };
    
    const result = schema.safeParse(validData);
    expect(result.success).toBe(true);
  });
  
  test('should reject invalid data', () => {
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email()
    });
    
    const invalidData = {
      name: 'J',
      email: 'invalid-email'
    };
    
    const result = schema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});
```

### Test Coverage

Maintain high test coverage:

```bash
# Check coverage
npm run test:coverage

# Coverage should be above 90%
```

### Runtime Testing

Test across all supported runtimes:

```typescript
// tests/runtime/cross-runtime.test.ts
import { createApp, createAppEdge, createAppLambda, createAppWorker } from '../../src';

const runtimes = [
  { name: 'node', factory: createApp },
  { name: 'vercel-edge', factory: createAppEdge },
  { name: 'aws-lambda', factory: createAppLambda },
  { name: 'cloudflare-workers', factory: createAppWorker }
];

describe.each(runtimes)('$name runtime', ({ name, factory }) => {
  test('basic functionality works', async () => {
    const app = factory();
    
    app.get('/test', () => ({ runtime: name }));
    
    const response = await request(app).get('/test');
    expect(response.status).toBe(200);
    expect(response.body.runtime).toBe(name);
  });
});
```

---

## Documentation

### Documentation Types

1. **API Documentation** - JSDoc comments in code
2. **User Guides** - Comprehensive guides in `/docs`
3. **Examples** - Working examples in `/examples`
4. **README** - Overview and quick start

### Writing Documentation

```typescript
/**
 * Validates request data using Zod schema
 * 
 * @example
 * ```typescript
 * app.post('/users')
 *   .body(z.object({
 *     name: z.string().min(2),
 *     email: z.string().email()
 *   }))
 *   .handler(createUser);
 * ```
 * 
 * @param schema - Zod schema for validation
 * @returns Middleware function that validates request data
 */
export function validateBody<T extends ZodSchema>(
  schema: T
): ValidationMiddleware<z.infer<T>> {
  // Implementation
}
```

### Documentation Guidelines

1. **Clear Examples** - Include working code examples
2. **Comprehensive** - Cover all use cases and edge cases
3. **Up-to-date** - Keep documentation in sync with code changes
4. **Beginner Friendly** - Explain concepts for new users
5. **Advanced Topics** - Cover complex scenarios for experienced users

---

## Pull Request Process

### Before Submitting

1. **Sync with upstream** - Ensure your fork is up-to-date
2. **Run tests** - All tests must pass
3. **Check linting** - Code must pass linting checks
4. **Update documentation** - Include relevant doc updates
5. **Add tests** - Include tests for new functionality

### Pull Request Template

```markdown
## Description

Brief description of changes and motivation.

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] All tests pass
- [ ] Tested across all runtimes

## Checklist

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or breaking changes are documented)
```

### Review Process

1. **Automated Checks** - CI/CD pipeline runs tests and linting
2. **Code Review** - Maintainers review code and provide feedback
3. **Testing** - Changes are tested in different environments
4. **Approval** - At least one maintainer approves the PR
5. **Merge** - PR is merged into main branch

### After Merge

- Your contribution will be included in the next release
- You'll be added to the contributors list
- Consider helping review other PRs

---

## Community

### Communication Channels

- **GitHub Issues** - Bug reports and feature requests
- **GitHub Discussions** - General questions and discussions
- **Discord** - Real-time chat and community support
- **Twitter** - Updates and announcements

### Getting Help

1. **Search existing issues** - Your question might already be answered
2. **Check documentation** - Review guides and API reference
3. **Ask in Discord** - Get help from the community
4. **Create an issue** - For bugs or specific problems

### Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) and help us maintain a positive community.

### Recognition

Contributors are recognized in:

- Release notes
- Contributors file
- GitHub contributors graph
- Community Discord roles

---

## Development Tips

### Debugging

```typescript
// Enable debug logging
process.env.DEBUG = 'moro:*';

// Use debug module
import debug from 'debug';
const log = debug('moro:router');

log('Processing route: %s %s', method, path);
```

### Performance Testing

```bash
# Benchmark against other frameworks
npm run benchmark

# Profile memory usage
npm run profile:memory

# Profile CPU usage
npm run profile:cpu
```

### Working with Examples

```bash
# Run specific example
cd examples/simple-api
npm install
npm start

# Create new example
npm run create-example my-new-example
```

### Release Process

1. **Version Bump** - Update version in package.json
2. **Changelog** - Update CHANGELOG.md with changes
3. **Tag Release** - Create git tag with version
4. **Publish** - Publish to npm registry
5. **GitHub Release** - Create GitHub release with notes

---

Thank you for contributing to MoroJS! Your contributions help make the framework better for everyone. If you have any questions, don't hesitate to reach out to the community. 