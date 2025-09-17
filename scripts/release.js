#!/usr/bin/env node

/**
 * MoroJS Release Script
 *
 * This script handles the complete release process:
 * 1. Runs tests and linting
 * 2. Updates version numbers
 * 3. Updates CHANGELOG.md
 * 4. Creates git tag
 * 5. Builds and publishes to npm
 * 6. Pushes to GitHub
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
            ...options
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

function updateVersion(type) {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const [major, minor, patch] = packageJson.version.split('.').map(Number);

    let newVersion;
    switch (type) {
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
            throw new Error('Invalid version type. Use: major, minor, or patch');
    }

    packageJson.version = newVersion;
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
    return newVersion;
}

function updateChangelog(version, type) {
    const changelogPath = 'CHANGELOG.md';
    const changelog = fs.readFileSync(changelogPath, 'utf8');

    const today = new Date().toISOString().split('T')[0];
    const versionHeader = `## [${version}] - ${today}`;

    // Get the unreleased section content
    const unreleasedMatch = changelog.match(/## \[Unreleased\]([\s\S]*?)(?=## \[|$)/);
    const unreleasedContent = unreleasedMatch ? unreleasedMatch[1].trim() : '';

    // Create new changelog entry
    const newEntry = `${versionHeader}\n\n${unreleasedContent}\n\n`;

    // Replace [Unreleased] with the new version
    const updatedChangelog = changelog.replace(
        /## \[Unreleased\][\s\S]*?(?=## \[|$)/,
        `## [Unreleased]\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n### Removed\n- \n\n${newEntry}`
    );

    fs.writeFileSync(changelogPath, updatedChangelog);
}

function checkGitStatus() {
    const status = exec('git status --porcelain', { stdio: 'pipe' });
    if (status.trim()) {
        log('❌ Working directory is not clean. Please commit or stash changes first.', 'red');
        log('Uncommitted changes:', 'yellow');
        console.log(status);
        process.exit(1);
    }
}

function checkBranch() {
    const branch = exec('git branch --show-current', { stdio: 'pipe' }).trim();
    if (branch !== 'main' && branch !== 'master') {
        log(`❌ Not on main branch. Current branch: ${branch}`, 'red');
        log('Please switch to main branch before releasing.', 'yellow');
        process.exit(1);
    }
}

function main() {
    const args = process.argv.slice(2);
    const versionType = args[0];

    if (!versionType || !['major', 'minor', 'patch'].includes(versionType)) {
        log('Usage: node scripts/release.js <major|minor|patch>', 'red');
        log('Example: node scripts/release.js patch', 'yellow');
        process.exit(1);
    }

    log('🚀 Starting MoroJS Release Process', 'cyan');
    log('=====================================', 'cyan');

    // Step 1: Pre-release checks
    log('\n📋 Step 1: Pre-release checks', 'blue');
    checkGitStatus();
    checkBranch();

    const currentVersion = getCurrentVersion();
    log(`Current version: ${currentVersion}`, 'green');

    // Step 2: Run tests and linting
    log('\n🧪 Step 2: Running tests and linting', 'blue');
    exec('npm test');
    exec('npm run lint');
    log('✅ All tests passed and linting completed', 'green');

    // Step 3: Update version
    log('\n📦 Step 3: Updating version', 'blue');
    const newVersion = updateVersion(versionType);
    log(`Version updated: ${currentVersion} → ${newVersion}`, 'green');

    // Step 4: Update CHANGELOG
    log('\n📝 Step 4: Updating CHANGELOG.md', 'blue');
    updateChangelog(newVersion, versionType);
    log('✅ CHANGELOG.md updated', 'green');

    // Step 5: Build
    log('\n🔨 Step 5: Building project', 'blue');
    exec('npm run build');
    log('✅ Build completed', 'green');

    // Step 6: Commit changes
    log('\n💾 Step 6: Committing changes', 'blue');
    exec(`git add package.json CHANGELOG.md`);
    exec(`git commit -m "chore: release v${newVersion}"`);
    log('✅ Changes committed', 'green');

    // Step 7: Create git tag
    log('\n🏷️  Step 7: Creating git tag', 'blue');
    exec(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
    log(`✅ Git tag v${newVersion} created`, 'green');

    // Step 8: Prepare for GitHub release (skip npm publish)
    log('\n📤 Step 8: Preparing for GitHub release', 'blue');
    if (process.env.NPM_PUBLISH_DRY_RUN) {
        log('ℹ️  Dry run mode - skipping npm publish', 'yellow');
    } else {
        log('ℹ️  Skipping npm publish - use GitHub releases for publishing', 'yellow');
        log('   Run: npm publish after GitHub release is created', 'yellow');
    }

    // Step 9: Push to GitHub
    log('\n🌐 Step 9: Pushing to GitHub', 'blue');
    exec('git push origin main');
    exec(`git push origin v${newVersion}`);
    log('✅ Pushed to GitHub', 'green');

    // Step 10: Summary
    log('\n🎉 Pre-Release Complete!', 'green');
    log('========================', 'green');
    log(`Version: ${newVersion}`, 'cyan');
    log(`Type: ${versionType}`, 'cyan');
    log(`Git tag: v${newVersion}`, 'cyan');
    log(`GitHub: https://github.com/morojs/moro/releases/tag/v${newVersion}`, 'cyan');

    log('\n📋 Next steps:', 'yellow');
    log('1. Create GitHub release at: https://github.com/morojs/moro/releases/new', 'yellow');
    log('2. Select tag v' + newVersion + ' and publish the release', 'yellow');
    log('3. GitHub Actions will automatically publish to npm', 'yellow');
    log('4. Verify the release on npm: https://www.npmjs.com/package/@morojs/moro', 'yellow');
    log('5. Announce the release on social media/community channels', 'yellow');
}

if (require.main === module) {
    main();
}

module.exports = { main, updateVersion, updateChangelog };
