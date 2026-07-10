// Shared guard for integration suites that need the native @morojs/engine
// addon. On dev machines without a built addon the suites skip silently (a
// parity test without the engine leg is meaningless locally). In CI the
// engine lane sets MORO_REQUIRE_ENGINE=1, which turns a missing addon into a
// hard suite failure instead of a silent green - the whole point of the lane
// is that these tests actually ran.
import { describe } from '@jest/globals';
import {
  loadNativeEngine,
  getNativeEngineLoadErrors,
} from '../../src/core/utilities/package-utils.js';

export const engineLoadable = loadNativeEngine() !== null;

if (!engineLoadable && process.env.MORO_REQUIRE_ENGINE === '1') {
  // Throwing at module scope makes Jest report "Test suite failed to run" -
  // a hard red with the loader's own diagnostics attached.
  throw new Error(
    'MORO_REQUIRE_ENGINE=1 but @morojs/engine did not load:\n  ' +
      (getNativeEngineLoadErrors().join('\n  ') || 'no loader diagnostics recorded')
  );
}

export const describeEngine = engineLoadable ? describe : describe.skip;
