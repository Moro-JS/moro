// Unit Tests - HTTP engine selection (engine: 'moro' | 'node' | 'uws')
//
// Default is 'moro' (Moro's native engine), with 'node' to disable it and
// 'uws' to opt into uWebSockets.js. A chosen native engine that can't load on
// this platform/Node ABI degrades to the Node.js http server (never throws).
// Expectations adapt via moroLoadable / uwsLoadable so the suite is correct
// whether or not each engine has a prebuilt binary here.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { createApp } from '../../../src/index.js';
import { resetConfig } from '../../../src/core/config/index.js';
import {
  loadNativeEngine,
  resetNativeEngineLoaderForTesting,
} from '../../../src/core/utilities/package-utils.js';

const moroEngine = loadNativeEngine({ candidates: ['@morojs/engine'] });
const moroLoadable = moroEngine !== null;
// @morojs/engine 1.1.19 and later serve HTTP/2 themselves.
const moroServesH2 = moroEngine?.capabilities?.http2 === true;
const uwsLoadable = loadNativeEngine({ candidates: ['uWebSockets.js'] }) !== null;
const quiet = { logger: { level: 'fatal' as const } };

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

  it("engine: 'moro' uses @morojs/engine (never falls to uWS)", async () => {
    const app = await createApp({ ...quiet, server: { engine: 'moro' } });
    if (moroLoadable) {
      expect(app.engine.server).toBe('engine');
      expect(app.engine.enginePackage).toBe('@morojs/engine');
    } else {
      expect(app.engine.server).toBe('node');
    }
  });

  it("engine: 'uws' opts into uWebSockets.js (never uses the Moro engine)", async () => {
    const app = await createApp({ ...quiet, server: { engine: 'uws' } });
    if (uwsLoadable) {
      expect(app.engine.server).toBe('engine');
      expect(app.engine.enginePackage).toBe('uWebSockets.js');
    } else {
      expect(app.engine.server).toBe('node');
    }
  });

  it('deprecated useUWebSockets: true opts into uws', async () => {
    const app = await createApp({ ...quiet, server: { useUWebSockets: true } });
    if (uwsLoadable) {
      expect(app.engine.server).toBe('engine');
      expect(app.engine.enginePackage).toBe('uWebSockets.js');
    } else {
      expect(app.engine.server).toBe('node');
    }
  });

  it("legacy engine: 'auto'/'native' map to 'moro'", async () => {
    for (const legacy of ['auto', 'native'] as any[]) {
      resetConfig();
      const app = await createApp({ ...quiet, server: { engine: legacy } });
      expect(app.engine.server).toBe(moroLoadable ? 'engine' : 'node');
      if (moroLoadable) expect(app.engine.enginePackage).toBe('@morojs/engine');
    }
  });

  it('explicit engine option outranks useUWebSockets', async () => {
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
  });
});
