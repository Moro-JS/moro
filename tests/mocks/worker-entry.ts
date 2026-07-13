// Jest stub for src/core/workers/worker-entry.ts (mapped via jest.config's
// moduleNameMapper). The real module uses ESM-only `import.meta`, which is a
// load-time SyntaxError under ts-jest's CommonJS transform. Tests never spawn
// real worker threads, so an empty path is sufficient to let WorkerManager
// import cleanly.
export const WORKER_ENTRY = '';
