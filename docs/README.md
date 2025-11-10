# MoroJS Documentation

Complete documentation for the MoroJS framework (v1.5.3).

**Note:** MoroJS has zero core dependencies! All validation libraries (Zod, Joi, Yup, Class Validator) are optional peer dependencies, making the framework lightweight and flexible.

## Documentation Structure

### Getting Started
- **[Getting Started](./GETTING_STARTED.md)** - Complete setup guide and first application
- **[API Reference](./API.md)** - Comprehensive framework API documentation
- **[Migration Guide](./MIGRATION.md)** - Migrate from Express, Fastify, NestJS, and Koa

### Core Features
- **[Authentication Guide](./AUTH_GUIDE.md)** - Complete Auth.js integration with RBAC and security
- **[Native Auth Adapter](./NATIVE_AUTH_ADAPTER.md)** - Custom `@auth/morojs` adapter for contribution to Auth.js
- **[Runtime System](./RUNTIME.md)** - Multi-runtime deployment guide (Node.js, Edge, Lambda, Workers)
- **[Performance Guide](./PERFORMANCE.md)** - Optimization, benchmarks, and monitoring
- **[Testing Guide](./TESTING_GUIDE.md)** - Testing strategies and best practices

### Features & Middleware
- **[Middleware Guide](./MIDDLEWARE_GUIDE.md)** - Complete reference for all 18+ built-in middleware
- **[HTTP/2 Guide](./HTTP2_GUIDE.md)** - HTTP/2 server push, stream prioritization, and multiplexing
- **[Worker Threads Guide](./WORKERS_GUIDE.md)** - CPU-intensive task offloading with worker threads
- **[Message Queue Guide](./QUEUE_GUIDE.md)** - Production-ready queue system with multiple adapters
- **[gRPC Guide](./GRPC_GUIDE.md)** - High-performance microservices with gRPC
- **[GraphQL Guide](./GRAPHQL_GUIDE.md)** - GraphQL API integration
- **[Jobs Guide](./JOBS_GUIDE.md)** - Background job scheduling and execution

### Development
- **[Contributing](./CONTRIBUTING.md)** - How to contribute to MoroJS
- **[Testing & Documentation Summary](./TESTING_AND_DOCS_SUMMARY.md)** - Overview of testing approach

## Quick Navigation

### For New Users
1. Start with the **[Main README](../README.md)** for an overview
2. Follow the **[Getting Started](./GETTING_STARTED.md)** guide
3. Check out the **[Examples Repository](https://github.com/Moro-JS/examples)**

### For Developers
1. Read the **[API Reference](./API.md)** for complete technical details
2. Review **[Performance Guide](./PERFORMANCE.md)** for optimization tips
3. Study **[Runtime System](./RUNTIME.md)** for multi-environment deployment

### For Contributors
1. Follow the **[Contributing Guide](./CONTRIBUTING.md)**
2. Review the **[Testing Guide](./TESTING_GUIDE.md)**
3. Check the **[Testing Summary](./TESTING_AND_DOCS_SUMMARY.md)**

### For Migration
1. **[Migration Guide](./MIGRATION.md)** - Complete migration instructions from other frameworks
2. **[Performance Comparison](./PERFORMANCE.md#benchmarks)** - See performance improvements

## What's Covered

### Framework Features
- ✅ **Intelligent Routing** - Automatic middleware ordering
- ✅ **Multi-Runtime Support** - Deploy everywhere with same code
- ✅ **Type Safety** - Full TypeScript integration with optional validation libraries
- ✅ **Performance** - Optimized for speed and memory efficiency
- ✅ **Functional Architecture** - Clean, testable code patterns

### Deployment Targets
- ✅ **Node.js** - Traditional servers and microservices
- ✅ **Vercel Edge** - Global edge functions
- ✅ **AWS Lambda** - Serverless compute
- ✅ **Cloudflare Workers** - Edge computing platform

### Advanced Topics
- ✅ **Module System** - Functional module architecture
- ✅ **Validation** - Zod schema validation with type inference
- ✅ **Authentication** - Auth.js integration with RBAC and native adapter
- ✅ **Caching** - Memory, Redis, and edge caching strategies
- ✅ **Rate Limiting** - Built-in protection against abuse
- ✅ **Circuit Breakers** - Automatic failure protection
- ✅ **WebSockets** - Real-time communication support
- ✅ **Database Integration** - Multiple database adapters
- ✅ **Events** - Enterprise-grade event system
- ✅ **Worker Threads** - CPU-intensive task offloading to separate threads
- ✅ **Message Queues** - Production-ready queue system (Memory, Bull, RabbitMQ, SQS, Kafka)
- ✅ **gRPC** - Native gRPC support for microservices
- ✅ **HTTP/2** - Server push, stream prioritization, and multiplexing
- ✅ **Middleware** - 18+ built-in middleware for security, performance, and features

## External Resources

- **[Examples Repository](https://github.com/Moro-JS/examples)** - Real-world usage examples
- **[npm Package](https://www.npmjs.com/package/moro)** - Official npm package
- **[GitHub Repository](https://github.com/Moro-JS/moro)** - Source code and issues
- **[Discord Community](https://morojs.com/discord)** - Get help and discuss

## Documentation Categories

### By Audience

**Beginners:**
- [Main README](../README.md) - Overview and quick start
- [Getting Started](./GETTING_STARTED.md) - Detailed setup guide
- [Examples](https://github.com/Moro-JS/examples) - Working examples

**Developers:**
- [API Reference](./API.md) - Complete technical reference
- [Middleware Guide](./MIDDLEWARE_GUIDE.md) - All built-in middleware reference
- [Authentication Guide](./AUTH_GUIDE.md) - Auth.js integration and security
- [Message Queue Guide](./QUEUE_GUIDE.md) - Queue system with multiple adapters
- [gRPC Guide](./GRPC_GUIDE.md) - Microservices with gRPC
- [Worker Threads Guide](./WORKERS_GUIDE.md) - CPU-intensive task offloading
- [HTTP/2 Guide](./HTTP2_GUIDE.md) - HTTP/2 features and optimization
- [Performance Guide](./PERFORMANCE.md) - Optimization strategies
- [Testing Guide](./TESTING_GUIDE.md) - Testing best practices

**DevOps/Infrastructure:**
- [Runtime System](./RUNTIME.md) - Deployment to different environments
- [Performance Benchmarks](./PERFORMANCE.md#benchmarks) - Performance data
- [Migration Guide](./MIGRATION.md) - Framework migration

**Contributors:**
- [Contributing Guide](./CONTRIBUTING.md) - Development setup and guidelines
- [Testing Summary](./TESTING_AND_DOCS_SUMMARY.md) - Testing approach

### By Topic

**Core Framework:**
- Intelligent routing system
- Multi-runtime architecture
- Validation with Zod
- Middleware system
- Error handling

**Advanced Features:**
- Module system
- Event-driven architecture
- Caching strategies
- Rate limiting
- Circuit breakers
- WebSocket support

**Performance:**
- Benchmarks vs other frameworks
- Optimization techniques
- Monitoring and debugging
- Memory management
- Runtime-specific optimizations

**Deployment:**
- Node.js servers
- Serverless functions
- Edge computing
- Container deployment
- CI/CD pipelines

## 🆘 Getting Help

### Documentation Issues
- **Missing Information?** - [Create an issue](https://github.com/Moro-JS/moro/issues/new) with the "documentation" label
- **Outdated Content?** - [Submit a pull request](https://github.com/Moro-JS/moro/pulls) with updates
- **Need Clarification?** - [Start a discussion](https://github.com/Moro-JS/moro/discussions) or ask in Discord

### Technical Support
1. **Check Documentation** - Search through guides and API reference
2. **Browse Examples** - Look at the examples repository for similar use cases
3. **Search Issues** - Check if your question has been asked before
4. **Community Help** - Ask in Discord for real-time support
5. **Create Issue** - For bugs or specific technical problems

## Contributing to Documentation

We welcome documentation improvements! See our [Contributing Guide](./CONTRIBUTING.md) for details on:

- Writing style guidelines
- Documentation structure
- Review process
- Examples and code samples

### Quick Contribution Steps
1. Fork the repository
2. Edit documentation files
3. Test examples work correctly
4. Submit a pull request

---

**Need something specific?** Check the navigation above or use the search functionality in GitHub to find what you're looking for.
