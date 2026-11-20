import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  PathMatcher,
  parseExtendedPath,
  optionalPathForms,
  hasExtendedSyntax,
} from '../../../src/core/routing/path-matcher.js';

const match = (pattern: string, path: string) =>
  PathMatcher.compileAndMatch(pattern, path)?.params ?? null;

describe('PathMatcher', () => {
  beforeEach(() => PathMatcher.clearCache());

  describe('optional parameters', () => {
    it('matches the path with and without the parameter, which is named without the ?', () => {
      expect(match('/users/:id?', '/users')).toEqual({});
      expect(match('/users/:id?', '/users/7')).toEqual({ id: '7' });
      expect(match('/users/:id?', '/users/a%2Fb')).toEqual({ id: 'a/b' });
      expect(match('/users/:id?', '/users/7/8')).toBeNull();
      expect(match('/users/:id?', '/users//7')).toBeNull();
      expect(match('/users/:id?', '/user')).toBeNull();

      const compiled = PathMatcher.compile('/users/:id?');
      expect(compiled.paramNames).toEqual(['id']);
      expect(compiled.isStatic).toBe(false);
      expect(compiled.variableLength).toBe(true);
    });

    it('leaves the key of a parameter that is not in the path out of params', () => {
      const params = match('/users/:id?', '/users') as Record<string, string>;
      expect('id' in params).toBe(false);
    });

    it('takes several at the end, each only when the one before it is there', () => {
      expect(match('/a/:b?/:c?', '/a')).toEqual({});
      expect(match('/a/:b?/:c?', '/a/1')).toEqual({ b: '1' });
      expect(match('/a/:b?/:c?', '/a/1/2')).toEqual({ b: '1', c: '2' });
      expect(match('/a/:b?/:c?', '/a/1/2/3')).toBeNull();
      expect(match('/a/:x/:b?', '/a')).toBeNull();
      expect(match('/a/:x/:b?', '/a/1')).toEqual({ x: '1' });
      expect(match('/a/:x/:b?', '/a/1/2')).toEqual({ x: '1', b: '2' });
    });

    it('works with nothing in front of it', () => {
      expect(match('/:id?', '/')).toEqual({});
      expect(match('/:id?', '/7')).toEqual({ id: '7' });
      expect(match('/:id?', '/7/8')).toBeNull();
    });

    it('reads the fixed text in front of it as it is written', () => {
      expect(match('/v1.0/items/:id?', '/v1.0/items')).toEqual({});
      expect(match('/v1.0/items/:id?', '/v1x0/items')).toBeNull();
      expect(match('/c++/:id?', '/c++/1')).toEqual({ id: '1' });
      expect(match('/c++/:id?', '/c/1')).toBeNull();
    });
  });

  describe('wildcards', () => {
    it('takes the rest of the path after the slash, slashes included', () => {
      expect(match('/files/*', '/files/')).toEqual({ '*': '' });
      expect(match('/files/*', '/files/a')).toEqual({ '*': 'a' });
      expect(match('/files/*', '/files/a/b.txt')).toEqual({ '*': 'a/b.txt' });
      expect(match('/files/*', '/files/a/')).toEqual({ '*': 'a/' });
      expect(match('/files/*', '/files')).toBeNull();
      expect(match('/files/*', '/filesystem/a')).toBeNull();

      const compiled = PathMatcher.compile('/files/*');
      expect(compiled.paramNames).toEqual(['*']);
      expect(compiled.isStatic).toBe(false);
      expect(compiled.variableLength).toBe(true);
    });

    it('decodes the rest once, as a parameter is decoded', () => {
      expect(match('/files/*', '/files/a%2Fb/c%20d')).toEqual({ '*': 'a/b/c d' });
      expect(match('/files/*', '/files/%2e%2e/x')).toEqual({ '*': '../x' });
      expect(match('/files/*', '/files/%zz')).toEqual({ '*': '%zz' });
    });

    it('does not match a path with an empty segment', () => {
      expect(match('/files/*', '/files/x')).toEqual({ '*': 'x' });
      expect(match('/files/*', '/files//x')).toBeNull();
      expect(match('/files/*', '/files/a//b')).toBeNull();
      expect(match('/files/*', '/files/a//')).toBeNull();
      expect(match('/files/*', '/files//')).toBeNull();
    });

    it('keeps dot segments in the value and never leaves its own path', () => {
      expect(match('/files/*', '/files/../secret')).toEqual({ '*': '../secret' });
      expect(match('/files/*', '/other/../files/x')).toBeNull();
    });

    it('can be named, and follows parameters', () => {
      expect(match('/files/*path', '/files/a/b')).toEqual({ path: 'a/b' });
      expect(match('/static/:kind/*', '/static/css/a/b.css')).toEqual({
        kind: 'css',
        '*': 'a/b.css',
      });
      expect(match('/static/:kind/*', '/static/css')).toBeNull();
      expect(match('/*', '/')).toEqual({ '*': '' });
      expect(match('/*', '/a/b')).toEqual({ '*': 'a/b' });
    });

    it('answers a long path with an empty segment at once', () => {
      const compiled = PathMatcher.compile('/files/*');
      const path = `/files/${'a'.repeat(50_000)}//`;
      const deep = 'a/'.repeat(25_000);
      const started = Date.now();
      expect(PathMatcher.match(compiled, path)).toBeNull();
      expect(PathMatcher.match(compiled, `/files/${deep}/`)).toBeNull();
      expect(PathMatcher.match(compiled, `/files/${deep}`)).toEqual({ params: { '*': deep } });
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  describe('parseExtendedPath', () => {
    it('returns null for a path with neither form, which is matched as it has been', () => {
      expect(match('/c++', '/c++')).toEqual({});
      expect(match('/c++', '/c')).toBeNull();
      expect(match('/glob/**', '/glob/**')).toEqual({});
      expect(match('/glob/**', '/glob/x')).toBeNull();
      expect(match('/users/:id', '/users/a%2Fb')).toEqual({ id: 'a/b' });
      expect(match('/n/:name.json', '/n/x')).toEqual({ 'name.json': 'x' });
      for (const path of ['/c++', '/glob/**', '/users/:id']) {
        expect(PathMatcher.compile(path).variableLength).toBeUndefined();
      }

      for (const path of [
        '/',
        '/users',
        '/users/:id',
        '/c++',
        '/glob/**',
        '/img/*.png',
        '/a*',
        '/search?debug',
        '/q/:a/b?x',
        '/proxy/:svc/.*',
        '/re/:id(\\d+)',
        '*',
      ]) {
        expect(parseExtendedPath(path)).toBeNull();
        expect(hasExtendedSyntax(path)).toBe(false);
      }
    });

    it('reads trailing optional parameters and the path in front of them', () => {
      expect(parseExtendedPath('/users/:id?')).toEqual({
        base: '/users',
        optional: ['id'],
        wildcard: undefined,
      });
      expect(parseExtendedPath('/a/:x/:b?/:c?')).toEqual({
        base: '/a/:x',
        optional: ['b', 'c'],
        wildcard: undefined,
      });
      expect(parseExtendedPath('/:id?')).toEqual({
        base: '',
        optional: ['id'],
        wildcard: undefined,
      });
      // A slash at the end is not a segment after the parameter
      expect(parseExtendedPath('/users/:id?/')?.optional).toEqual(['id']);
      expect(hasExtendedSyntax('/users/:id?')).toBe(true);
    });

    it('reads a wildcard as the last segment, named or not', () => {
      expect(parseExtendedPath('/files/*')).toEqual({
        base: '/files',
        optional: [],
        wildcard: '*',
      });
      expect(parseExtendedPath('/files/*path')).toEqual({
        base: '/files',
        optional: [],
        wildcard: 'path',
      });
      expect(parseExtendedPath('/*')).toEqual({ base: '', optional: [], wildcard: '*' });
      expect(parseExtendedPath('/static/:kind/*')?.base).toBe('/static/:kind');
    });

    it('lists the paths an optional-parameter route stands for', () => {
      const forms = (path: string) => optionalPathForms(parseExtendedPath(path)!);
      expect(forms('/users/:id?')).toEqual(['/users', '/users/:id']);
      expect(forms('/a/:x/:b?/:c?')).toEqual(['/a/:x', '/a/:x/:b', '/a/:x/:b/:c']);
      expect(forms('/:id?')).toEqual(['/', '/:id']);
    });

    it.each([
      ['/users/:id?/posts', "':id?' is followed by 'posts'"],
      ['/users/:id?/:postId', "':id?' is followed by ':postId'"],
      ['/a/:b?/*', "':b?' is followed by '*'"],
    ])('refuses an optional parameter that is not at the end: %s', (path, reason) => {
      expect(() => parseExtendedPath(path, `GET ${path}`)).toThrow(`GET ${path}: `);
      expect(() => parseExtendedPath(path)).toThrow(reason);
    });

    it.each(['/users/:id?.json', '/files/img-:id?', '/users/:id(\\d+)?', '/t/:a?:b?', '/x/:?'])(
      'refuses an optional parameter that shares its segment: %s',
      path => {
        expect(() => parseExtendedPath(path)).toThrow(
          "'?' makes a parameter optional only when the segment is the parameter"
        );
      }
    );

    it.each(['/a/*/b', '/*/b', '/a/*rest/b', '/a/*/:id'])(
      'refuses a wildcard that is not the last segment: %s',
      path => {
        expect(() => parseExtendedPath(path)).toThrow('must be the last segment of the path');
        expect(() => PathMatcher.compile(path)).toThrow('must be the last segment of the path');
      }
    );
  });
});
