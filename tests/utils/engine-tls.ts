 
// Shared by the integration suites about the engine's TLS library
// (server.ssl.library, app.engine.tls). The library is chosen when the
// engine's binary is loaded, once per test file, so each case that needs a
// different one lives in a file of its own.
import { createRequire } from 'module';
import { createApp } from '../../src/index.js';
import { createTestPort } from '../setup.js';

const require_ = createRequire(__filename);

/**
 * True when the installed @morojs/engine ships two TLS libraries (1.1.20+).
 * Asked with `in`, which does not load the engine's binary: loading it here
 * would make the choice before the app under test could.
 */
export function engineHasTlsLibraries(): boolean {
  try {
    const engine = require_('@morojs/engine');
    return 'selectTls' in engine;
  } catch {
    return false;
  }
}

export async function bootTlsApp(ssl: Record<string, any>, server: Record<string, any> = {}) {
  const port = createTestPort();
  const app: any = await createApp({
    logger: { level: 'fatal' },
    server: { engine: 'moro', ssl, ...server },
  });
  app.get('/who', (req: any) => ({ secure: req.secure }));
  await new Promise<void>(resolve => app.listen(port, () => resolve()));
  return { app, port };
}
