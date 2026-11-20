// Finds the files module auto-discovery loads, and puts them in order.
//
// One walk of the directory tree answers on every Node.js version, operating
// system and file system, so an application registers its modules in the same
// order on a laptop, in CI and in production. Nothing here depends on the
// order a directory is listed in, on the platform's own globbing, or on
// whether the file system tells `Index.js` from `index.js`.
//
// Patterns are matched against the path below the directory being scanned,
// with `/` between segments:
//
//   *        any run of characters inside one segment
//   ?        one character inside one segment
//   [abc]    one of the characters (ranges `a-z`; `[!abc]` for none of them)
//   {a,b}    either alternative (they nest)
//   **       as a whole segment: any number of directories, none included
//
// Matching is case-sensitive everywhere. A file or directory whose name
// starts with a dot is matched only by a segment that starts with a dot
// itself. A symbolic link to a file is a file; a symbolic link to a directory
// is entered only when the pattern names it literally, never through `*` or
// `**`.

import { readdirSync, statSync, type Dirent } from 'fs';
import { join } from 'path';

type Segment =
  | { kind: 'globstar' }
  | { kind: 'up' }
  | { kind: 'literal'; name: string }
  | { kind: 'magic'; test: RegExp };

/**
 * Orders two paths the way discovered files are ordered: segment by segment
 * (split at `/`), each pair of segments by UTF-16 code unit, which is what
 * `<` does on strings. No locale takes part, upper case comes before lower
 * case, and a path comes before the paths beneath it.
 */
export function compareModulePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const l = left[i] as string;
    const r = right[i] as string;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

/** Orders names (of one directory) by UTF-16 code unit. */
export function compareNames(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** `{a,b}` alternatives written out: every pattern the braces stand for. */
function expandBraces(pattern: string): string[] {
  let depth = 0;
  let open = -1;
  let commas: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '{') {
      if (depth === 0) {
        open = i;
        commas = [];
      }
      depth++;
    } else if (char === ',' && depth === 1) {
      commas.push(i);
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth > 0) continue;
      // Braces without a comma are ordinary characters
      if (commas.length === 0) continue;
      const head = pattern.slice(0, open);
      const tail = pattern.slice(i + 1);
      const bounds = [open, ...commas, i];
      const expanded: string[] = [];
      for (let b = 0; b < bounds.length - 1; b++) {
        const alternative = pattern.slice((bounds[b] as number) + 1, bounds[b + 1]);
        expanded.push(...expandBraces(head + alternative + tail));
      }
      return expanded;
    }
  }
  return [pattern];
}

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/;

/** One path segment of a pattern (braces already expanded). */
function parseSegment(segment: string): Segment {
  if (segment === '**') return { kind: 'globstar' };
  if (segment === '..') return { kind: 'up' };
  let source = '';
  let magic = false;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string;
    if (char === '*') {
      magic = true;
      source += '[^/]*';
      // `**` inside a segment is one `*`
      while (segment[i + 1] === '*') i++;
    } else if (char === '?') {
      magic = true;
      source += '[^/]';
    } else if (char === '[') {
      // A set runs to the next `]`; one right after `[` or `[!` is a member
      let end = i + 1;
      if (segment[end] === '!' || segment[end] === '^') end++;
      if (segment[end] === ']') end++;
      while (end < segment.length && segment[end] !== ']') end++;
      if (end >= segment.length) {
        source += '\\[';
        continue;
      }
      let members = segment.slice(i + 1, end);
      let negated = false;
      if (members[0] === '!' || members[0] === '^') {
        negated = true;
        members = members.slice(1);
      }
      magic = true;
      source += `[${negated ? '^' : ''}${members.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else {
      source += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
    }
  }
  if (!magic) return { kind: 'literal', name: segment };
  // A name that starts with a dot is matched only by a pattern that does
  const dotGuard = segment.startsWith('.') ? '' : '(?!\\.)';
  return { kind: 'magic', test: new RegExp(`^${dotGuard}${source}$`) };
}

function parsePattern(pattern: string): Segment[] {
  const segments: Segment[] = [];
  const posix = pattern.replace(/\\/g, '/');
  // A pattern that ends in `/` names directories, and no file
  if (posix.endsWith('/')) return segments;
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') continue;
    const segment = parseSegment(part);
    const previous = segments[segments.length - 1];
    if (segment.kind === 'globstar' && previous?.kind === 'globstar') continue;
    segments.push(segment);
  }
  // A pattern that ends in `**` names every file beneath
  if (segments[segments.length - 1]?.kind === 'globstar') {
    segments.push(parseSegment('*'));
  }
  return segments;
}

type Kind = 'file' | 'directory' | 'linked-directory' | 'other';

function kindOf(directory: string, entry: Dirent): Kind {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (!entry.isSymbolicLink()) return 'other';
  try {
    const target = statSync(join(directory, entry.name));
    if (target.isDirectory()) return 'linked-directory';
    return target.isFile() ? 'file' : 'other';
  } catch {
    // A link to nothing matches by its name, like a file: loading it then
    // fails and says which file it was
    return 'file';
  }
}

function readDirectory(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareNames(a.name, b.name)
    );
  } catch {
    // Not there, not a directory, or not readable
    return [];
  }
}

export interface FindModuleFilesOptions {
  /**
   * How many directories below the scanned one a file may be in. `0` is the
   * files of the scanned directory itself. Default: no limit.
   */
  maxDepth?: number;
}

/**
 * The files under `root` that match one of `patterns`, as paths below `root`
 * with `/` separators, without duplicates, in the order of
 * {@link compareModulePaths}.
 */
export function findModuleFiles(
  root: string,
  patterns: readonly string[],
  options: FindModuleFilesOptions = {}
): string[] {
  const maxDepth = options.maxDepth ?? Infinity;
  const found = new Set<string>();
  // Several patterns, and `**`, come back to the same directories
  const listings = new Map<string, Dirent[]>();
  const list = (directory: string): Dirent[] => {
    let entries = listings.get(directory);
    if (!entries) {
      entries = readDirectory(directory);
      listings.set(directory, entries);
    }
    return entries;
  };

  // The places one pattern has been to: with more than one `**`, the same
  // directory is reached at the same point of the pattern along several ways
  let seen = new Set<string>();

  const visit = (directory: string, below: string[], segments: Segment[], index: number): void => {
    const segment = segments[index];
    if (!segment) return;
    const place = `${index}\0${directory}`;
    if (seen.has(place)) return;
    seen.add(place);
    const last = index === segments.length - 1;

    if (segment.kind === 'up') {
      visit(join(directory, '..'), below.slice(0, -1), segments, index + 1);
      return;
    }
    if (segment.kind === 'globstar') {
      // No directory at all...
      visit(directory, below, segments, index + 1);
      // ...or one more, for as long as files down there are within the limit
      if (below.length >= maxDepth) return;
      for (const entry of list(directory)) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        visit(join(directory, entry.name), [...below, entry.name], segments, index);
      }
      return;
    }

    for (const entry of list(directory)) {
      const matches =
        segment.kind === 'literal' ? entry.name === segment.name : segment.test.test(entry.name);
      if (!matches) continue;
      const kind = kindOf(directory, entry);
      if (last) {
        if (kind === 'file' && below.length <= maxDepth) {
          found.add([...below, entry.name].join('/'));
        }
      } else if (
        kind === 'directory' ||
        (kind === 'linked-directory' && segment.kind === 'literal')
      ) {
        if (below.length >= maxDepth) continue;
        visit(join(directory, entry.name), [...below, entry.name], segments, index + 1);
      }
    }
  };

  for (const pattern of patterns) {
    for (const expanded of expandBraces(pattern)) {
      seen = new Set<string>();
      visit(root, [], parsePattern(expanded), 0);
    }
  }
  return [...found].sort(compareModulePaths);
}

/**
 * Whether a path below a scanned directory (`/` or `\` between segments)
 * matches one of `patterns`, by the rules {@link findModuleFiles} applies.
 */
export function matchesModulePattern(path: string, patterns: readonly string[]): boolean {
  const names = path.split(/[\\/]/).filter(part => part !== '' && part !== '.');
  const matchFrom = (segments: Segment[], index: number, at: number): boolean => {
    const segment = segments[index];
    if (!segment) return at === names.length;
    if (segment.kind === 'up') return false;
    if (segment.kind === 'globstar') {
      for (let skip = at; skip <= names.length; skip++) {
        if (matchFrom(segments, index + 1, skip)) return true;
        if ((names[skip] ?? '').startsWith('.')) return false;
      }
      return false;
    }
    const name = names[at];
    if (name === undefined) return false;
    const matches = segment.kind === 'literal' ? name === segment.name : segment.test.test(name);
    return matches && matchFrom(segments, index + 1, at + 1);
  };
  return patterns.some(pattern =>
    expandBraces(pattern).some(expanded => matchFrom(parsePattern(expanded), 0, 0))
  );
}
