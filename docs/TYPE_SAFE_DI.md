# Type-Safe Dependency Injection - Solution Guide

## Problem Solved

**Original Issue:** The DI container's `resolve()` method returned `unknown` type, requiring manual type annotations.

```typescript
// BEFORE (Not Type Safe)
container
  .register('authService')
  .factory(() => ({ signIn() {} }))
  .build();

const authService = await container.resolve('authService');
authService.signIn; // Error: authService is unknown

// Required workaround:
const authService = await container.resolve<AuthService>('authService');
```

## Solution

The container now returns a **typed service reference** from `.build()` that automatically captures and preserves type information.

```typescript
// AFTER (Automatically Type Safe)
const authServiceRef = container
  .register<AuthService>('authService')
  .factory(() => ({ signIn() {} }))
  .build();

const authService = await authServiceRef.resolve();
authService.signIn(); // ✓ Fully typed - no manual annotation needed!
```

## How It Works

### 1. Registration Returns Typed Reference

When you call `.build()`, you get back a `TypedServiceReference<T>` that holds the type information:

```typescript
const userServiceRef = container
  .register<UserService>('userService') // Specify type here once
  .factory(() => new UserServiceImpl())
  .singleton()
  .build(); // Returns TypedServiceReference<UserService>
```

### 2. Resolution Uses Captured Type

The typed reference knows the service type and provides it automatically:

```typescript
const userService = await userServiceRef.resolve();
// userService is UserService - no manual type needed!
```

### 3. Store References for Easy Access

The recommended pattern is to store all your typed references in one place:

```typescript
// services.ts
export const services = {
  user: container
    .register<UserService>('userService')
    .factory(() => new UserServiceImpl())
    .singleton()
    .build(),

  auth: container
    .register<AuthService>('authService')
    .factory(deps => new AuthServiceImpl(deps.userService))
    .dependsOn('userService')
    .singleton()
    .build(),
};

// routes.ts
import { services } from './services';

app.get('/users/:id', async (req, res) => {
  const userService = await services.user.resolve(); // ✓ Typed!
  const user = await userService.findById(req.params.id);
  res.json(user);
});
```

## Benefits

### ✅ No Manual Type Annotations

You specify the type once during registration, then it's automatic everywhere else.

### ✅ No Interface Extensions

You don't need to extend global interfaces or declare modules.

### ✅ Full IntelliSense

Your IDE provides autocomplete and type checking for all service methods.

### ✅ Compile-Time Safety

TypeScript catches errors at compile time, not runtime.

### ✅ Clean API

The pattern is simple and intuitive - register, store reference, resolve.

## Complete Example

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();
const container = app.getContainer().getEnhanced();

// Define service types
interface UserService {
  findById(id: string): Promise<User>;
  create(data: CreateUserDto): Promise<User>;
}

interface EmailService {
  send(to: string, subject: string, body: string): Promise<void>;
}

// Register services with type safety
const emailServiceRef = container
  .register<EmailService>('emailService')
  .factory(() => ({
    async send(to, subject, body) {
      console.log(`Sending email to ${to}`);
    },
  }))
  .singleton()
  .build();

const userServiceRef = container
  .register<UserService>('userService')
  .factory(deps => {
    const emailService = deps.emailService as EmailService;
    return {
      async findById(id) {
        return { id, name: 'John', email: 'john@example.com' };
      },
      async create(data) {
        const user = { id: '123', ...data };
        await emailService.send(user.email, 'Welcome!', 'Thanks for joining');
        return user;
      },
    };
  })
  .dependsOn('emailService')
  .singleton()
  .build();

// Use in routes with full type safety
app.post('/users', async (req, res) => {
  const userService = await userServiceRef.resolve();
  const user = await userService.create(req.body);
  res.json(user);
});

app.get('/users/:id', async (req, res) => {
  const userService = await userServiceRef.resolve();
  const user = await userService.findById(req.params.id);
  res.json(user);
});

await app.listen(3000);
```

## Migration Guide

If you were using the old pattern with manual type annotations:

```typescript
// OLD WAY
container.register('service', () => new Service(), true);
const service = await container.resolve<Service>('service');
```

Update to:

```typescript
// NEW WAY
const serviceRef = container
  .register<Service>('service')
  .factory(() => new Service())
  .singleton()
  .build();

const service = await serviceRef.resolve();
```

## API Reference

### TypedServiceReference<T>

Returned from `.build()` when registering a service.

**Methods:**

- `resolve(context?: ServiceContext): Promise<T>` - Resolve the service asynchronously
- `resolveSync(context?: ServiceContext): T` - Resolve the service synchronously
- `getName(): string` - Get the service name

### FunctionalContainer

**Type-Safe Methods:**

- `register<T>(name: string): ServiceRegistrationBuilder<T>` - Start fluent registration
- `singleton<T>(name: string, factory: ServiceFactory<T>): TypedServiceReference<T>` - Quick singleton registration
- `transient<T>(name: string, factory: ServiceFactory<T>): TypedServiceReference<T>` - Quick transient registration

### ServiceRegistrationBuilder<T>

**Methods:**

- `.factory(fn)` - Set factory function
- `.singleton()` / `.transient()` / `.requestScoped()` / `.moduleScoped()` - Set scope
- `.dependsOn(...deps)` - Add required dependencies
- `.optionalDependsOn(...deps)` - Add optional dependencies
- `.onInit(fn)` - Add initialization hook
- `.onDispose(fn)` - Add disposal hook
- `.tags(...tags)` - Add tags
- `.build()` - Build and return `TypedServiceReference<T>`

## See Also

- [Full Dependency Injection Guide](./DEPENDENCY_INJECTION.md)
- [Example: type-safe-di.ts](../examples/type-safe-di.ts)
- [Example: typescript-type-safety-demo.ts](../examples/typescript-type-safety-demo.ts)
