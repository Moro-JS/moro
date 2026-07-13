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

function getCommitsSinceLastRelease() {
  try {
    // Get the last release tag
    const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    // Get commits since last tag
    const commits = execSync(`git log ${lastTag}..HEAD --oneline --no-merges`, {
      encoding: 'utf8',
    });
    return commits
      .trim()
      .split('\n')
      .filter(line => line.trim());
  } catch {
    // If no tags exist, get all commits
    const commits = execSync('git log --oneline --no-merges', { encoding: 'utf8' });
    return commits
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .slice(0, 10); // Limit to last 10 commits
  }
}

function categorizeCommits(commits) {
  const added = [];
  const changed = [];
  const fixed = [];
  const other = [];

  commits.forEach(commit => {
    const message = commit.toLowerCase();
    if (message.includes('feat:') || message.includes('add')) {
      added.push(commit);
    } else if (message.includes('fix:') || message.includes('bug') || message.includes('error')) {
      fixed.push(commit);
    } else if (
      message.includes('chore:') ||
      message.includes('refactor:') ||
      message.includes('update') ||
      message.includes('change')
    ) {
      changed.push(commit);
    } else {
      other.push(commit);
    }
  });

  return { added, changed, fixed, other };
}

function updateChangelog(newVersion, versionType) {
  const changelogPath = 'CHANGELOG.md';
  const today = new Date().toISOString().split('T')[0];

  log(`Updating CHANGELOG.md for ${newVersion} (${versionType})`, 'cyan');

  let changelog = '';
  if (fs.existsSync(changelogPath)) {
    changelog = fs.readFileSync(changelogPath, 'utf8');
  }

  // Get commits since last release
  const allCommits = getCommitsSinceLastRelease();

  // Filter out release commits
  const commits = allCommits.filter(commit => {
    const lowerCommit = commit.toLowerCase();
    return !lowerCommit.includes('chore: release v');
  });

  const { added, changed, fixed, other } = categorizeCommits(commits);

  // Build changelog entry
  let newEntry = `## [${newVersion}] - ${today}\n\n`;

  if (added.length > 0) {
    newEntry += '### Added\n';
    added.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+ /, ''); // Remove commit hash
      newEntry += `- ${message}\n`;
    });
    newEntry += '\n';
  }

  if (changed.length > 0) {
    newEntry += '### Changed\n';
    changed.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+ /, ''); // Remove commit hash
      newEntry += `- ${message}\n`;
    });
    newEntry += '\n';
  }

  if (fixed.length > 0) {
    newEntry += '### Fixed\n';
    fixed.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+ /, ''); // Remove commit hash
      newEntry += `- ${message}\n`;
    });
    newEntry += '\n';
  }

  if (other.length > 0) {
    newEntry += '### Other\n';
    other.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+ /, ''); // Remove commit hash
      newEntry += `- ${message}\n`;
    });
    newEntry += '\n';
  }

  // If no commits found, add a generic entry
  if (commits.length === 0) {
    newEntry += '### Maintenance\n';
    newEntry += `- Version bump to ${newVersion}\n\n`;
  }

  const updatedChangelog = newEntry + changelog;
  fs.writeFileSync(changelogPath, updatedChangelog);
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
  const meaningfulCommits = commitsSinceRelease.filter(commit => {
    const lowerCommit = commit.toLowerCase();
    return !lowerCommit.includes('chore: release v');
  });

  if (meaningfulCommits.length === 0) {
    log('❌ No commits since last release. Nothing to release.', 'red');
    log('Last release tag was already created for the current state.', 'yellow');
    log('Make some changes first before creating a new release.', 'yellow');
    process.exit(1);
  }

  log(`✅ Found ${meaningfulCommits.length} commit(s) since last release`, 'green');
  meaningfulCommits.slice(0, 5).forEach(commit => {
    log(`   - ${commit}`, 'cyan');
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

main();
