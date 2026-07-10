// Unit tests for the shared query-string parser. Semantics must match
// application/x-www-form-urlencoded (WHATWG) and be identical across the
// Node, uWS, and engine transports.
import { describe, it, expect } from '@jest/globals';
import { parseRawQueryString } from '../../../src/core/http/utils/query-parser.js';

describe('query-parser', () => {
  it('parses simple pairs', () => {
    expect(parseRawQueryString('a=1&b=2')).toEqual({ a: '1', b: '2' });
  });

  it('decodes + as a space in keys and values', () => {
    expect(parseRawQueryString('q=hello+world')).toEqual({ q: 'hello world' });
    expect(parseRawQueryString('a+b=c+d')).toEqual({ 'a b': 'c d' });
  });

  it('percent-decodes values', () => {
    expect(parseRawQueryString('name=John%20Doe')).toEqual({ name: 'John Doe' });
  });

  it('keeps a valueless key as empty string', () => {
    expect(parseRawQueryString('flag&x=1')).toEqual({ flag: '', x: '1' });
  });

  it('does not throw on malformed percent escapes (keeps raw text)', () => {
    expect(parseRawQueryString('q=%zz')).toEqual({ q: '%zz' });
    expect(parseRawQueryString('q=%')).toEqual({ q: '%' });
  });

  it('is last-wins for duplicate keys', () => {
    expect(parseRawQueryString('k=1&k=2')).toEqual({ k: '2' });
  });

  it('tolerates a leading ? and empty pairs', () => {
    expect(parseRawQueryString('?a=1&&b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns an empty object for empty input', () => {
    expect(parseRawQueryString('')).toEqual({});
  });

  it('stores a __proto__ key as an own property without polluting Object', () => {
    const result = parseRawQueryString('__proto__=x&a=1');
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(({} as any).x).toBeUndefined();
    expect(result.a).toBe('1');
  });

  it('handles an empty key', () => {
    expect(parseRawQueryString('=v')).toEqual({ '': 'v' });
  });
});
