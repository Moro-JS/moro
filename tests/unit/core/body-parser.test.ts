// Unit tests for the shared urlencoded body parser and the buffered-body
// parsing step built on it. These exercise the parser directly (not over
// HTTP) so the field cap is asserted at its exact boundary.
import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_MAX_FORM_FIELDS,
  FormLimitError,
  parseBufferedBody,
  parseUrlEncodedBody,
} from '../../../src/core/http/utils/body-parser.js';

const FORM = 'application/x-www-form-urlencoded';

// `count` fields k0=1&k1=1&...
const fields = (count: number) => Array.from({ length: count }, (_, i) => `k${i}=1`).join('&');

// What the servers built before the cap existed
const uncapped = (text: string) => {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) result[key] = value;
  return result;
};

describe('parseUrlEncodedBody', () => {
  it('parses a form into an object of strings', () => {
    expect(parseUrlEncodedBody('a=1&b=two+words&c=%C3%A9&d')).toEqual({
      a: '1',
      b: 'two words',
      c: 'é',
      d: '',
    });
  });

  it('keeps the last value of a repeated key', () => {
    expect(parseUrlEncodedBody('a=1&b=x&a=2&a=3')).toEqual({ a: '3', b: 'x' });
  });

  it('parses an empty body as no fields, whatever the limit', () => {
    expect(parseUrlEncodedBody('')).toEqual({});
    expect(parseUrlEncodedBody('', 1)).toEqual({});
  });

  it('gives what URLSearchParams gives for every body under the cap', () => {
    for (const text of [
      'a=1',
      'a=1&b=2',
      '=nokey&novalue=&=',
      'a=b=c&d==e',
      'a%20b=c%26d&e=%zz',
      '__proto__=x&constructor=y',
      '?a=1&b=2',
      'a=1&&b=2&',
    ]) {
      expect(parseUrlEncodedBody(text)).toEqual(uncapped(text));
    }
  });

  it('takes a body under the cap and one of exactly the cap', () => {
    expect(Object.keys(parseUrlEncodedBody(fields(9), 10))).toHaveLength(9);
    expect(Object.keys(parseUrlEncodedBody(fields(10), 10))).toHaveLength(10);
    expect(parseUrlEncodedBody('only=one', 1)).toEqual({ only: 'one' });
  });

  it('refuses a body one field over the cap with a 413 that names the limit', () => {
    let thrown: any;
    try {
      parseUrlEncodedBody(fields(11), 10);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FormLimitError);
    expect(thrown.statusCode).toBe(413);
    expect(thrown.limit).toBe(10);
    expect(thrown.message).toMatch(/10 fields/);
    expect(thrown.message).toMatch(/server\.limits\.form\.maxFields/);

    expect(() => parseUrlEncodedBody('a=1&b=2', 1)).toThrow(FormLimitError);
  });

  it('applies a cap of 1000 when it is given none', () => {
    expect(DEFAULT_MAX_FORM_FIELDS).toBe(1000);
    expect(Object.keys(parseUrlEncodedBody(fields(1000)))).toHaveLength(1000);
    expect(() => parseUrlEncodedBody(fields(1001))).toThrow(/1000 fields/);
    expect(() => parseUrlEncodedBody(fields(1001), undefined)).toThrow(/1000 fields/);
  });

  it('counts an empty segment as a field', () => {
    // Three segments, two fields: over a cap of 2, within a cap of 3
    expect(() => parseUrlEncodedBody('a=1&&b=2', 2)).toThrow(FormLimitError);
    expect(parseUrlEncodedBody('a=1&&b=2', 3)).toEqual({ a: '1', b: '2' });
    expect(() => parseUrlEncodedBody('a=1&', 1)).toThrow(FormLimitError);
  });

  it('stops counting where a body of 100,000 fields goes over the cap, and parses none of it', () => {
    const flood = fields(100000);
    // The same text, counting the scans made of it; decoding it would throw
    let scans = 0;
    const watched: any = {
      length: flood.length,
      indexOf(search: string, from?: number) {
        scans++;
        return flood.indexOf(search, from);
      },
      toString() {
        throw new Error('the refused body was parsed');
      },
    };
    expect(() => parseUrlEncodedBody(watched, 1000)).toThrow(FormLimitError);
    expect(scans).toBe(1000);
    expect(() => parseUrlEncodedBody(flood)).toThrow(/1000 fields/);
  });
});

describe('parseBufferedBody (urlencoded)', () => {
  it('applies limits.form.maxFields, at the cap and one over', () => {
    const limits = { form: { maxFields: 3 } };
    expect(parseBufferedBody(Buffer.from('a=1&b=2&c=3'), FORM, limits, true)).toEqual({
      a: '1',
      b: '2',
      c: '3',
    });

    let thrown: any;
    try {
      parseBufferedBody(Buffer.from('a=1&b=2&c=3&d=4'), FORM, limits, true);
    } catch (error) {
      thrown = error;
    }
    // The limit's own status, not the 400 of a body that cannot be parsed
    expect(thrown).toBeInstanceOf(FormLimitError);
    expect(thrown.statusCode).toBe(413);
  });

  it('applies the default of 1000 without limits, and with limits that say nothing of forms', () => {
    for (const limits of [undefined, {}, { multipart: { maxParts: 5 } }, { form: {} }]) {
      expect(
        Object.keys(parseBufferedBody(Buffer.from(fields(1000)), FORM, limits, false))
      ).toHaveLength(1000);
      expect(() => parseBufferedBody(Buffer.from(fields(1001)), FORM, limits, false)).toThrow(
        FormLimitError
      );
    }
  });

  it('leaves a body of another type alone, however many separators it holds', () => {
    const text = fields(5000);
    expect(parseBufferedBody(Buffer.from(text), 'text/plain', undefined, false)).toBe(text);
    expect(
      parseBufferedBody(Buffer.from(JSON.stringify({ text })), 'application/json', undefined, true)
    ).toEqual({ text });
  });

  it('still hands multipart limits to the multipart parser', () => {
    const part = (name: string) =>
      `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nv\r\n`;
    const body = Buffer.from(`${part('a')}${part('b')}${part('c')}--b--\r\n`);
    const type = 'multipart/form-data; boundary=b';
    expect(parseBufferedBody(body, type, { multipart: { maxParts: 3 } }, true).fields).toEqual({
      a: 'v',
      b: 'v',
      c: 'v',
    });
    expect(() => parseBufferedBody(body, type, { multipart: { maxParts: 2 } }, true)).toThrow(
      /parts/
    );
  });
});
