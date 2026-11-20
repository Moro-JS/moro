// gRPC middleware: a handler array runs every element in order with the last
// one as the handler, and stops at the first that answers or throws; grpcAuth
// accepts only a token that `verify` resolves to a user; grpcValidateHandler
// does not run the handler for a request it rejected; roles and permissions
// match by whole entry, never by substring.
import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { explicitGrpcStatus } from '../../src/core/grpc/adapters/grpc-js-adapter.js';
import { grpcLogger } from '../../src/core/grpc/middleware/logging.js';
import {
  grpcAuth,
  grpcRequirePermission,
  grpcRequireRole,
} from '../../src/core/grpc/middleware/auth.js';
import { grpcValidate, grpcValidateHandler } from '../../src/core/grpc/middleware/validation.js';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';
import type { GrpcCall, GrpcMetadata, ServiceImplementation } from '../../src/core/grpc/types.js';
import { adapterOnFakes, fakePackageDefinition } from '../utils/grpc-fakes.js';

type CallbackArgs = [error: any, response?: any];

function metadataWith(values: Record<string, string>): GrpcMetadata {
  return {
    get: (key: string) => values[key],
    set: () => undefined,
    add: () => undefined,
    remove: () => undefined,
    getMap: () => ({ ...values }),
  };
}

function fakeCall(request: unknown, metadata: Record<string, string> = {}): GrpcCall {
  return {
    request,
    metadata: metadataWith(metadata),
    cancelled: false,
    getPeer: () => 'test-peer',
    sendMetadata: () => undefined,
  };
}

function recordingCallback() {
  const calls: CallbackArgs[] = [];
  const callback = (error: any, response?: any) => {
    calls.push([error, response]);
  };
  return { calls, callback };
}

/**
 * Register a service through an adapter that runs on stand-ins shaped like
 * @grpc/grpc-js and @grpc/proto-loader, and return the handlers it gave the
 * grpc-js server.
 */
async function registerOnFakeServer(implementation: ServiceImplementation) {
  const methods: Record<string, object> = {};
  for (const name of Object.keys(implementation)) {
    methods[name] = {};
  }
  const { adapter, server } = adapterOnFakes({
    'service.proto': fakePackageDefinition({ test: { Service: methods } }),
  });
  await adapter.initialize({});

  const [definition] = await adapter.loadProto('service.proto');
  adapter.addService('Service', definition, implementation);

  return server().registered[0].implementation as Record<
    string,
    (call: any, callback?: any) => Promise<void>
  >;
}

// warn()/error() are instance properties (noops below the active level), so
// raise the level and observe the shared private log(level, message) sink.
function captureLogs() {
  globalLogger.setLevel('debug');
  const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  return (level: string) => spy.mock.calls.filter(c => c[0] === level).map(c => String(c[1]));
}

describe('gRPC middleware', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
  });

  describe('handler arrays', () => {
    it('runs every element in order and the last one as the handler', async () => {
      const order: string[] = [];
      const service = await registerOnFakeServer({
        Get: [
          async () => {
            order.push('first');
          },
          async () => {
            order.push('second');
          },
          async (_call: GrpcCall, callback: (e: any, r?: any) => void) => {
            order.push('handler');
            callback(null, { ok: true });
          },
        ],
      });

      const { calls, callback } = recordingCallback();
      await service.Get(fakeCall({}), callback);

      expect(order).toEqual(['first', 'second', 'handler']);
      expect(calls).toEqual([[null, { ok: true }]]);
    });

    it('stops when a middleware answers through the callback', async () => {
      let handlerRuns = 0;
      const later = jest.fn(async () => undefined);
      const service = await registerOnFakeServer({
        Delete: [
          grpcAuth({ verify: async token => (token === 'good' ? { id: 1 } : null) }),
          later,
          async (_call: GrpcCall, callback: (e: any, r?: any) => void) => {
            handlerRuns++;
            callback(null, { deleted: true });
          },
        ],
      });

      const { calls, callback } = recordingCallback();
      await service.Delete(fakeCall({ id: 'x' }), callback);

      expect(handlerRuns).toBe(0);
      expect(later).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0][0].code).toBe(16);
    });

    it('stops when a middleware throws (no callback: streaming call)', async () => {
      let handlerRuns = 0;
      const service = await registerOnFakeServer({
        Watch: [
          grpcAuth({ verify: async () => ({ id: 1 }) }),
          async () => {
            handlerRuns++;
          },
        ],
      });

      const emitted: unknown[] = [];
      const call = Object.assign(fakeCall({}), {
        emit: (_event: string, error: unknown) => emitted.push(error),
      });
      await service.Watch(call);

      expect(handlerRuns).toBe(0);
      expect(emitted).toHaveLength(1);
    });

    it('enforces auth, role and validation placed before a handler', async () => {
      let handlerRuns = 0;
      const schema = {
        parse: (value: any) => {
          if (typeof value?.id !== 'string') throw new Error('id must be a string');
          return value;
        },
      };
      const service = await registerOnFakeServer({
        DeleteUser: [
          grpcAuth({
            verify: async token =>
              token === 'admin-token'
                ? { id: 1, roles: ['admin'] }
                : token === 'user-token'
                  ? { id: 2, roles: ['user'] }
                  : null,
          }),
          grpcRequireRole('admin'),
          grpcValidate({ request: schema }),
          async (call: GrpcCall, callback: (e: any, r?: any) => void) => {
            handlerRuns++;
            callback(null, { id: call.request.id, name: 'deleted' });
          },
        ],
      });

      const anonymous = recordingCallback();
      await service.DeleteUser(fakeCall({ id: 'x' }), anonymous.callback);
      expect(anonymous.calls[0][0].code).toBe(16);

      const user = recordingCallback();
      await service.DeleteUser(
        fakeCall({ id: 'x' }, { authorization: 'Bearer user-token' }),
        user.callback
      );
      expect(user.calls[0][0].code).toBe(7);

      const invalid = recordingCallback();
      await service.DeleteUser(
        fakeCall({ id: { $ne: null } }, { authorization: 'Bearer admin-token' }),
        invalid.callback
      );
      expect(invalid.calls).toHaveLength(1);
      expect(invalid.calls[0][0].code).toBe(3);
      expect(handlerRuns).toBe(0);

      const admin = recordingCallback();
      await service.DeleteUser(
        fakeCall({ id: 'x' }, { authorization: 'Bearer admin-token' }),
        admin.callback
      );
      expect(admin.calls).toEqual([[null, { id: 'x', name: 'deleted' }]]);
      expect(handlerRuns).toBe(1);
    });

    it('runs a single (non-array) handler', async () => {
      const service = await registerOnFakeServer({
        Get: async (_call: GrpcCall, callback: (e: any, r?: any) => void) => {
          callback(null, { ok: true });
        },
      });
      const { calls, callback } = recordingCallback();
      await service.Get(fakeCall({}), callback);
      expect(calls).toEqual([[null, { ok: true }]]);
    });
  });

  describe('middleware that wraps the call', () => {
    const recordingLogger = () => {
      const lines: string[] = [];
      const push = (level: string) => (message: string) => lines.push(`${level}: ${message}`);
      return { lines, logger: { info: push('info'), debug: push('debug'), error: push('error') } };
    };

    it('grpcLogger reports completion after the handler has finished', async () => {
      const { lines, logger } = recordingLogger();
      const order: string[] = [];
      const service = await registerOnFakeServer({
        Get: [
          grpcLogger({ logger }),
          async () => {
            order.push('second middleware');
          },
          async (_call: GrpcCall, callback: (error: any, response?: any) => void) => {
            await new Promise(resolve => setTimeout(resolve, 10));
            order.push(`handler (log lines so far: ${lines.length})`);
            callback(null, { ok: true });
          },
        ],
      });

      const { calls, callback } = recordingCallback();
      await service.Get(fakeCall({}), callback);

      // Only the "call started" line exists while the handler runs
      expect(order).toEqual(['second middleware', 'handler (log lines so far: 1)']);
      expect(calls).toEqual([[null, { ok: true }]]);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('/test.Service/Get');
      expect(lines[1]).toContain('completed');
    });

    it('grpcLogger logs the response when logResponse is set', async () => {
      const { lines, logger } = recordingLogger();
      const service = await registerOnFakeServer({
        Get: [
          grpcLogger({ logger, logResponse: true }),
          async (_call: GrpcCall, callback: (error: any, response?: any) => void) => {
            callback(null, { id: 7 });
          },
        ],
        Missing: [
          grpcLogger({ logger, logResponse: true }),
          async (_call: GrpcCall, callback: (error: any, response?: any) => void) => {
            callback({ code: 5, message: 'not found' });
          },
        ],
      });

      const ok = recordingCallback();
      await service.Get(fakeCall({}), ok.callback);
      expect(ok.calls).toEqual([[null, { id: 7 }]]);
      expect(lines).toContain('debug: Response: {"id":7}');

      lines.length = 0;
      const missing = recordingCallback();
      await service.Missing(fakeCall({}), missing.callback);
      expect(missing.calls).toEqual([[{ code: 5, message: 'not found' }]]);
      expect(lines.some(line => line.includes('Response:'))).toBe(false);
    });

    describe('grpcLogger request and response messages', () => {
      const secretRequest = {
        username: 'ann',
        password: 'hunter2',
        profile: { apiKey: 'sk-live-123', note: 'x'.repeat(5000), avatar: Buffer.alloc(4096, 1) },
        tokens: [{ refresh_token: 'r-1', label: 'phone' }],
      };
      const echo = (options: Record<string, unknown>, logger: unknown) =>
        registerOnFakeServer({
          Get: [
            grpcLogger({ logger, logRequest: true, logResponse: true, ...options }),
            async (call: GrpcCall, callback: (error: any, response?: any) => void) => {
              callback(null, { session: { accessToken: 'at-9' }, echoed: call.request });
            },
          ],
        });
      const line = (lines: string[], prefix: string) =>
        lines.find(candidate => candidate.startsWith(`debug: ${prefix}: `)) as string;

      it('redacts credential fields, sizes binary fields and cuts the text by default', async () => {
        const { lines, logger } = recordingLogger();
        const service = await echo({}, logger);
        const { calls, callback } = recordingCallback();
        await service.Get(fakeCall(secretRequest), callback);

        const request = line(lines, 'Request');
        const response = line(lines, 'Response');
        for (const text of [request, response]) {
          for (const secret of ['hunter2', 'sk-live-123', 'r-1', 'at-9']) {
            expect(text).not.toContain(secret);
          }
        }
        expect(request).toContain('"username":"ann"');
        expect(request).toContain('"password":"[REDACTED]"');
        expect(request).toContain('"apiKey":"[REDACTED]"');
        // 2048 characters of message, then how much was left out
        expect(request).toMatch(/^debug: Request: .{2048}\.\.\. \[\d+ more characters\]$/);
        expect(response).toContain('"accessToken":"[REDACTED]"');

        // The handler and the caller still get the message itself
        expect(calls[0][1].echoed).toBe(secretRequest);

        // fullBodies: the messages whole and as they are
        const full = recordingLogger();
        const verbose = await echo({ fullBodies: true }, full.logger);
        await verbose.Get(fakeCall(secretRequest), recordingCallback().callback);
        expect(line(full.lines, 'Request')).toBe(
          `debug: Request: ${JSON.stringify(secretRequest)}`
        );
        expect(line(full.lines, 'Response')).toContain('"accessToken":"at-9"');
      });

      it('writes a binary field as its size', async () => {
        const { lines, logger } = recordingLogger();
        const service = await echo({ logResponse: false }, logger);
        await service.Get(
          fakeCall({ avatar: Buffer.alloc(4096, 1), raw: new Uint8Array(16), label: 'a' }),
          recordingCallback().callback
        );
        expect(line(lines, 'Request')).toBe(
          'debug: Request: {"avatar":"[4096 bytes]","raw":"[16 bytes]","label":"a"}'
        );
      });

      it('cuts at maxBodyLength', async () => {
        const { lines, logger } = recordingLogger();
        const service = await echo({ maxBodyLength: 20, logResponse: false }, logger);
        await service.Get(fakeCall({ note: 'n'.repeat(100) }), recordingCallback().callback);
        expect(line(lines, 'Request')).toBe(
          `debug: Request: {"note":"${'n'.repeat(11)}... [91 more characters]`
        );
      });
    });

    it('grpcLogger logs metadata with the values of credential-bearing keys redacted', async () => {
      const { lines, logger } = recordingLogger();
      const service = await registerOnFakeServer({
        Get: [
          grpcLogger({ logger, logMetadata: true }),
          async (_call: GrpcCall, callback: (error: any, response?: any) => void) => {
            callback(null, {});
          },
        ],
      });

      const credentials = {
        authorization: 'Bearer live-access-token',
        'proxy-authorization': 'Basic cHJveHk6cGFzcw==',
        cookie: 'session=abc123',
        'x-api-key': 'key-1',
        apikey: 'key-2',
        'x-auth-token': 'tok-3',
        'client-secret': 'sec-4',
        'db-password': 'pw-5',
        'X-Refresh-Token': 'tok-6',
      };
      const { callback } = recordingCallback();
      await service.Get(
        fakeCall({}, { ...credentials, 'x-request-id': 'req-42', 'user-agent': 'grpc-node/1.9' }),
        callback
      );

      const line = lines.find(l => l.startsWith('debug: Metadata: '));
      expect(line).toBeDefined();
      const logged = JSON.parse(String(line).slice('debug: Metadata: '.length));

      // Every key is still listed; only credential values are replaced
      for (const key of Object.keys(credentials)) {
        expect(logged[key]).toBe('[REDACTED]');
      }
      expect(logged['x-request-id']).toBe('req-42');
      expect(logged['user-agent']).toBe('grpc-node/1.9');
      for (const value of Object.values(credentials)) {
        expect(lines.join('\n')).not.toContain(value);
      }
    });

    it('grpcLogger reports a handler failure and the call still fails', async () => {
      const { lines, logger } = recordingLogger();
      const service = await registerOnFakeServer({
        Get: [
          grpcLogger({ logger }),
          async () => {
            throw new Error('boom');
          },
        ],
      });

      const { calls, callback } = recordingCallback();
      await service.Get(fakeCall({}), callback);

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBeTruthy();
      expect(lines.some(line => line.startsWith('error:') && line.includes('boom'))).toBe(true);
      expect(lines.some(line => line.includes('completed'))).toBe(false);
    });

    it('a denial after a wrapping middleware still keeps the handler from running', async () => {
      const { logger } = recordingLogger();
      let handlerRuns = 0;
      const service = await registerOnFakeServer({
        Get: [
          grpcLogger({ logger }),
          grpcAuth({ verify: async () => ({ id: 1 }) }),
          async () => {
            handlerRuns++;
          },
        ],
      });

      const { calls, callback } = recordingCallback();
      await service.Get(fakeCall({}), callback);

      expect(handlerRuns).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0][0].code).toBe(16);
    });

    it('runs the rest of the chain once when next() is not awaited', async () => {
      let handlerRuns = 0;
      const service = await registerOnFakeServer({
        Get: [
          (_call: GrpcCall, _callback: unknown, next: () => Promise<void>) => {
            void next();
            void next();
          },
          async (_call: GrpcCall, callback: (error: any, response?: any) => void) => {
            handlerRuns++;
            callback(null, { ok: true });
          },
        ] as any,
      });

      const { calls, callback } = recordingCallback();
      await service.Get(fakeCall({}), callback);

      expect(handlerRuns).toBe(1);
      expect(calls).toEqual([[null, { ok: true }]]);
    });
  });

  describe('status code of a thrown error', () => {
    it('keeps a gRPC status code the error carries', () => {
      expect(explicitGrpcStatus(Object.assign(new Error('x'), { code: 16 }))).toBe(16);
      expect(explicitGrpcStatus(Object.assign(new Error('x'), { code: 7 }))).toBe(7);
      expect(explicitGrpcStatus({ code: 1 })).toBe(1);
    });

    it('answers a thrown error with its code, its message and its trailing metadata', async () => {
      const trailers = metadataWith({ 'error-code': 'QUOTA' });
      const service = await registerOnFakeServer({
        Get: async () => {
          throw Object.assign(new Error('quota used up'), { code: 8, metadata: trailers });
        },
        Plain: async () => {
          throw new Error('database exploded');
        },
      });

      const coded = recordingCallback();
      await service.Get(fakeCall({}), coded.callback);
      expect(coded.calls).toEqual([[{ code: 8, message: 'quota used up', metadata: trailers }]]);

      const plain = recordingCallback();
      await service.Plain(fakeCall({}), plain.callback);
      expect(plain.calls).toEqual([[{ code: 13, message: 'database exploded' }]]);
    });

    it('ends a streaming call with the status of a thrown error', async () => {
      const service = await registerOnFakeServer({
        Watch: async () => {
          throw Object.assign(new Error('limit must not be negative'), { code: 11 });
        },
      });

      const emitted: Array<[string, unknown]> = [];
      const call = Object.assign(fakeCall({}), {
        emit: (event: string, error: unknown) => emitted.push([event, error]),
      });
      await service.Watch(call);

      expect(emitted).toEqual([['error', { code: 11, message: 'limit must not be negative' }]]);
    });

    it('ignores codes that are not gRPC statuses', () => {
      expect(explicitGrpcStatus(new Error('x'))).toBeUndefined();
      expect(explicitGrpcStatus(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined();
      expect(explicitGrpcStatus({ code: 0 })).toBeUndefined();
      expect(explicitGrpcStatus({ code: 17 })).toBeUndefined();
      expect(explicitGrpcStatus({ code: 1062 })).toBeUndefined();
      expect(explicitGrpcStatus({ code: 3.5 })).toBeUndefined();
      expect(explicitGrpcStatus(null)).toBeUndefined();
      expect(explicitGrpcStatus('unauthenticated')).toBeUndefined();
    });
  });

  describe('grpcAuth', () => {
    const bearer = { authorization: 'Bearer not.a.jwt' };

    it('rejects every token when only `secret` is configured, and says why', async () => {
      const logs = captureLogs();
      const auth = grpcAuth({ secret: 'shh' });

      const call = fakeCall({}, bearer);
      const { calls, callback } = recordingCallback();
      await auth(call, callback);

      expect(calls).toHaveLength(1);
      expect(calls[0][0].code).toBe(16);
      expect((call as any).user).toBeUndefined();

      const errors = logs('error').join('\n');
      expect(errors).toContain('`secret` is not implemented');
      expect(errors).toContain('`verify` function');
    });

    it('throws UNAUTHENTICATED for `secret`-only when there is no callback', async () => {
      captureLogs();
      const auth = grpcAuth({ secret: 'shh' });
      await expect(auth(fakeCall({}, bearer))).rejects.toMatchObject({ code: 16 });
    });

    it('rejects every call when neither `verify` nor `secret` is configured', async () => {
      const logs = captureLogs();
      const auth = grpcAuth({});
      expect(logs('warn').filter(m => m.includes('no `verify` function'))).toHaveLength(1);

      const withToken = recordingCallback();
      const call = fakeCall({}, bearer);
      await auth(call, withToken.callback);
      expect(withToken.calls[0][0].code).toBe(16);
      expect((call as any).user).toBeUndefined();

      const withoutToken = recordingCallback();
      await auth(fakeCall({}), withoutToken.callback);
      expect(withoutToken.calls[0][0].code).toBe(16);

      // Warned once, at construction
      expect(logs('warn').filter(m => m.includes('no `verify` function'))).toHaveLength(1);
    });

    it('treats a falsy `verify` result as a rejection', async () => {
      captureLogs();
      for (const result of [undefined, null, false, 0, '']) {
        const auth = grpcAuth({ verify: async () => result });
        const call = fakeCall({}, bearer);
        const { calls, callback } = recordingCallback();
        await auth(call, callback);
        expect(calls).toHaveLength(1);
        expect(calls[0][0].code).toBe(16);
        expect((call as any).user).toBeUndefined();
      }
    });

    it('accepts a token that `verify` resolves to a user', async () => {
      const auth = grpcAuth({ verify: async token => ({ id: 7, token }) });
      const call = fakeCall({}, { authorization: 'Bearer good' });
      const { calls, callback } = recordingCallback();
      await auth(call, callback);
      expect(calls).toHaveLength(0);
      expect((call as any).user).toEqual({ id: 7, token: 'good' });
    });

    it('lets an anonymous call through when `required` is false', async () => {
      const auth = grpcAuth({ verify: async () => ({ id: 1 }), required: false });
      const call = fakeCall({});
      const { calls, callback } = recordingCallback();
      await auth(call, callback);
      expect(calls).toHaveLength(0);
      expect((call as any).user).toBeUndefined();
    });
  });

  describe('grpcValidateHandler', () => {
    let handlerRuns: number;

    beforeEach(() => {
      handlerRuns = 0;
    });

    const schema = {
      parse: (value: any) => {
        if (typeof value?.id !== 'string') throw new Error('id must be a string');
        return value;
      },
    };

    it('does not run the handler after rejecting the request', async () => {
      captureLogs();
      const wrapped = grpcValidateHandler(
        async (call, callback) => {
          handlerRuns++;
          callback(null, { deleted: (call.request as any).id });
        },
        { request: schema }
      );

      const { calls, callback } = recordingCallback();
      await wrapped(fakeCall({ id: { $ne: null } }), callback);

      expect(handlerRuns).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0][0].code).toBe(3);
    });

    it('runs the handler for a valid request', async () => {
      const wrapped = grpcValidateHandler(
        async (call, callback) => {
          handlerRuns++;
          callback(null, { deleted: (call.request as any).id });
        },
        { request: schema }
      );

      const { calls, callback } = recordingCallback();
      await wrapped(fakeCall({ id: 'abc' }), callback);

      expect(handlerRuns).toBe(1);
      expect(calls).toEqual([[null, { deleted: 'abc' }]]);
    });
  });

  describe('role and permission matching', () => {
    async function denied(
      middleware: (call: GrpcCall, callback?: (e: any, r?: any) => void) => Promise<void>,
      user: unknown
    ): Promise<boolean> {
      const call = Object.assign(fakeCall({}), { user });
      const { calls, callback } = recordingCallback();
      await middleware(call, callback);
      return calls.length === 1 && calls[0][0].code === 7;
    }

    it('does not match a role by substring', async () => {
      expect(await denied(grpcRequireRole('admin'), { roles: 'not-admin' })).toBe(true);
      expect(await denied(grpcRequireRole('admin'), { role: 'not-admin' })).toBe(true);
      expect(await denied(grpcRequireRole('admin'), { roles: ['not-admin'] })).toBe(true);
      expect(await denied(grpcRequireRole('admin'), { roles: { admin: true } })).toBe(true);
    });

    it('matches roles exactly from an array, a delimited string or `role`', async () => {
      expect(await denied(grpcRequireRole('admin'), { roles: ['user', 'admin'] })).toBe(false);
      expect(await denied(grpcRequireRole('admin'), { roles: 'user, admin' })).toBe(false);
      expect(await denied(grpcRequireRole('admin'), { roles: 'user admin' })).toBe(false);
      expect(await denied(grpcRequireRole('admin'), { roles: 'admin' })).toBe(false);
      expect(await denied(grpcRequireRole('admin'), { role: 'admin' })).toBe(false);
      expect(await denied(grpcRequireRole(['ops', 'admin']), { role: 'ops' })).toBe(false);
    });

    it('does not match a permission by substring', async () => {
      const requireWrite = grpcRequirePermission('users:write');
      expect(await denied(requireWrite, { permissions: 'users:write-own' })).toBe(true);
      expect(await denied(requireWrite, { permissions: ['users:write-own'] })).toBe(true);
      expect(await denied(requireWrite, { permissions: 42 })).toBe(true);
      expect(await denied(requireWrite, {})).toBe(true);
    });

    it('matches permissions exactly from an array or a delimited string', async () => {
      const requireWrite = grpcRequirePermission('users:write');
      expect(await denied(requireWrite, { permissions: ['users:read', 'users:write'] })).toBe(
        false
      );
      expect(await denied(requireWrite, { permissions: 'users:read users:write' })).toBe(false);
      expect(await denied(requireWrite, { permissions: 'users:read,users:write' })).toBe(false);
    });
  });
});
