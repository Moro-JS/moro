// Jest stub for src/core/utilities/self-require.ts (mapped via jest.config's
// moduleNameMapper). The real module uses ESM-only `import.meta`, a load-time
// SyntaxError under ts-jest's CommonJS transform. In tests the process cwd is
// the moro repo, so anchoring to it resolves moro's own node_modules exactly as
// the real (import.meta-anchored) require does in the shipped ESM build.
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const selfRequire = createRequire(join(process.cwd(), 'package.json'));
