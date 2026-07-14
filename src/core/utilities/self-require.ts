// This file exists solely to isolate the ESM-only `import.meta` token (like
// worker-entry.ts): ts-jest transpiles to CommonJS, where `import.meta` is a
// load-time SyntaxError, so jest.config maps this module to a stub.
//
// `selfRequire` resolves modules relative to moro's OWN compiled location, so
// moro's `@morojs/engine` dependency loads regardless of `process.cwd()`. Without
// this, the engine silently falls back to the Node http server whenever the
// process runs from a directory other than the app root (Docker WORKDIR,
// supervisord, pm2, a subdirectory, …) — because the resolver walked up from
// the cwd instead of from where moro is installed.
import { createRequire } from 'node:module';

export const selfRequire: ReturnType<typeof createRequire> = createRequire(import.meta.url);
