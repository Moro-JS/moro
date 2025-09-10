# Changelog

All notable changes to the MoroJS framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-09-10

### Added

#### 🎉 Configuration File Support
- **NEW: `moro.config.js` and `moro.config.ts` support** - Load configuration from dedicated config files for better developer experience
- **Automatic configuration discovery** - Place config files in project root for zero-setup configuration
- **Environment variable override** - Config files provide defaults while environment variables take precedence
- **TypeScript configuration support** - Full type safety and IDE autocompletion for config files
- **Backward compatibility** - Existing projects work unchanged without any migration needed

#### 🔧 Enhanced Module Configuration
- **NEW: `createModuleConfig()` function** - Create module-specific configuration with environment override support
- **Improved type coercion** - Automatic conversion of environment variable strings to appropriate types (numbers, booleans, JSON)
- **Better integration** - Module configs now properly merge with global application configuration
- **Environment prefix support** - Use prefixed environment variables for module-specific settings

#### 📚 Comprehensive Documentation
- **Complete configuration guide** - Updated API documentation with extensive configuration examples
- **Getting Started configuration section** - Step-by-step setup guide for new projects
- **Configuration examples document** - Real-world examples for development, staging, and production environments
- **TypeScript configuration examples** - Full typing and validation patterns
- **Best practices guide** - Security, performance, and maintainability recommendations

#### 🧪 Enhanced Testing
- **Comprehensive test coverage** - Full test suite for configuration file loading and module configuration
- **Integration tests** - End-to-end testing of configuration priority and merging
- **Test isolation improvements** - Better test cleanup and state management

### Changed

#### ⚡ Configuration Loading Priority
Configuration is now loaded in the following priority order:
1. **Environment Variables** (highest priority)
2. **Configuration File** (`moro.config.js` or `moro.config.ts`)
3. **Schema Defaults** (lowest priority)

#### 🔧 Internal Improvements
- **Synchronous configuration loading** - Improved startup performance and reliability
- **Better error handling** - Graceful fallback when config files have errors
- **Enhanced logging** - Detailed configuration loading information for debugging

### Technical Details

#### Configuration File Examples

**Basic Configuration:**
```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
    host: 'localhost',
    environment: 'development'
  },
  database: {
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    username: 'myapp',
    password: 'development-password',
    database: 'myapp_dev'
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000']
    }
  }
};
```

**TypeScript Configuration:**
```typescript
// moro.config.ts
import type { AppConfig } from 'moro';

const config: Partial<AppConfig> = {
  server: {
    port: 3000,
    environment: 'development'
  },
  // ... other configuration
};

export default config;
```

**Module Configuration:**
```typescript
import { createModuleConfig, z } from 'moro';

const emailConfig = createModuleConfig(
  z.object({
    apiKey: z.string(),
    timeout: z.number().default(5000)
  }),
  { timeout: 3000 },
  'EMAIL_' // Environment prefix
);
```

### Migration Guide

**No migration required!** This release is fully backward compatible. Existing projects will continue to work exactly as before.

**Optional upgrade path:**
1. Create a `moro.config.js` file in your project root
2. Move your environment-based configuration to the config file
3. Keep sensitive data (passwords, API keys) in environment variables
4. Enjoy improved developer experience with IDE autocompletion

### Breaking Changes

**None** - This release maintains full backward compatibility.

---

## [1.0.3] - Previous Release

### Features
- Core framework functionality
- Intelligent routing system
- Automatic middleware ordering
- Type-safe validation with Zod
- Multi-runtime support (Node.js, Edge, Lambda, Workers)
- WebSocket support
- Database integration
- Performance optimizations
- Comprehensive testing framework

---

## Support

- **Documentation**: [docs/](./docs/)
- **Examples**: [GitHub Examples Repository](https://github.com/Moro-JS/examples)
- **Issues**: [GitHub Issues](https://github.com/Moro-JS/moro/issues)
- **Community**: [Discord Community](https://morojs.com/discord)
