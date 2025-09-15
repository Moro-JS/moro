# Universal Validation Support in Moro Framework

Moro Framework now supports **any validation library** through a universal `ValidationSchema` interface. **No breaking changes** to existing code!

## Zero Breaking Changes!

Your existing Zod code works exactly the same:

```typescript
import { Moro, z } from '@morojs/moro';

const app = new Moro();

// ✅ This still works exactly as before!
const UserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  age: z.number().min(18).optional()
});

app.post('/users')
  .body(UserSchema)
  .handler((req, res) => {
    // req.body is fully typed as z.infer<typeof UserSchema>
    const user = req.body;
    return { success: true, user };
  });
```

## Multiple Validation Libraries

### 1. Zod (Default - Works as-is)

```typescript
import { z } from 'zod';

const ZodSchema = z.object({
  name: z.string(),
  age: z.number()
});

app.post('/zod-validation')
  .body(ZodSchema)  // ✅ Works directly!
  .handler((req, res) => {
    // Fully typed!
    return { user: req.body };
  });
```

### 2. Joi (Via Adapter)

```typescript
import Joi from 'joi';
import { joi } from '@morojs/moro';

const JoiSchema = Joi.object({
  name: Joi.string().required(),
  age: Joi.number().min(18)
});

app.post('/joi-validation')
  .body(joi(JoiSchema))  // ✅ Wrapped with adapter
  .handler((req, res) => {
    return { user: req.body };
  });
```

### 3. Yup (Via Adapter)

```typescript
import * as yup from 'yup';
import { yup as yupAdapter } from '@morojs/moro';

const YupSchema = yup.object({
  name: yup.string().required(),
  age: yup.number().min(18)
});

app.post('/yup-validation')
  .body(yupAdapter(YupSchema))  // ✅ Wrapped with adapter
  .handler((req, res) => {
    return { user: req.body };
  });
```

### 4. Custom Functions

```typescript
import { customValidator } from '@morojs/moro';

const validateUser = customValidator(async (data: any) => {
  if (!data.name || typeof data.name !== 'string') {
    throw new Error('Name is required and must be a string');
  }
  if (data.age && (typeof data.age !== 'number' || data.age < 18)) {
    throw new Error('Age must be a number and at least 18');
  }
  return {
    name: data.name,
    age: data.age || null
  };
}, 'user-validator');

app.post('/custom-validation')
  .body(validateUser)
  .handler((req, res) => {
    return { user: req.body };
  });
```

### 5. Class Validator (TypeScript Decorators)

```typescript
import { IsString, IsNumber, Min, IsOptional } from 'class-validator';
import { classValidator } from '@morojs/moro';

class User {
  @IsString()
  name!: string;

  @IsNumber()
  @Min(18)
  @IsOptional()
  age?: number;
}

app.post('/class-validation')
  .body(classValidator(User))
  .handler((req, res) => {
    return { user: req.body };
  });
```

## Mixed Validation in Same App

You can use different validation libraries for different routes:

```typescript
import { Moro, z, joi, yup, customValidator } from '@morojs/moro';
import Joi from 'joi';
import * as yupLib from 'yup';

const app = new Moro();

// Zod for user creation
app.post('/users')
  .body(z.object({ name: z.string(), email: z.string().email() }))
  .handler(createUser);

// Joi for product validation
app.post('/products')
  .body(joi(Joi.object({ title: Joi.string(), price: Joi.number() })))
  .handler(createProduct);

// Yup for order validation
app.post('/orders')
  .body(yup(yupLib.object({ productId: yupLib.string(), quantity: yupLib.number() })))
  .handler(createOrder);

// Custom function for webhooks
app.post('/webhooks')
  .body(customValidator(validateWebhook))
  .handler(handleWebhook);
```

## Installation & Dependencies

### Core Framework (No validation dependencies)
```bash
npm install @morojs/moro
```

### Choose Your Validation Library

**Option 1: Zod (Recommended)**
```bash
npm install zod
```

**Option 2: Joi**
```bash
npm install joi
npm install --save-dev @types/joi  # For TypeScript
```

**Option 3: Yup**
```bash
npm install yup
```

**Option 4: Class Validator**
```bash
npm install class-validator class-transformer
```

**Option 5: Use All of Them!**
```bash
npm install zod joi yup class-validator class-transformer
```

## Framework Benefits

### ✅ Zero Breaking Changes
- Existing Zod code works unchanged
- No API modifications needed
- Same TypeScript inference

### ✅ Choose Your Tool
- Use what your team knows
- Different libraries for different needs
- No vendor lock-in

### ✅ Lightweight Core
- Framework doesn't include validation libraries
- Users only install what they need
- Smaller bundle sizes

### ✅ Universal Interface
- All validation libraries work the same way
- Consistent error handling
- Same developer experience

## How It Works

The framework uses a minimal `ValidationSchema` interface:

```typescript
interface ValidationSchema<T = any> {
  parseAsync(data: unknown): Promise<T>;
}
```

**Zod naturally implements this interface** - no changes needed!

Other libraries are wrapped with lightweight adapters that convert their APIs to this interface.

## Migration Guide

### If You're Already Using Zod
**No changes needed!** Your code continues to work exactly as before.

### If You Want to Switch Libraries
```typescript
// Before (Zod)
.body(z.object({ name: z.string() }))

// After (Joi)
.body(joi(Joi.object({ name: Joi.string() })))

// After (Yup)
.body(yup(yup.object({ name: yup.string() })))

// After (Custom)
.body(customValidator(myValidationFunction))
```

## Error Handling

All validation libraries produce consistent error responses:

```json
{
  "success": false,
  "error": "Validation failed for body",
  "details": [
    {
      "field": "email",
      "message": "Invalid email format",
      "code": "invalid_email"
    }
  ],
  "requestId": "req_123"
}
```

This gives you **complete flexibility** while maintaining the excellent developer experience!
