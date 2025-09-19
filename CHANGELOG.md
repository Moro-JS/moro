## [1.5.6] - 2025-09-19

### Added
- feat: major configuration system refactor

## [1.5.5] - 2025-09-18

### Fixed
- fix: resolve logger color inconsistency and enhance cluster algorithm
- fix: make changelog generation dynamic based on actual commits

## [1.5.4] - 2025-09-18

### Added
- Major logger performance optimizations
- Object pooling for LogEntry objects
- Aggressive level checking with numeric comparisons
- String builder pattern for efficient concatenation
- Buffered output with micro-batching (1ms intervals)
- Fast path optimization for different complexity levels
- Improved timestamp caching (100ms vs 1000ms)
- Static pre-allocated strings for levels and ANSI codes
- Comprehensive pre-release script for GitHub workflow
- Named loggers for better context (MODULE_*, SERVICE_*, etc.)

### Changed
- Replaced all console.log statements with proper logger usage
- Fixed Jest open handle issues with proper cleanup
- Performance improvements: 55% faster simple logs, 107% faster complex logs

### Fixed
- Jest open handle issues preventing clean test exits
- Logger performance bottlenecks
- Inconsistent logging across the codebase


# Changelog

All notable changes to the MoroJS framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [1.5.3] - 2025-09-17

### Added
- Major logger performance optimizations
- Object pooling for LogEntry objects
- Aggressive level checking with numeric comparisons
- String builder pattern for efficient concatenation
- Buffered output with micro-batching (1ms intervals)
- Fast path optimization for different complexity levels
- Improved timestamp caching (100ms vs 1000ms)
- Static pre-allocated strings for levels and ANSI codes
- Comprehensive pre-release script for GitHub workflow
- Named loggers for better context (MODULE_*, SERVICE_*, etc.)

### Changed
- Replaced all console.log statements with proper logger usage
- Performance improvements: 55% faster simple logs, 107% faster complex logs

### Fixed
- Jest open handle issues preventing clean test exits
- Logger performance bottlenecks
- Inconsistent logging across the codebase

## [1.5.2] - 2025-09-16

### Fixed
- **CRITICAL: Fixed clustering configuration isolation issue** - Resolved shared configuration object problem where all app instances were modifying the same global config
- Each app instance now gets its own deep copy of the configuration
- Clustering configuration now works correctly with both createApp options and moro.config.js
- Environment variables (CLUSTERING_ENABLED, CLUSTER_WORKERS) work as expected
- Configuration precedence: createApp options > moro.config.js > environment variables > defaults

### Technical Details
- Fixed configuration isolation in `Moro` constructor and config loader
- Enhanced configuration merging to prevent shared object mutations
- Maintained backward compatibility with existing clustering configurations

## [1.5.1] - 2025-09-16

### Added
- **Memory leak fixes and ES2022 optimizations** - Fixed memory leak in HTTP server object pooling
- Upgraded TypeScript target to ES2022 for better performance
- Optimized garbage collection with modern JavaScript features
- Added Object.hasOwn() for safer property checks
- Used optional chaining for cleaner GC calls
- Improved buffer acquisition with findIndex()

### Performance Improvements
- Consistent performance across benchmark runs
- Better memory management with modern JavaScript features
- Optimized object pooling system

### Quality Assurance
- All 233 tests passing
- ESLint clean (0 errors)
- Prettier formatted
- Production ready


## [1.5.0] - 2025-01-16

### Added

#### Universal Validation System
- **NEW: Zero-dependency core framework** - Core framework now has zero dependencies
- **NEW: Universal validation interface** - Single ValidationSchema interface supporting multiple validation libraries
- **NEW: Optional peer dependencies** - All validation libraries (Zod, Joi, Yup, class-validator) are now optional
- **NEW: Dynamic validation loading** - Validation libraries loaded only when available
- **NEW: Universal error handling** - Consistent validation error format across all libraries
- **NEW: TypeScript-based configuration** - Pure TypeScript interfaces replace Zod schemas in core config

#### Enhanced Developer Experience
- **NEW: Complete validation library choice** - Users can choose any validation library or none at all
- **NEW: Backward compatibility** - All existing code works unchanged
- **NEW: Smaller bundle size** - Reduced framework size with optional dependencies
- **NEW: Faster startup** - Improved performance with zero core dependencies

### Changed

#### Configuration System
- **CHANGED: Core configuration** - Replaced Zod schemas with TypeScript interfaces
- **CHANGED: Environment variable handling** - Enhanced type coercion and validation
- **CHANGED: Validation middleware** - Updated to use universal ValidationSchema interface
- **CHANGED: WebSocket validation** - Universal validation across HTTP and WebSocket

#### Project Structure
- **CHANGED: Type organization** - Moved configuration types to proper types directory
- **CHANGED: Dependency management** - All validation libraries moved to peerDependencies

### Technical Improvements
- **IMPROVED: Bundle optimization** - Smaller production bundles
- **IMPROVED: Memory usage** - Reduced memory footprint
- **IMPROVED: Type safety** - Enhanced TypeScript integration
- **IMPROVED: Error handling** - Universal error normalization

### Breaking Changes
- **NONE** - This release maintains 100% backward compatibility

## [1.4.0] - 2024-12-15

### Added

#### Comprehensive Validation System
- **NEW: Multi-library validation adapter system** - Support for Zod, Joi, Yup, and class-validator with unified interface
- **NEW: Schema interface standardization** - Common validation interface across all supported validation libraries
- **NEW: Advanced validation adapters** - Custom validation function support with seamless integration
- **NEW: TypeScript validation configuration** - Enhanced TypeScript config loading and validation
- **NEW: Validation error normalization** - Consistent error handling across different validation libraries

#### WebSocket Adapter System
- **NEW: Socket.IO adapter** - Full Socket.IO integration with room management and event handling
- **NEW: Native WebSocket adapter** - High-performance native WebSocket support with connection pooling
- **NEW: WebSocket adapter interface** - Standardized interface for different WebSocket implementations
- **NEW: Connection management** - Advanced connection lifecycle management with cleanup and monitoring

#### Configuration System Enhancements
- **NEW: TypeScript configuration loader** - Advanced TypeScript config file loading with validation
- **NEW: Configuration file validation** - Schema-based validation for configuration files
- **NEW: Enhanced configuration types** - Better TypeScript support for configuration options

#### Documentation and OpenAPI
- **NEW: Schema-to-OpenAPI conversion** - Automatic OpenAPI schema generation from validation schemas
- **NEW: Enhanced OpenAPI generator** - Improved OpenAPI documentation generation with better schema support
- **NEW: Zod-to-OpenAPI enhancement** - Better Zod schema conversion to OpenAPI specifications

### Enhanced
- **Improved validation system architecture** - Better performance and extensibility
- **Enhanced WebSocket management** - More robust connection handling and error recovery
- **Better configuration merging** - Improved configuration precedence and validation
- **Enhanced test coverage** - New comprehensive tests for validation adapters and WebSocket functionality

### Fixed
- **Configuration loading edge cases** - Better error handling for malformed configuration files
- **WebSocket connection cleanup** - Proper resource cleanup on connection termination
- **Validation error handling** - More consistent error messages across validation libraries

## [1.3.0] - 2024-09-15

### Added

#### High-Performance HTTP Server
- **NEW: Enterprise-grade performance optimizations** - Object pooling, string interning, and buffer management for ultra-fast request handling
- **NEW: Advanced buffer pooling system** - Zero-allocation response handling with pre-allocated buffer pools
- **NEW: Request handler optimization** - Middleware execution caching and minimal object creation overhead
- **NEW: String interning for HTTP methods and headers** - Massive memory savings through common value caching
- **NEW: Pre-compiled response templates** - Ultra-fast error responses with zero-allocation buffers

#### Configuration and Performance System
- **NEW: Performance configuration API** - Fine-grained control over clustering, compression, and circuit breaker settings
- **NEW: HTTP server performance tuning** - Configurable keep-alive timeouts, headers timeout, and request timeout settings
- **NEW: Runtime-aware optimizations** - Performance settings that adapt based on the detected runtime environment
- **NEW: Minimal mode support** - Ultra-lightweight server mode for edge deployments with compression disabled

#### Enhanced Framework Architecture
- **NEW: Improved MoroCore initialization** - Better configuration passing and runtime-specific optimizations
- **NEW: Enhanced middleware system integration** - Improved hook manager integration with HTTP server performance
- **NEW: Event bus performance improvements** - Optimized enterprise event bus with better memory management
- **NEW: Container and dependency injection enhancements** - Faster service resolution and improved memory efficiency

#### Developer Experience Improvements
- **NEW: Flexible listen() method overloads** - Support for `listen()`, `listen(callback)`, `listen(port, callback)`, and `listen(port, host, callback)`
- **NEW: Enhanced logging configuration** - Better framework logger configuration from config files and options
- **NEW: Improved error handling** - More robust error responses with pre-compiled templates
- **NEW: Configuration reference documentation** - Comprehensive configuration guide for all performance settings

### Enhanced

#### Performance Optimizations
- **Improved HTTP server throughput** - Up to 50% performance improvement in high-load scenarios
- **Enhanced memory management** - Reduced garbage collection pressure through object pooling and buffer reuse
- **Optimized middleware execution** - Faster middleware chain processing with execution caching
- **Better request parsing** - Optimized parameter object creation and reuse

#### Configuration System
- **Enhanced performance configuration merging** - Better precedence handling for performance settings from config files and options
- **Improved configuration validation** - Better error handling for invalid performance configuration values
- **Enhanced documentation integration** - Performance settings now properly documented in configuration reference

#### Runtime Compatibility
- **Better edge runtime support** - Optimized performance settings for edge deployments
- **Enhanced Node.js optimizations** - Full performance feature set for Node.js runtime
- **Improved multi-runtime handling** - Runtime-specific performance optimizations

### Fixed

#### HTTP Server Issues
- **Fixed buffer pool memory leaks** - Proper buffer return and pool size management
- **Resolved middleware execution overhead** - Eliminated function creation in request handling loops
- **Fixed response template caching** - Proper pre-compiled response buffer management

#### Configuration Issues
- **Fixed performance configuration precedence** - Config file settings now properly merge with createApp options
- **Resolved logging configuration timing** - Framework logger configuration now applies correctly during initialization
- **Fixed configuration validation edge cases** - Better handling of invalid or missing performance configuration

### Technical Details

#### Performance Architecture
- **Buffer pooling system** - Pre-allocated buffers for common response sizes (64B to 16KB)
- **String interning optimization** - Common HTTP methods and headers cached for memory efficiency
- **Middleware execution caching** - Function-level caching to avoid repeated middleware compilation
- **Object pool management** - Reusable parameter objects and request state management

#### Configuration Enhancements
- **Performance configuration schema** - Full typing and validation for all performance settings
- **Runtime-aware defaults** - Different default performance settings based on detected runtime
- **Configuration precedence system** - Environment variables → Config file → createApp options

#### Backward Compatibility
- **No breaking changes** - All existing applications continue to work without modification
- **Optional performance features** - Performance optimizations are enabled by default but can be disabled
- **Graceful degradation** - Framework falls back to standard performance when optimizations are unavailable

### Migration Notes

**Automatic Performance Improvements** - No code changes required. Your existing applications will automatically benefit from the performance improvements.

**Optional Performance Tuning** - You can now fine-tune performance settings:

```javascript
// moro.config.js
module.exports = {
  performance: {
    clustering: {
      enabled: true,
      workers: 'auto'
    },
    compression: {
      enabled: true,
      threshold: 1024
    },
    circuitBreaker: {
      enabled: true,
      timeout: 5000
    }
  }
};
```

**Enhanced listen() Method** - New flexible overloads:

```javascript
// All these are now supported
app.listen(() => console.log('Started on configured port'));
app.listen(3000, () => console.log('Started on port 3000'));
app.listen(3000, 'localhost', () => console.log('Started on localhost:3000'));
```

---

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
import type { AppConfig } from '@morojs/moro';

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
import { createModuleConfig, z } from '@morojs/moro';

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
