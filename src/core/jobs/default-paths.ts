// Default locations for the job scheduler's leader lock and state file.
//
// Both live in os.tmpdir(), which is shared by every process of the user (and
// on some hosts by every user). A fixed file name there means every Moro app
// on the machine contends for one leader lock and overwrites one state file.
// The default names are therefore scoped to the application: they carry a
// short digest of the working directory, so instances of the same app started
// from the same directory still share one lock and one state file, while
// unrelated apps never collide.

import crypto from 'crypto';
import os from 'os';
import path from 'path';

/**
 * Short, stable identifier for the running application: the first 12 hex
 * characters of the SHA-256 of the working directory.
 */
export function appScopeId(cwd: string = process.cwd()): string {
  return crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

/**
 * Default leader-election lock file: `<tmpdir>/moro-jobs-leader-<scope>.lock`
 */
export function defaultLeaderLockPath(): string {
  return path.join(os.tmpdir(), `moro-jobs-leader-${appScopeId()}.lock`);
}

/**
 * Default job state file: `<tmpdir>/moro-jobs-state-<scope>.json`
 */
export function defaultJobStatePath(): string {
  return path.join(os.tmpdir(), `moro-jobs-state-${appScopeId()}.json`);
}
