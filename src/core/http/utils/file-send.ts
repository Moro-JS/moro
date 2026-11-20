// What the file-sending helpers (res.sendFile, res.download, res.sendRange)
// share: the Cache-Control an option set asks for, and where a path may be
// served from (`root` confinement and the dotfile policy `staticFiles` has).
import { promises as fs } from 'fs';
import * as path from 'path';
import type { SendFileOptions } from '../../../types/http.js';

export type DotfilePolicy = 'allow' | 'deny' | 'ignore';

/**
 * The `Cache-Control` value the options ask for, or undefined when they ask
 * for none (the response then keeps whatever the handler set, or goes out
 * without the header).
 *
 * `maxAge` is in seconds, as it is for `staticFiles`.
 */
export function fileCacheControl(options: SendFileOptions | undefined): string | undefined {
  if (options === undefined || options === null) return undefined;
  const { cacheControl } = options;
  if (cacheControl === false) return undefined;
  if (typeof cacheControl === 'string') return cacheControl === '' ? undefined : cacheControl;

  const maxAge = options.maxAge;
  const hasMaxAge = typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge >= 0;
  if (!hasMaxAge && cacheControl !== true) return undefined;

  const seconds = hasMaxAge ? Math.floor(maxAge as number) : 0;
  return options.immutable === true
    ? `public, max-age=${seconds}, immutable`
    : `public, max-age=${seconds}`;
}

const withSep = (dir: string): string => (dir.endsWith(path.sep) ? dir : dir + path.sep);

// A hidden segment: one that starts with a dot, other than `.well-known`
// (RFC 8615), which is meant to be served.
function isDotSegment(segment: string): boolean {
  return segment.charCodeAt(0) === 46 /* . */ && segment !== '.well-known';
}

/** True when any segment of `absolutePath` below `baseWithSep` is hidden. */
function hasDotSegmentBelow(baseWithSep: string, absolutePath: string): boolean {
  if (!absolutePath.startsWith(baseWithSep)) return false;
  for (const segment of absolutePath.slice(baseWithSep.length).split(path.sep)) {
    if (segment !== '' && isDotSegment(segment)) return true;
  }
  return false;
}

export function assertRoot(root: unknown, helper: string): asserts root is string {
  if (typeof root !== 'string' || root === '') {
    throw new TypeError(`${helper}: \`root\` must be a non-empty directory path`);
  }
}

/**
 * Where `filePath` may be served from: the path to open, `'not-found'` when
 * it is outside `root` or hidden under the `'ignore'` policy, `'forbidden'`
 * when it is hidden under `'deny'`.
 *
 * With a `root`, two containment checks. The lexical one turns `../` and
 * absolute paths away without touching the filesystem outside the root. The
 * second compares real paths, which catches a symlink inside the root that
 * points out of it; the root is resolved the same way, so it may itself be a
 * symlink (a `current` release link, `/tmp` on macOS). The trailing separator
 * matters: a bare prefix test would let `/srv/videos-private` pass for root
 * `/srv/videos`. The dotfile policy then covers every segment below the root,
 * in the path as given and in the path it resolves to, as `staticFiles` does.
 *
 * Without a `root` there is no directory to measure "below" from, so the
 * policy looks at the file's own name: the last segment of the path as given.
 *
 * Rejects (ENOENT and the like) when the path does not exist.
 */
export async function locateFile(
  filePath: string,
  root: string | undefined,
  dotfiles: DotfilePolicy
): Promise<string | 'not-found' | 'forbidden'> {
  const hiddenAnswer = dotfiles === 'deny' ? 'forbidden' : 'not-found';

  if (root === undefined) {
    if (dotfiles !== 'allow' && isDotSegment(path.basename(filePath))) return hiddenAnswer;
    return filePath;
  }
  if (typeof filePath !== 'string') return 'not-found';

  const base = path.resolve(root);
  const baseWithSep = withSep(base);
  const candidate = path.resolve(base, filePath);
  if (!candidate.startsWith(baseWithSep)) return 'not-found';
  if (dotfiles !== 'allow' && hasDotSegmentBelow(baseWithSep, candidate)) return hiddenAnswer;

  const realBase = await fs.realpath(base);
  const real = await fs.realpath(candidate);
  const realBaseWithSep = withSep(realBase);
  if (!real.startsWith(realBaseWithSep)) return 'not-found';
  if (dotfiles !== 'allow' && hasDotSegmentBelow(realBaseWithSep, real)) return hiddenAnswer;
  return real;
}
