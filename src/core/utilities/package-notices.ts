// Optional packages the framework still loads at versions that carry a
// published advisory. Such a package keeps working: the application is told
// once, when the package is first loaded, what the problem is and which
// version to move to. Nothing here runs unless the package is loaded.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('Dependencies');

type Version = readonly [major: number, minor: number, patch: number];

/** `1.2.3`, `1.2.3-beta.1` or `v1.2.3` as numbers; undefined for anything else. */
function parseVersion(version: string): { numbers: Version; prerelease: boolean } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** Whether `version` sorts before the release `fixed` (a prerelease of `fixed` does). */
function isBefore(version: string, fixed: Version): boolean | undefined {
  const parsed = parseVersion(version);
  if (!parsed) return undefined;
  for (let i = 0; i < 3; i++) {
    const have = parsed.numbers[i] as number;
    const want = fixed[i] as number;
    if (have !== want) return have < want;
  }
  return parsed.prerelease;
}

const ZOD_FIXED: Version = [4, 6, 6];

/**
 * What to tell an application that has `packageName` installed at `version`,
 * or undefined when that version has no known problem (or is not a version
 * number at all, in which case nothing is claimed about it).
 */
export function packageNotice(packageName: string, version: string): string | undefined {
  if (packageName === 'zod') {
    if (isBefore(version, ZOD_FIXED) !== true) return undefined;
    const move = version.startsWith('3.')
      ? 'No zod 3 release has the fix: move to zod 4.6.6 or later (both majors are supported).'
      : 'Update to zod 4.6.6 or later.';
    return (
      `zod ${version} has a known problem: validating an oversized collection that has a size ` +
      `constraint can exhaust memory (GHSA-mrhx-c7xc-m3w5). ${move}`
    );
  }

  if (packageName === 'aws-sdk') {
    const parsed = parseVersion(version);
    if (!parsed || parsed.numbers[0] !== 2) return undefined;
    return (
      `aws-sdk ${version} (AWS SDK for JavaScript v2) has a known problem that no v2 release ` +
      `fixes: the region parameter is not validated (GHSA-j965-2qgj-vjmq). The CloudFront CDN ` +
      `adapter uses @aws-sdk/client-cloudfront (AWS SDK v3, 3.974.0 or later) when it is ` +
      `installed: install it and remove aws-sdk.`
    );
  }

  return undefined;
}

/**
 * The version of the package whose entry point `resolvedEntry` is: the
 * `version` of the nearest package.json above it that carries the package's
 * name. Undefined when there is none to read.
 */
export function installedVersion(packageName: string, resolvedEntry: string): string | undefined {
  let dir = dirname(resolvedEntry);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === packageName) {
        return typeof manifest.version === 'string' ? manifest.version : undefined;
      }
    } catch {
      // No manifest in this directory, or not one that can be read: look higher
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const told = new Set<string>();

/**
 * Called where the framework loads an optional package from the application:
 * logs one warning per process when the installed version has a known
 * problem. `resolvedEntry` is the path the package was loaded from.
 */
export function warnIfPackageAffected(packageName: string, resolvedEntry: string): void {
  if (told.has(packageName)) return;
  told.add(packageName);
  const version = installedVersion(packageName, resolvedEntry);
  if (version === undefined) return;
  const notice = packageNotice(packageName, version);
  if (notice !== undefined) logger.warn(notice, 'Dependencies');
}
