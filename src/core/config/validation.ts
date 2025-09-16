// Configuration Validation Functions
// Validation for config system with simple TypeScript functions

export class ConfigValidationError extends Error {
  constructor(
    public field: string,
    public value: unknown,
    message: string
  ) {
    super(`Configuration validation failed for '${field}': ${message}`);
    this.name = 'ConfigValidationError';
  }
}

// Type-safe validation functions for configuration
export function validatePort(value: unknown, field = 'port'): number {
  const num = Number(value);
  if (isNaN(num) || num < 1 || num > 65535) {
    throw new ConfigValidationError(field, value, 'Must be a number between 1 and 65535');
  }
  return num;
}

export function validateBoolean(value: unknown, field = 'boolean'): boolean {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  if (value === '1' || value === 1) return true;
  if (value === '0' || value === 0) return false;
  throw new ConfigValidationError(field, value, 'Must be a boolean (true/false) or numeric (1/0)');
}

export function validateNumber(
  value: unknown,
  field = 'number',
  options: { min?: number; max?: number } = {}
): number {
  const num = Number(value);
  if (isNaN(num)) {
    throw new ConfigValidationError(field, value, 'Must be a valid number');
  }
  if (options.min !== undefined && num < options.min) {
    throw new ConfigValidationError(field, value, `Must be at least ${options.min}`);
  }
  if (options.max !== undefined && num > options.max) {
    throw new ConfigValidationError(field, value, `Must be at most ${options.max}`);
  }
  return num;
}

export function validateString(value: unknown, field = 'string'): string {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(field, value, 'Must be a string');
  }
  return value;
}

export function validateUrl(value: unknown, field = 'url'): string {
  const str = validateString(value, field);
  try {
    new URL(str);
    return str;
  } catch {
    throw new ConfigValidationError(field, value, 'Must be a valid URL');
  }
}

export function validateEnum<T extends string>(
  value: unknown,
  validValues: readonly T[],
  field = 'enum'
): T {
  const str = validateString(value, field);
  if (!validValues.includes(str as T)) {
    throw new ConfigValidationError(field, value, `Must be one of: ${validValues.join(', ')}`);
  }
  return str as T;
}

export function validateStringArray(value: unknown, field = 'string array'): string[] {
  if (!Array.isArray(value)) {
    // Try to parse comma-separated string
    if (typeof value === 'string') {
      return value
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    }
    throw new ConfigValidationError(field, value, 'Must be an array or comma-separated string');
  }
  return value.map((item, index) => validateString(item, `${field}[${index}]`));
}

export function validateOptional<T>(
  value: unknown,
  validator: (value: unknown, field: string) => T,
  field: string
): T | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return validator(value, field);
}

// Coercion helpers for environment variables
export function coerceEnvValue(value: string): unknown {
  // Handle common patterns in environment variables

  // Null/undefined
  if (value === '' || value === 'null' || value === 'undefined') {
    return undefined;
  }

  // Boolean
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }

  // Number (but not if it starts with 0 - could be port, zip code, etc.)
  if (/^-?\d+(\.\d+)?$/.test(value) && !value.startsWith('0')) {
    const num = Number(value);
    if (!isNaN(num)) {
      return num;
    }
  }

  // JSON (for complex objects/arrays)
  if (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      // Not valid JSON, treat as string
    }
  }

  // Return as string for all other cases
  return value;
}
