// @ts-nocheck
// Unit - request-body text/binary classification shared by every server.
import { describe, it, expect } from '@jest/globals';
import { bodyIsText, isJsonMediaType } from '../../../src/core/http/utils/body-type.js';

describe('bodyIsText', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['text/plain', true],
    ['text/csv', true],
    ['TEXT/HTML; charset=iso-8859-1', true],
    ['application/xml', true],
    ['application/javascript', true],
    ['application/graphql', true],
    ['application/x-ndjson', true],
    ['application/vnd.api+json', true],
    ['application/soap+xml; action="urn:x"', true],
    ['application/x-custom; charset=utf-8', true],
  ])('%s decodes to a string', (ct, expected) => {
    expect(bodyIsText(ct)).toBe(expected);
  });

  it.each([
    'application/octet-stream',
    'application/pdf',
    'application/zip',
    'application/gzip',
    'application/wasm',
    'application/x-protobuf',
    'application/msgpack',
    'application/vnd.ms-excel',
    'image/png',
    'image/svg+xml',
    'audio/mpeg',
    'video/mp4',
    'font/woff2',
  ])('%s stays a Buffer', ct => {
    expect(bodyIsText(ct)).toBe(false);
  });
});

describe('isJsonMediaType', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
    ' application/json ; charset=utf-8',
  ])('%s is the JSON media type', ct => {
    expect(isJsonMediaType(ct)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'application/jsonp',
    'application/jsonpatch+json; q=1', // a +json type is text, not application/json itself
    'application/problem+json',
    'text/json',
    'text/plain',
    'application/x-www-form-urlencoded',
  ])('%s is not', ct => {
    expect(isJsonMediaType(ct)).toBe(false);
  });
});
