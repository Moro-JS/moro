// The configuration file, the module directories and the route directories
// are looked up from the working directory. That is the project root when an
// application is started the usual way (`node dist/index.js` from the
// project, a container whose WORKDIR is the project). Started from somewhere
// else, the process loads whatever that directory holds, and nothing in the
// output used to say so. This module is how the loaders say it.
import { realpathSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { selfPath } from './self-require.js';

/** The physical path of `path`, or the path itself where that cannot be read. */
function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(path: string, dir: string): boolean {
  const fromDir = relative(dir, path);
  return fromDir === '' || (!fromDir.startsWith('..') && !isAbsolute(fromDir));
}

/**
 * The script the process was started with, when the application does not
 * live under `dir`; undefined when it does, which is the ordinary case.
 *
 * The application lives under `dir` when the script it was started with is
 * in it (at any depth), or when the framework it runs is installed in it:
 * the second covers a process manager or a function runtime whose own
 * bootstrap is the script (pm2 names the real one in `pm_exec_path`).
 */
export function startedOutside(dir: string): string | undefined {
  const script = process.env.pm_exec_path || process.argv[1];
  if (!script) return undefined;
  const base = physical(dir);
  const entry = physical(script);
  if (isInside(entry, base)) return undefined;
  if (selfPath && isInside(physical(selfPath), base)) return undefined;
  return entry;
}

const said = new Set<string>();

/**
 * Called by a loader that found `found` (a configuration file, a module
 * directory, a route directory) by looking in the working directory `dir`.
 * Says so once per kind, at info level, when the application does not live
 * under that directory; says nothing in the ordinary case. `pin` is how a
 * deployment names the path explicitly instead.
 */
export function foundThroughWorkingDirectory(
  logger: { info(message: string, context?: string): void },
  kind: string,
  found: string,
  dir: string,
  pin: string
): void {
  if (said.has(kind)) return;
  // A caller that was handed another directory to look in is not reading the
  // working directory
  if (physical(dir) !== physical(process.cwd())) return;
  const entry = startedOutside(dir);
  if (entry === undefined) return;
  said.add(kind);
  logger.info(
    `The ${kind} ${found} was found through the working directory (${physical(dir)}); the ` +
      `script this process runs (${entry}) is not under that directory. To load it from a ` +
      `fixed place whatever the working directory is, ${pin}.`,
    'WorkingDirectory'
  );
}
