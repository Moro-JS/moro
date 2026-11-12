// Unit - route parameter percent-decoding shared by every matcher.
import { describe, it, expect } from '@jest/globals';
import { decodeParam } from '../../../src/core/routing/decode-param.js';

describe('decodeParam', () => {
  it('returns a value without a percent sign as is', () => {
    const v = 'plain-value_42';
    expect(decodeParam(v)).toBe(v);
  });

  it('percent-decodes a value', () => {
    expect(decodeParam('%30%30%34%32')).toBe('0042');
    expect(decodeParam('caf%C3%A9')).toBe('café');
    expect(decodeParam('a%20b')).toBe('a b');
  });

  it('keeps the raw text of a malformed escape', () => {
    expect(decodeParam('%zz')).toBe('%zz');
    expect(decodeParam('100%')).toBe('100%');
  });

  it('does not treat a plus sign as a space (path segments are not form data)', () => {
    expect(decodeParam('a+b')).toBe('a+b');
  });
});
