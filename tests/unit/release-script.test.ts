// Release script: the last git tag is read and used without a shell, and only
// a release tag (vMAJOR.MINOR.PATCH...) is accepted as the start of the commit
// range. Each case runs the script's exported functions in a throwaway
// repository, in a child process whose working directory is that repository.
import { describe, it, expect, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const RELEASE_SCRIPT = pathToFileURL(resolve(process.cwd(), 'scripts/release.js')).href;

// Git variables inherited from a hook (GIT_DIR, GIT_INDEX_FILE, ...) would
// point the child processes at the surrounding repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key)));

let repo: string | undefined;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=release-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function commit(message: string): void {
  git('commit', '--allow-empty', '--no-verify', '-m', message);
}

function createRepo(): string {
  repo = mkdtempSync(join(tmpdir(), 'moro-release-'));
  git('init', '--quiet');
  return repo;
}

/** Subjects of getCommitsSinceLastRelease(), evaluated inside the repository. */
function commitsSinceLastRelease(): { status: number; subjects: string[]; stderr: string } {
  const program = `
    import { getCommitsSinceLastRelease } from ${JSON.stringify(RELEASE_SCRIPT)};
    const commits = getCommitsSinceLastRelease();
    process.stdout.write(JSON.stringify(commits.map(c => c.subject)));
  `;
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, subjects: JSON.parse(stdout), stderr: '' };
  } catch (error: any) {
    return { status: error.status ?? 1, subjects: [], stderr: String(error.stderr ?? '') };
  }
}

describe('release script: commits since the last tag', () => {
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  it('lists the commits made after the last release tag', () => {
    createRepo();
    commit('feat: first');
    git('tag', 'v1.2.3');
    commit('fix: second');
    commit('feat: third');

    const result = commitsSinceLastRelease();

    expect(result.status).toBe(0);
    expect(result.subjects.sort()).toEqual(['feat: third', 'fix: second']);
  });

  it('passes a tag holding shell metacharacters to git as one argument, never to a shell', () => {
    const dir = createRepo();
    commit('feat: first');
    // A valid git tag name that a shell would split into three commands
    git('tag', 'v1.2.3;touch${IFS}shell-ran;echo${IFS}');
    commit('fix: second');

    const result = commitsSinceLastRelease();

    expect(existsSync(join(dir, 'shell-ran'))).toBe(false);
    expect(readdirSync(dir).filter(name => name !== '.git')).toEqual([]);
    expect(result.status).toBe(0);
    expect(result.subjects).toEqual(['fix: second']);
  });

  it('refuses a last tag that is not a release tag', () => {
    const dir = createRepo();
    commit('feat: first');
    git('tag', 'nightly;touch${IFS}shell-ran');
    commit('fix: second');

    const result = commitsSinceLastRelease();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not a release tag');
    expect(existsSync(join(dir, 'shell-ran'))).toBe(false);
  });
});

describe('release script: what the release commit contains', () => {
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  /** Run stageReleaseFiles() and filesLeftOutOfRelease() inside the repository. */
  function stage(): { staged: string[]; leftOut: string[] } {
    const program = `
      import { stageReleaseFiles, filesLeftOutOfRelease } from ${JSON.stringify(RELEASE_SCRIPT)};
      const staged = stageReleaseFiles();
      process.stdout.write(JSON.stringify({ staged, leftOut: filesLeftOutOfRelease() }));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  }

  const indexPaths = () =>
    git('diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();

  it('stages the version files and the changelog, and nothing else in the tree', () => {
    const dir = createRepo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(dir, 'package-lock.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '--no-verify', '-m', 'feat: first');

    // What a release writes
    writeFileSync(join(dir, 'package.json'), '{"version":"1.0.1"}\n');
    writeFileSync(join(dir, 'package-lock.json'), '{"version":"1.0.1"}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1\n');
    // What the steps before the commit can leave behind
    writeFileSync(join(dir, 'morojs-moro-1.0.1.tgz'), 'tarball');
    writeFileSync(join(dir, 'notes.txt'), 'scratch');
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const edited = true;\n');

    const result = stage();

    expect(result.staged).toEqual(['package.json', 'package-lock.json', 'CHANGELOG.md']);
    expect(indexPaths()).toEqual(['CHANGELOG.md', 'package-lock.json', 'package.json']);
    expect(result.leftOut.sort()).toEqual(['morojs-moro-1.0.1.tgz', 'notes.txt', 'src/index.ts']);
  });

  it('works in a project without a lockfile', () => {
    const dir = createRepo();
    writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
    git('add', '.');
    git('commit', '--no-verify', '-m', 'feat: first');
    writeFileSync(join(dir, 'package.json'), '{"version":"1.0.1"}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1\n');

    const result = stage();

    expect(result.staged).toEqual(['package.json', 'CHANGELOG.md']);
    expect(indexPaths()).toEqual(['CHANGELOG.md', 'package.json']);
    expect(result.leftOut).toEqual([]);
  });
});
