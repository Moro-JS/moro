// Unit tests for the shared query-string parser. Semantics must match
// application/x-www-form-urlencoded (WHATWG) and be identical across the
// Node and engine transports.
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

  it('keeps every "=" after the first in the value', () => {
    expect(parseRawQueryString('a=b=c&d==&e=')).toEqual({ a: 'b=c', d: '=', e: '' });
  });

  it('finds no "=" in a pair that has none, whatever follows it', () => {
    expect(parseRawQueryString('flag&other&k=v&last')).toEqual({
      flag: '',
      other: '',
      k: 'v',
      last: '',
    });
    expect(parseRawQueryString('a&b')).toEqual({ a: '', b: '' });
  });

  it('tolerates leading, trailing and repeated separators', () => {
    expect(parseRawQueryString('&a=1&')).toEqual({ a: '1' });
    expect(parseRawQueryString('?')).toEqual({});
    expect(parseRawQueryString('&&&')).toEqual({});
    expect(parseRawQueryString('?&=&')).toEqual({ '': '' });
  });

  it('returns an object without a prototype', () => {
    expect(Object.getPrototypeOf(parseRawQueryString('a=1'))).toBeNull();
    expect(Object.getPrototypeOf(parseRawQueryString(''))).toBeNull();
  });

  // The parser used to split on '&' and cut each pair at its first '='. What
  // it returns must not have changed for any input, hostile ones included.
  describe('gives what the split-based parser gave', () => {
    function decode(component: string): string {
      const plus = component.indexOf('+') === -1 ? component : component.replace(/\+/g, ' ');
      if (plus.indexOf('%') === -1) return plus;
      try {
        return decodeURIComponent(plus);
      } catch {
        return plus;
      }
    }
    function reference(queryString: string): Record<string, string> {
      const result: Record<string, string> = Object.create(null);
      if (!queryString) return result;
      if (queryString[0] === '?') queryString = queryString.substring(1);
      for (const pair of queryString.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq === -1) result[decode(pair)] = '';
        else result[decode(pair.substring(0, eq))] = decode(pair.substring(eq + 1));
      }
      return result;
    }

    const pieces = [
      'a',
      'b',
      'key',
      '=',
      '==',
      '&',
      '&&',
      '+',
      '%20',
      '%',
      '%zz',
      '%E2%82%AC',
      '?',
      '__proto__',
      'é',
      '1',
      '',
    ];

    it('on every combination of a few awkward pieces', () => {
      let checked = 0;
      for (const p1 of pieces)
        for (const p2 of pieces)
          for (const p3 of pieces)
            for (const p4 of pieces) {
              const input = p1 + p2 + p3 + p4;
              expect([input, parseRawQueryString(input)]).toEqual([input, reference(input)]);
              checked++;
            }
      expect(checked).toBe(pieces.length ** 4);
    });

    it('on long random strings over the same alphabet', () => {
      let seed = 0x9e3779b9;
      const next = () => {
        seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) >>> 0;
        return seed;
      };
      for (let run = 0; run < 3000; run++) {
        let input = '';
        const n = next() % 40;
        for (let i = 0; i < n; i++) input += pieces[next() % pieces.length];
        expect([input, parseRawQueryString(input)]).toEqual([input, reference(input)]);
      }
    });
  });

  it('stays linear on a long run of pairs without "="', () => {
    const input = 'k&'.repeat(200_000) + 'z=1';
    const started = Date.now();
    const result = parseRawQueryString(input);
    expect(result.z).toBe('1');
    expect(result.k).toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
