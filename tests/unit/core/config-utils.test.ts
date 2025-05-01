import { getEnvVar } from '../../../src/core/config/utils';

describe('Config Utils - getEnvVar', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getEnvVar function', () => {
    it('should return environment variable value when set', () => {
      process.env.TEST_VAR = 'test-value';
      
      const result = getEnvVar('TEST_VAR', 'default');
      
      expect(result).toBe('test-value');
    });

    it('should return default value when environment variable is not set', () => {
      delete process.env.TEST_VAR;
      
      const result = getEnvVar('TEST_VAR', 'default-value');
      
      expect(result).toBe('default-value');
    });

    it('should return empty string when environment variable is empty string', () => {
      process.env.TEST_VAR = '';
      
      const result = getEnvVar('TEST_VAR', 'default-value');
      
      expect(result).toBe(''); // Empty string is returned as-is
    });

    it('should apply converter function when provided', () => {
      process.env.TEST_NUMBER = '42';
      
      const result = getEnvVar('TEST_NUMBER', 0, (val) => parseInt(val, 10));
      
      expect(result).toBe(42);
      expect(typeof result).toBe('number');
    });

    it('should apply converter to default value if env var not set', () => {
      delete process.env.TEST_NUMBER;
      
      const result = getEnvVar('TEST_NUMBER', 100, (val) => parseInt(val, 10));
      
      expect(result).toBe(100);
      expect(typeof result).toBe('number');
    });

    it('should handle boolean conversion with converter', () => {
      process.env.TEST_BOOL_TRUE = 'true';
      process.env.TEST_BOOL_FALSE = 'false';
      process.env.TEST_BOOL_1 = '1';
      process.env.TEST_BOOL_0 = '0';
      
      const boolConverter = (val: string) => val === 'true' || val === '1';
      
      expect(getEnvVar('TEST_BOOL_TRUE', false, boolConverter)).toBe(true);
      expect(getEnvVar('TEST_BOOL_FALSE', true, boolConverter)).toBe(false);
      expect(getEnvVar('TEST_BOOL_1', false, boolConverter)).toBe(true);
      expect(getEnvVar('TEST_BOOL_0', true, boolConverter)).toBe(false);
    });

    it('should handle array conversion', () => {
      process.env.TEST_ARRAY = 'item1,item2,item3';
      
      const arrayConverter = (val: string) => val.split(',');
      const result = getEnvVar('TEST_ARRAY', [], arrayConverter);
      
      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should handle JSON conversion', () => {
      process.env.TEST_JSON = '{"key": "value", "number": 42}';
      
      const jsonConverter = (val: string) => JSON.parse(val);
      const result = getEnvVar('TEST_JSON', {}, jsonConverter);
      
      expect(result).toEqual({ key: 'value', number: 42 });
    });

    it('should fall back to default on converter errors', () => {
      process.env.TEST_INVALID_JSON = 'invalid-json';
      
      const jsonConverter = (val: string) => JSON.parse(val);
      const result = getEnvVar('TEST_INVALID_JSON', { fallback: true }, jsonConverter);
      
      expect(result).toEqual({ fallback: true });
    });

    it('should handle built-in boolean conversion', () => {
      process.env.TEST_BOOL_TRUE = 'true';
      process.env.TEST_BOOL_FALSE = 'false';
      process.env.TEST_BOOL_MIXED = 'True';
      
      expect(getEnvVar('TEST_BOOL_TRUE', false)).toBe(true);
      expect(getEnvVar('TEST_BOOL_FALSE', true)).toBe(false);
      expect(getEnvVar('TEST_BOOL_MIXED', false)).toBe(true);
    });

    it('should handle built-in number conversion', () => {
      process.env.TEST_NUM_VALID = '123';
      process.env.TEST_NUM_INVALID = 'not-a-number';
      
      expect(getEnvVar('TEST_NUM_VALID', 0)).toBe(123);
      expect(getEnvVar('TEST_NUM_INVALID', 999)).toBe(999); // Falls back to default
    });

    it('should preserve string values by default', () => {
      process.env.TEST_STRING = 'hello world';
      
      const result = getEnvVar('TEST_STRING', 'default');
      
      expect(result).toBe('hello world');
      expect(typeof result).toBe('string');
    });

    it('should handle special characters in environment variables', () => {
      process.env.TEST_SPECIAL = 'hello@world.com:3000/path?query=1';
      
      const result = getEnvVar('TEST_SPECIAL', '');
      
      expect(result).toBe('hello@world.com:3000/path?query=1');
    });

    it('should handle whitespace in environment variables', () => {
      process.env.TEST_WHITESPACE = '  spaced value  ';
      
      const result = getEnvVar('TEST_WHITESPACE', 'default');
      
      expect(result).toBe('  spaced value  '); // Preserves whitespace
    });

    it('should handle numeric strings with leading zeros', () => {
      process.env.TEST_LEADING_ZERO = '0123';
      
      const result = getEnvVar('TEST_LEADING_ZERO', 'default');
      
      expect(result).toBe('0123'); // Preserves as string by default
    });

    it('should handle converter that returns different type', () => {
      process.env.TEST_CONVERT_TYPE = '42';
      
      const result = getEnvVar('TEST_CONVERT_TYPE', { number: 0 }, (val) => ({ number: parseInt(val) }));
      
      expect(result).toEqual({ number: 42 });
      expect(typeof result).toBe('object');
    });
  });
}); 