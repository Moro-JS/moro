// Synchronous, lazy access to Node built-ins from ESM.
//
// `import x from 'node:x'` in an ESM package builds the built-in's ESM facade
// eagerly at import time - for node:http that pulls in http2, tls, zlib and
// worker_threads (~14 MB RSS against ~3 MB through require) - and it happens
// for every app, whether or not the code path that needs the module ever
// runs. requireBuiltin() resolves the same module object on first use, so a
// server that never clusters never loads node:cluster (which drags in
// child_process, dgram and net), one that never compresses never loads zlib,
// and so on. Built-ins are always synchronously requirable, so nothing on
// these paths becomes async. The base given to createRequire is irrelevant for
// built-ins; 'file:///' keeps this file free of import.meta so the CJS
// transform Jest applies to the test suite still compiles it.
import { createRequire } from 'module';

const req = createRequire('file:///');
const cache = new Map<string, unknown>();

export function requireBuiltin<T = unknown>(id: string): T {
  let m = cache.get(id);
  if (m === undefined) {
    m = req(id);
    cache.set(id, m);
  }
  return m as T;
}
