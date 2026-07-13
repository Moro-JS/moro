export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Isolate the ESM-only import.meta in worker-entry: ts-jest transpiles to
    // CommonJS, where import.meta is a load-time SyntaxError. Must precede the
    // generic .js->ts rule below (first match wins).
    'worker-entry\\.js$': '<rootDir>/tests/mocks/worker-entry.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          esModuleInterop: true,
          isolatedModules: true,
        },
      },
    ],
  },
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts', '**/src/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.test.ts', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'html'],
  // V8 provider (not the default babel/istanbul): istanbul instruments by
  // transforming source, which breaks `import.meta` in our ESM code and made
  // whole integration suites fail to load under --coverage. V8 uses native
  // coverage with no source transform, so ESM + import.meta works.
  coverageProvider: 'v8',
  // Ratchet floor pinned just below current actuals (statements/lines ~52%,
  // branches ~69%, functions ~43%). This gates regressions without blocking on
  // legacy gaps; raise the numbers as coverage improves, never lower them.
  coverageThreshold: {
    global: {
      statements: 49,
      branches: 66,
      functions: 40,
      lines: 49,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 15000,
  // Parallelized: jest workers are process-isolated (so the framework's global
  // singletons are per-worker), and tests/setup.ts namespaces ports per
  // JEST_WORKER_ID, so parallel workers don't collide.
  maxWorkers: '50%',
  forceExit: false,
  detectOpenHandles: true,
  openHandlesTimeout: 1000,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Memory optimization settings for CI environments
  workerIdleMemoryLimit: '512MB',
  maxConcurrency: 5,
};
