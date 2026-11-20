// Unit Tests - HTTP engine selection (engine: 'moro' | 'node')
//
// Default is 'moro' (Moro's native engine), with 'node' to disable it. A
// native engine that can't load on this platform/Node ABI degrades to the
// Node.js http server (never throws). Expectations adapt via moroLoadable so
// the suite is correct whether or not the engine has a prebuilt binary here.
//
// uWebSockets.js was removed in 1.8.24. The settings that selected it
// (engine: 'uws', useUWebSockets: true, MORO_SERVER_ENGINE=uws) must not
// break an app that still carries them: it boots on the Moro engine, exactly
// as with no setting, and says so once.
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createApp } from '../../../src/index.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { logger } from '../../../src/core/logger/index.js';
import {
  loadNativeEngine,
  resetNativeEngineLoaderForTesting,
} from '../../../src/core/utilities/package-utils.js';

const moroEngine = loadNativeEngine({ candidates: ['@morojs/engine'] });
const moroLoadable = moroEngine !== null;
// @morojs/engine 1.1.19 and later serve HTTP/2 themselves.
const moroServesH2 = moroEngine?.capabilities?.http2 === true;
const quiet = { logger: { level: 'fatal' as const } };

// Every warning logged while `fn` ran, as one string. Entries are read from
// an output added to the global logger (framework loggers share its outputs),
// so nothing depends on what the test setup lets through to the console.
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  logger.addOutput({
    name: 'engine-selection-capture',
    write: (entry: any) => {
      if (entry.level === 'warn') lines.push(String(entry.message));
    },
  } as any);
  try {
    const result = await fn();
    await new Promise(resolve => setTimeout(resolve, 10));
    return { result, output: lines.join('\n') };
  } finally {
    logger.removeOutput('engine-selection-capture');
    logger.setLevel('error');
  }
}

describe('HTTP engine selection', () => {
  beforeEach(() => {
    resetConfig();
    resetNativeEngineLoaderForTesting();
  });

  it("defaults to the Moro engine (Node fallback if it can't load)", async () => {
    const app = await createApp({ ...quiet });
    if (moroLoadable) {
      expect(app.engine.server).toBe('engine');
      expect(app.engine.enginePackage).toBe('@morojs/engine');
      expect(app.engine.fallbackReason).toBeUndefined();
    } else {
      expect(app.engine.server).toBe('node');
      expect(app.engine.fallbackReason).toBeDefined();
    }
    expect(app.getServerKind()).toEqual(app.engine);
  });

  it("engine: 'node' always boots the Node http server", async () => {
    const app = await createApp({ ...quiet, server: { engine: 'node' } });
    expect(app.engine.server).toBe('node');
    expect(app.engine.fallbackReason).toBeUndefined();
  });

  it("engine: 'moro' uses @morojs/engine", async () => {
    const app = await createApp({ ...quiet, server: { engine: 'moro' } });
    if (moroLoadable) {
      expect(app.engine.server).toBe('engine');
      expect(app.engine.enginePackage).toBe('@morojs/engine');
    } else {
      expect(app.engine.server).toBe('node');
    }
  });

  // MORO_ENGINE_BINARY makes the engine load the native binary it names in
  // place of the installed one (instrumented builds, A/B runs). The engine
  // does not report where its binary came from; the framework reads the
  // variable as the engine loads and names the file whenever it names the engine.
  (moroLoadable ? it : it.skip)(
    'names the binary in its start-up lines when MORO_ENGINE_BINARY chose it',
    async () => {
      // The binary of this platform, C library and Node ABI, as installed. On
      // Linux an install can carry the glibc and the musl package side by
      // side, and only the one for this C library loads.
      const libc =
        process.platform !== 'linux'
          ? ''
          : (process.report?.getReport() as any)?.header?.glibcVersionRuntime
            ? '_gnu'
            : '_musl';
      const wanted = `moro_engine_${process.platform}_${process.arch}${libc}_${process.versions.modules}.node`;
      const scope = join(dirname(require.resolve('@morojs/engine/package.json')), '..');
      const binary = readdirSync(scope)
        .filter(name => name.startsWith('engine-'))
        .flatMap(name => readdirSync(join(scope, name)).map(file => join(scope, name, file)))
        .find(file => basename(file) === wanted) as string;
      expect(binary).toEqual(expect.any(String));

      const startUp = async (override: string | undefined) => {
        let seen: { engine: any; lines: string[] } | undefined;
        if (override === undefined) delete process.env.MORO_ENGINE_BINARY;
        else process.env.MORO_ENGINE_BINARY = override;
        try {
          // An engine of its own: it reads the variable when it loads its binary
          await jest.isolateModulesAsync(async () => {
            const moro = await import('../../../src/index.js');
            const logging = await import('../../../src/core/logger/index.js');
            const log = jest
              .spyOn(logging.MoroLogger.prototype as any, 'log')
              .mockImplementation(() => {});
            const app = await moro.createApp({ logger: { level: 'info' as const } });
            try {
              await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
              seen = {
                engine: app.engine,
                lines: log.mock.calls
                  .map(call => String(call[1]))
                  .filter(line => line.startsWith('HTTP engine:')),
              };
            } finally {
              await app.close();
              log.mockRestore();
            }
          });
        } finally {
          delete process.env.MORO_ENGINE_BINARY;
        }
        return seen as { engine: any; lines: string[] };
      };

      const overridden = await startUp(binary);
      expect(overridden.engine.server).toBe('engine');
      expect(overridden.engine.engineBinary).toBe(binary);
      expect(overridden.lines).toHaveLength(2);
      for (const line of overridden.lines) {
        expect(line).toContain(`MORO_ENGINE_BINARY=${binary}`);
      }

      const installed = await startUp(undefined);
      expect(installed.engine.server).toBe('engine');
      expect(installed.engine.engineBinary).toBeUndefined();
      expect(installed.lines).toHaveLength(2);
      expect(installed.lines.join(' ')).not.toContain('MORO_ENGINE_BINARY');
    }
  );

  describe('settings left over from uWebSockets.js (removed in 1.8.24)', () => {
    const savedEnv = process.env.MORO_SERVER_ENGINE;
    afterEach(() => {
      if (savedEnv === undefined) delete process.env.MORO_SERVER_ENGINE;
      else process.env.MORO_SERVER_ENGINE = savedEnv;
    });

    const expectTheDefaultEngine = (app: any) => {
      if (moroLoadable) {
        expect(app.engine.server).toBe('engine');
        expect(app.engine.enginePackage).toBe('@morojs/engine');
        expect(app.engine.fallbackReason).toBeUndefined();
      } else {
        expect(app.engine.server).toBe('node');
      }
    };

    it("engine: 'uws' boots on the Moro engine and says why", async () => {
      const { result: app, output } = await captureLogs(() =>
        createApp({ logger: { level: 'warn' }, server: { engine: 'uws' } } as any)
      );
      expectTheDefaultEngine(app);
      expect(output).toMatch(/server\.engine: 'uws' is no longer supported/);
      expect(output).toMatch(/uWebSockets\.js was removed from MoroJS in 1\.8\.24/);
      expect(output).toMatch(/runs on the Moro engine instead/);
    });

    it('useUWebSockets: true does the same', async () => {
      const { result: app, output } = await captureLogs(() =>
        createApp({ logger: { level: 'warn' }, server: { useUWebSockets: true } } as any)
      );
      expectTheDefaultEngine(app);
      expect(output).toMatch(/server\.useUWebSockets is no longer supported/);
    });

    it('MORO_SERVER_ENGINE=uws does the same', async () => {
      process.env.MORO_SERVER_ENGINE = 'uws';
      const { result: app, output } = await captureLogs(() =>
        createApp({ logger: { level: 'warn' } } as any)
      );
      expectTheDefaultEngine(app);
      expect(output).toMatch(/server\.engine: 'uws' is no longer supported/);
    });

    it('useUWebSockets: false is silent', async () => {
      const { result: app, output } = await captureLogs(() =>
        createApp({ logger: { level: 'warn' }, server: { useUWebSockets: false } } as any)
      );
      expectTheDefaultEngine(app);
      expect(output).not.toMatch(/no longer supported/);
    });

    it("the 'uws' WebSocket adapter name keeps the app on the engine", async () => {
      const app = await createApp({
        ...quiet,
        websocket: { enabled: true, adapter: 'uws' },
      } as any);
      expectTheDefaultEngine(app);
    });

    it('an app with none of them is not warned', async () => {
      const { output } = await captureLogs(() => createApp({ logger: { level: 'warn' } } as any));
      expect(output).not.toMatch(/uWebSockets/);
    });

    it('with http2 it is served as the default engine serves it', async () => {
      const app = await createApp({ ...quiet, http2: true, server: { engine: 'uws' } } as any);
      expect(app.engine.server).toBe(moroServesH2 ? 'engine' : 'http2');
    });
  });

  it("legacy engine: 'auto'/'native' map to 'moro'", async () => {
    for (const legacy of ['auto', 'native'] as any[]) {
      resetConfig();
      const app = await createApp({ ...quiet, server: { engine: legacy } });
      expect(app.engine.server).toBe(moroLoadable ? 'engine' : 'node');
      if (moroLoadable) expect(app.engine.enginePackage).toBe('@morojs/engine');
    }
  });

  it("engine: 'node' is honoured beside a leftover useUWebSockets", async () => {
    const app = await createApp({
      ...quiet,
      server: { engine: 'node', useUWebSockets: true },
    });
    expect(app.engine.server).toBe('node');
  });

  it('non-node runtimes gate the native engine off', async () => {
    const app = await createApp({
      ...quiet,
      server: { engine: 'moro' },
      runtime: { type: 'vercel-edge' },
    } as any);
    expect(app.engine.server).toBe('node');
    expect(app.engine.fallbackReason).toContain('vercel-edge');
  });

  it('http2 is served by the engine when it can, by the http2 server when it cannot', async () => {
    const app = await createApp({ ...quiet, http2: true } as any);
    if (moroServesH2) {
      // The engine speaks h2 and http/1.1 on the one port.
      expect(app.engine.server).toBe('engine');
      expect(app.engine.protocols).toEqual(['h2', 'http/1.1']);
    } else {
      // An engine without HTTP/2 (or none): the default engine yields to
      // the dedicated http2 server rather than dropping the opt-in.
      expect(app.engine.server).toBe('http2');
    }

    // Explicitly chosen engine wins over http2
    if (moroLoadable) {
      resetConfig();
      const engineApp = await createApp({
        ...quiet,
        http2: true,
        server: { engine: 'moro' },
      } as any);
      expect(engineApp.engine.server).toBe('engine');
      expect(engineApp.engine.protocols).toEqual(moroServesH2 ? ['h2', 'http/1.1'] : ['http/1.1']);
    }

    // engine: 'node' with http2 is always the http2 server.
    resetConfig();
    const nodeApp = await createApp({ ...quiet, http2: true, server: { engine: 'node' } } as any);
    expect(nodeApp.engine.server).toBe('http2');
    // The Node.js HTTP/2 server answers HTTP/2 streams only
    expect(nodeApp.engine.protocols).toEqual(['h2']);
  });
});
