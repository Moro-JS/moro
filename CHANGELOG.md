# Changelog

All notable changes to the MoroJS framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2025-09-11

### Fixed

#### Configuration System
- **CRITICAL: Fixed logger configuration from config files not being applied** - Configuration file logging settings (like `logging.level: 'warn'`) now properly override the global logger
- **Fixed child logger level inheritance** - Framework loggers created with `createFrameworkLogger()` now correctly inherit level changes from the parent logger
- **Fixed configuration timing issue** - Logger configuration from config files is now applied after the configuration system initializes, ensuring proper precedence
- **Improved configuration application flow** - Added proper sequencing: Environment variables → Config file → createApp options (with correct precedence)

#### Logger System
- **Enhanced child logger architecture** - Child loggers now maintain a reference to their parent for proper level inheritance
- **Fixed log level checking** - Child loggers now respect the parent logger's level when filtering log messages
- **Improved configuration validation** - Better error handling and validation for invalid log levels and configuration options

### Technical Details
- Fixed initialization sequence in `Moro` constructor to apply config file logging settings after config loading
- Enhanced `MoroLogger.child()` method to maintain parent reference for level inheritance
- Updated log level checking logic to use parent level for child loggers
- Maintained backward compatibility with existing logger API

### Migration Notes
- **No breaking changes** - This is a pure bug fix release
- Existing applications using config files for logging will now work as expected
- No code changes required for existing applications

---

## [1.2.0] - 2025-09-11

### Added

#### Enterprise Authentication System
- **NEW: Complete Auth.js integration** - Full-featured authentication middleware with OAuth, JWT, and session support
- **Multiple OAuth providers** - GitHub, Google, Discord, Microsoft, LinkedIn with easy configuration
- **Enterprise SSO providers** - Okta, Auth0, AWS Cognito for enterprise deployment
- **Role-Based Access Control (RBAC)** - Fine-grained permissions and role-based route protection
- **Native Auth.js adapter** - Custom `@auth/morojs` adapter with zero external dependencies, ready for Auth.js contribution

#### Authentication Middleware and Helpers
- **NEW: `auth()` middleware** - Complete Auth.js middleware with provider configuration and security features
- **NEW: `requireAuth()` middleware** - Route protection with role and permission-based access control
- **NEW: `requireRole()` and `requireAdmin()` helpers** - Simplified role-based route protection
- **NEW: `authUtils` utilities** - Manual authentication checks, user data access, and session management
- **NEW: `authResponses` helpers** - Standardized authentication response patterns
- **NEW: Extended provider factories** - `extendedProviders` and `enterpriseProviders` with advanced configurations

#### Security and Production Features
- **Session management** - JWT and database session strategies with configurable security settings
- **CSRF protection** - Built-in Cross-Site Request Forgery protection
- **Security audit logging** - Track authentication events for compliance and monitoring
- **Custom callbacks and events** - Extensible authentication flow with business logic integration
- **Production security** - Secure cookies, host trust, and environment-based configuration

#### Native Auth.js Adapter Architecture
- **Request/response transformers** - Seamless conversion between MoroJS and Auth.js Web API formats
- **Hooks system integration** - Native integration with MoroJS middleware and hooks architecture
- **Zero dependency design** - No reliance on Express or other framework adapters
- **Performance optimized** - Built specifically for MoroJS request/response patterns

### Enhanced

#### Middleware System
- **Improved MiddlewareManager** - Better middleware installation and execution with hooks integration
- **Enhanced HookManager** - Proper integration with HTTP request pipeline for reliable middleware execution
- **Response enhancement** - Robust error handling with defensive fallbacks for HTTP response methods

#### Documentation
- **NEW: Authentication Guide** - Complete guide covering Auth.js integration, RBAC, and security best practices
- **NEW: Native Auth Adapter documentation** - Comprehensive guide for the custom Auth.js adapter
- **Enhanced README** - Added authentication as a core feature with examples and benefits
- **Updated API documentation** - Complete authentication middleware and helper function documentation

#### Examples and Testing
- **Working authentication examples** - Multiple complete examples demonstrating different authentication patterns
- **Advanced enterprise example** - RBAC, audit logging, and multi-provider authentication patterns
- **Native adapter example** - Custom adapter usage with Auth.js callbacks and events
- **Comprehensive test coverage** - 200+ tests covering authentication middleware and integration patterns

### Fixed

#### HTTP Response Handling
- **Resolved "res.status is not a function" errors** - Enhanced error handling with proper response object validation
- **Improved response enhancement** - Defensive programming for HTTP response method availability
- **Better error recovery** - Graceful fallbacks when response objects are not fully enhanced

#### Middleware Integration
- **Fixed middleware installation** - Proper detection and installation of MiddlewareInterface objects
- **Resolved hooks execution** - Correct integration of HookManager with HTTP request pipeline
- **Session dependency resolution** - Auth middleware now self-contained without external session dependencies

### Technical Details

#### Architecture Improvements
- **Native Auth.js integration** - Direct Auth.js core integration without Express dependencies
- **Middleware composition** - Helper functions for proper middleware chaining in route handlers
- **Type safety enhancements** - Full TypeScript support for authentication types and middleware
- **Production error handling** - Robust error handling patterns for enterprise deployment

#### Performance Optimizations
- **Efficient request processing** - Optimized auth object injection and session management
- **Memory usage optimization** - Reduced overhead for authentication operations
- **Error handling performance** - Fast-path error responses with minimal overhead

## [1.1.0] - 2025-09-10

### Added

#### Configuration File Support
- **NEW: `moro.config.js` and `moro.config.ts` support** - Load configuration from dedicated config files for better developer experience
- **Automatic configuration discovery** - Place config files in project root for zero-setup configuration
- **Environment variable override** - Config files provide defaults while environment variables take precedence
- **TypeScript configuration support** - Full type safety and IDE autocompletion for config files
- **Backward compatibility** - Existing projects work unchanged without any migration needed

#### Enhanced Module Configuration
- **NEW: `createModuleConfig()` function** - Create module-specific configuration with environment override support
- **Improved type coercion** - Automatic conversion of environment variable strings to appropriate types (numbers, booleans, JSON)
- **Better integration** - Module configs now properly merge with global application configuration
- **Environment prefix support** - Use prefixed environment variables for module-specific settings

#### Comprehensive Documentation
- **Complete configuration guide** - Updated API documentation with extensive configuration examples
- **Getting Started configuration section** - Step-by-step setup guide for new projects
- **Configuration examples document** - Real-world examples for development, staging, and production environments
- **TypeScript configuration examples** - Full typing and validation patterns
- **Best practices guide** - Security, performance, and maintainability recommendations

#### Enhanced Testing
- **Comprehensive test coverage** - Full test suite for configuration file loading and module configuration
- **Integration tests** - End-to-end testing of configuration priority and merging
- **Test isolation improvements** - Better test cleanup and state management

### Changed

#### Configuration Loading Priority
Configuration is now loaded in the following priority order:
1. **Environment Variables** (highest priority)
2. **Configuration File** (`moro.config.js` or `moro.config.ts`)
3. **Schema Defaults** (lowest priority)

#### Internal Improvements
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
