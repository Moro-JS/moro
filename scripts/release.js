#!/usr/bin/env node

/**
 * MoroJS Release Script
 *
 * This script handles the complete release process:
 * 1. Runs tests and linting
 * 2. Updates version numbers
 * 3. Updates CHANGELOG.md
 * 4. Creates git tag
 * 5. Builds and prepares for GitHub release
 * 6. Pushes to GitHub
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { pathToFileURL } from 'url';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  try {
    return execSync(command, {
      stdio: 'inherit',
      encoding: 'utf8',
      ...options,
    });
  } catch (error) {
    log(`❌ Command failed: ${command}`, 'red');
    log(`Error: ${error.message}`, 'red');
    process.exit(1);
  }
}

function getCurrentVersion() {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  return packageJson.version;
}

function updateVersion(versionType) {
  const currentVersion = getCurrentVersion();
  const [major, minor, patch] = currentVersion.split('.').map(Number);

  let newVersion;
  switch (versionType) {
    case 'major':
      newVersion = `${major + 1}.0.0`;
      break;
    case 'minor':
      newVersion = `${major}.${minor + 1}.0`;
      break;
    case 'patch':
      newVersion = `${major}.${minor}.${patch + 1}`;
      break;
    default:
      throw new Error(`Invalid version type: ${versionType}`);
  }

  return { currentVersion, newVersion };
}

// Enforce semver: a breaking change must go out as a MAJOR release. Scans the
// commit messages since the last tag for conventional-commits breaking markers
// (`type!:` or a `BREAKING CHANGE` note) and refuses a patch/minor bump.
function assertSemverForBreakingChanges(versionType) {
  let commits = '';
  try {
    const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    commits = execSync(`git log ${lastTag}..HEAD --format=%B`, { encoding: 'utf8' });
  } catch {
    commits = execSync('git log --format=%B', { encoding: 'utf8' });
  }
  const hasBreaking = /(^|\n)\s*\w+(\([^)]*\))?!:/.test(commits) || /BREAKING CHANGE/.test(commits);
  if (hasBreaking && versionType !== 'major') {
    log('\n❌ Breaking-change commits detected since the last release, but the', 'red');
    log(`   requested bump is "${versionType}". A breaking change requires a MAJOR bump.`, 'red');
    log('   Re-run with `major`, or drop the breaking change.', 'red');
    log('   Policy: anything marked breaking (a `!` commit or a Breaking heading)', 'red');
    log('   must bump the major version.', 'red');
    process.exit(1);
  }
}

function updatePackageJson(newVersion) {
  const packagePath = 'package.json';
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.version = newVersion;
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
}

function updatePackageLockJson(newVersion) {
  const packageLockPath = 'package-lock.json';

  if (!fs.existsSync(packageLockPath)) {
    return;
  }

  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  packageLock.version = newVersion;

  if (packageLock.packages && packageLock.packages['']) {
    packageLock.packages[''].version = newVersion;
  }

  fs.writeFileSync(packageLockPath, JSON.stringify(packageLock, null, 2) + '\n');
}

// ===== Commits -> changelog =====
//
// Every commit message since the last tag, whole. `git log --oneline` used to
// feed this, so only a subject line ever reached CHANGELOG.md: a body written
// as changelog sections was dropped, and a commit whose subject was itself
// "### Added" became the release's only bullet.

const COMMIT_SEPARATOR = '\x1e';
const TRAILER_LINE = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Acked-by):/i;
// Keep a Changelog order; a section a commit names beyond these follows them.
const SECTION_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Other'];
const SECTION_HEADING = /^#{2,4}\s+(.+?)\s*$/;
const BULLET_LINE = /^[-*]\s+(.*)$/;

// { subject, body } from one raw message: trailers dropped, surrounding blank
// lines trimmed, body = the lines after the subject with paragraphs intact.
function parseCommitMessage(raw) {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => !TRAILER_LINE.test(line));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return null;
  const body = lines.slice(1);
  while (body.length && body[0].trim() === '') body.shift();
  return { subject: lines[0].trim(), body };
}

function getCommitsSinceLastRelease() {
  let raw;
  let limit = Infinity;
  try {
    const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    raw = execSync(`git log ${lastTag}..HEAD --no-merges --format=%B%x1e`, { encoding: 'utf8' });
  } catch {
    // No tags yet: every commit, capped as before
    raw = execSync('git log --no-merges --format=%B%x1e', { encoding: 'utf8' });
    limit = 10;
  }
  return raw.split(COMMIT_SEPARATOR).map(parseCommitMessage).filter(Boolean).slice(0, limit);
}

// The section a plain commit lands in, decided by its subject only - a body
// mentions "add" or "fix" far too easily to be used for this.
function sectionForSubject(subject) {
  const message = subject.toLowerCase();
  if (message.includes('feat:') || message.includes('add')) return 'Added';
  if (message.includes('fix:') || message.includes('bug') || message.includes('error')) {
    return 'Fixed';
  }
  if (
    message.includes('chore:') ||
    message.includes('refactor:') ||
    message.includes('update') ||
    message.includes('change')
  ) {
    return 'Changed';
  }
  return 'Other';
}

function canonicalSection(name) {
  return SECTION_ORDER.find(known => known.toLowerCase() === name.toLowerCase()) ?? name;
}

// One bullet: its first line, then the rest indented so markdown keeps the
// continuation lines (and paragraph breaks) inside the bullet.
function formatItem(first, rest) {
  const tail = [...rest];
  while (tail.length && tail[tail.length - 1].trim() === '') tail.pop();
  const out = [`- ${first}`];
  for (const line of tail) out.push(line.trim() === '' ? '' : `  ${line.trim()}`);
  return out.join('\n');
}

// Map of section name -> bullets. A message written as changelog sections
// ("### Fixed" followed by "- ..." bullets, anywhere in subject or body) is
// taken as written, each of its sections into the entry's matching section;
// any summary line above its first heading is not repeated. Every other
// message is one bullet: the subject, with the body lines under it.
function categorizeCommits(commits) {
  const sections = new Map();
  const add = (name, item) => {
    const key = canonicalSection(name);
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(item);
  };

  for (const { subject, body } of commits) {
    const lines = [subject, ...body];
    if (!lines.some(line => SECTION_HEADING.test(line))) {
      add(sectionForSubject(subject), formatItem(subject, body));
      continue;
    }
    let current = null;
    let first = null;
    let rest = [];
    const flush = () => {
      if (first !== null) add(current, formatItem(first, rest));
      first = null;
      rest = [];
    };
    for (const line of lines) {
      const heading = line.match(SECTION_HEADING);
      if (heading) {
        flush();
        current = heading[1];
        continue;
      }
      if (current === null) continue;
      const bullet = line.match(BULLET_LINE);
      if (bullet) {
        flush();
        first = bullet[1];
        continue;
      }
      if (first === null) {
        if (line.trim() !== '') first = line.trim();
        continue;
      }
      rest.push(line);
    }
    flush();
  }
  return sections;
}

function buildChangelogEntry(newVersion, today, sections) {
  let entry = `## [${newVersion}] - ${today}\n\n`;
  const names = [
    ...SECTION_ORDER.filter(name => sections.has(name)),
    ...[...sections.keys()].filter(name => !SECTION_ORDER.includes(name)),
  ];
  let wrote = false;
  for (const name of names) {
    const items = sections.get(name);
    if (!items || items.length === 0) continue;
    entry += `### ${name}\n\n${items.join('\n')}\n\n`;
    wrote = true;
  }
  if (!wrote) {
    entry += `### Maintenance\n\n- Version bump to ${newVersion}\n\n`;
  }
  return entry;
}

function isReleaseCommit(commit) {
  return commit.subject.toLowerCase().includes('chore: release v');
}

function updateChangelog(newVersion, versionType) {
  const changelogPath = 'CHANGELOG.md';
  const today = new Date().toISOString().split('T')[0];

  log(`Updating CHANGELOG.md for ${newVersion} (${versionType})`, 'cyan');

  let changelog = '';
  if (fs.existsSync(changelogPath)) {
    changelog = fs.readFileSync(changelogPath, 'utf8');
  }

  const commits = getCommitsSinceLastRelease().filter(commit => !isReleaseCommit(commit));
  const newEntry = buildChangelogEntry(newVersion, today, categorizeCommits(commits));
  fs.writeFileSync(changelogPath, newEntry + changelog);

  // The entry is hand-shaped markdown; let prettier settle its spacing.
  try {
    execSync('npx prettier --write CHANGELOG.md', { stdio: 'ignore' });
  } catch {
    // formatting is a nicety, not a gate
  }
}

function main() {
  const args = process.argv.slice(2);
  const skipTests = args.includes('--skip-tests');

  // Check for custom version
  const versionArgIndex = args.findIndex(arg => arg.startsWith('--version='));
  let customVersion = null;
  let versionType = 'patch';

  if (versionArgIndex !== -1) {
    customVersion = args[versionArgIndex].split('=')[1];
    if (!customVersion || !/^\d+\.\d+\.\d+$/.test(customVersion)) {
      log('❌ Invalid version format. Use: --version=1.2.3', 'red');
      process.exit(1);
    }
  } else {
    versionType = args.find(arg => ['major', 'minor', 'patch'].includes(arg)) || 'patch';
    if (!['major', 'minor', 'patch'].includes(versionType)) {
      log('❌ Invalid version type. Use: major, minor, patch, or --version=X.Y.Z', 'red');
      process.exit(1);
    }
  }

  log('🚀 MoroJS Pre-Release Process', 'bright');
  log('=============================', 'bright');

  // Step 1: Check for uncommitted changes
  log('\n🔍 Step 1: Checking for uncommitted changes', 'blue');
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    if (status.trim()) {
      log('❌ You have uncommitted changes. Please commit or stash them first.', 'red');
      log('Uncommitted files:', 'yellow');
      console.log(status);
      process.exit(1);
    }
  } catch {
    // Git not available or not a git repo
  }
  log('✅ No uncommitted changes', 'green');

  // Step 2: Check for commits since last release
  log('\n🔍 Step 2: Checking for commits since last release', 'blue');
  const commitsSinceRelease = getCommitsSinceLastRelease();

  // Filter out release commits (commits that are just version bumps)
  const meaningfulCommits = commitsSinceRelease.filter(commit => !isReleaseCommit(commit));

  if (meaningfulCommits.length === 0) {
    log('❌ No commits since last release. Nothing to release.', 'red');
    log('Last release tag was already created for the current state.', 'yellow');
    log('Make some changes first before creating a new release.', 'yellow');
    process.exit(1);
  }

  log(`✅ Found ${meaningfulCommits.length} commit(s) since last release`, 'green');
  meaningfulCommits.slice(0, 5).forEach(commit => {
    log(`   - ${commit.subject}`, 'cyan');
  });
  if (meaningfulCommits.length > 5) {
    log(`   ... and ${meaningfulCommits.length - 5} more`, 'cyan');
  }

  // Step 3: Run tests
  if (skipTests) {
    log('\n🧪 Step 3: Skipping tests (--skip-tests)', 'yellow');
  } else {
    log('\n🧪 Step 3: Running tests', 'blue');
    exec('npm test');
    log('✅ All tests passed', 'green');
  }

  // Step 3.5: Run coverage tests
  if (skipTests) {
    log('\n📊 Step 3.5: Skipping coverage tests (--skip-tests)', 'yellow');
  } else {
    log('\n📊 Step 3.5: Running coverage tests', 'blue');
    exec('npm run test:coverage');
    log('✅ Coverage tests passed', 'green');
  }

  // Step 4: Run package validation tests
  if (skipTests) {
    log('\n📦 Step 4: Skipping package validation (--skip-tests)', 'yellow');
  } else {
    log('\n📦 Step 4: Running package validation', 'blue');
    exec('npm run test:package');
    log('✅ Package validation passed', 'green');
  }

  // Step 5: Run linting
  if (skipTests) {
    log('\n🔍 Step 5: Skipping linting (--skip-tests)', 'yellow');
  } else {
    log('\n🔍 Step 5: Running linting', 'blue');
    exec('npm run lint');
    log('✅ Linting passed', 'green');
  }

  // Step 6: Update version
  log('\n📝 Step 6: Updating version', 'blue');
  let currentVersion, newVersion;

  if (customVersion) {
    currentVersion = getCurrentVersion();
    newVersion = customVersion;
    log(`Version: ${currentVersion} → ${newVersion} (custom)`, 'cyan');
    updatePackageJson(newVersion);
    updatePackageLockJson(newVersion);
  } else {
    // Semver policy: a breaking change must bump major. Refuse to cut a
    // patch/minor when the commits since the last tag contain breaking markers.
    assertSemverForBreakingChanges(versionType);
    const versions = updateVersion(versionType);
    currentVersion = versions.currentVersion;
    newVersion = versions.newVersion;
    log(`Version: ${currentVersion} → ${newVersion}`, 'cyan');
    updatePackageJson(newVersion);
    updatePackageLockJson(newVersion);
  }
  log('✅ Version updated', 'green');

  // Step 7: Update CHANGELOG
  log('\n📋 Step 7: Updating CHANGELOG.md', 'blue');
  updateChangelog(newVersion, versionType);
  log('✅ CHANGELOG updated', 'green');

  // Step 8: Build project
  log('\n🔨 Step 8: Building project', 'blue');
  exec('npm run build');
  log('✅ Project built successfully', 'green');

  // Step 9: Commit changes
  log('\n💾 Step 9: Committing changes', 'blue');
  exec(`git add .`);
  exec(`git commit -m "chore: release v${newVersion}"`);
  log('✅ Changes committed', 'green');

  // Step 10: Create git tag (annotated so the tag carries author/date/message
  // and leaves an audit trail; never move a published tag - cut a new patch).
  log('\n🏷️  Step 10: Creating annotated git tag', 'blue');
  exec(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
  log('✅ Git tag created', 'green');

  // Step 11: Push to GitHub
  log('\n📤 Step 11: Pushing to GitHub', 'blue');
  exec('git push origin main');
  exec(`git push origin v${newVersion}`);
  log('✅ Pushed to GitHub', 'green');

  // Step 12: Summary
  log('\n🎉 Pre-Release Complete!', 'green');
  log('========================', 'green');
  log(`Version: ${newVersion}`, 'cyan');
  log(`Type: ${versionType}`, 'cyan');
  log(`Git tag: v${newVersion}`, 'cyan');
  log(`GitHub: https://github.com/morojs/moro/releases/tag/v${newVersion}`, 'cyan');

  log('\n📋 Next steps:', 'yellow');
  log('1. Create a GitHub release at the URL above (Publishing a release runs', 'yellow');
  log('   the CI publish job, which builds, validates the tarball, checks the', 'yellow');
  log('   tag matches package.json, and runs `npm publish --provenance`).', 'yellow');
  log('2. Do NOT run `npm publish` from a laptop - CI is the only publish path,', 'yellow');
  log('   so every published artifact carries provenance and passed the gates.', 'yellow');
  log('3. Verify the release on npm (attestations) and GitHub.', 'yellow');
  log('4. Announce the release on social media/community channels.', 'yellow');
}

// Run only when invoked as a script, so the changelog functions can be
// imported and exercised without starting a release.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  parseCommitMessage,
  getCommitsSinceLastRelease,
  categorizeCommits,
  buildChangelogEntry,
  sectionForSubject,
};
