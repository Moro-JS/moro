// Resolves the compiled worker entry (worker.js, this module's sibling in
// dist/**) relative to THIS module, so it works for any consumer of the
// published package - never a cwd-relative path (the package ships only dist/**
// and worker_threads cannot execute a .ts file).
//
// This file exists solely to isolate the ESM-only `import.meta` token. ts-jest
// transpiles the framework to CommonJS for the test runner, where a literal
// import.meta is a load-time SyntaxError; jest.config maps this module to a stub
// so WorkerManager can be imported in tests without spawning real threads.
import { fileURLToPath } from 'url';

export const WORKER_ENTRY: string = fileURLToPath(new URL('./worker.js', import.meta.url));
