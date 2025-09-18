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

function updatePackageJson(newVersion) {
    const packagePath = 'package.json';
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.version = newVersion;
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
}

function getCommitsSinceLastRelease() {
    try {
        // Get the last release tag
        const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
        // Get commits since last tag
        const commits = execSync(`git log ${lastTag}..HEAD --oneline --no-merges`, { encoding: 'utf8' });
        return commits.trim().split('\n').filter(line => line.trim());
    } catch (error) {
        // If no tags exist, get all commits
        const commits = execSync('git log --oneline --no-merges', { encoding: 'utf8' });
        return commits.trim().split('\n').filter(line => line.trim()).slice(0, 10); // Limit to last 10 commits
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
        } else if (message.includes('chore:') || message.includes('refactor:') || message.includes('update') || message.includes('change')) {
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

    let changelog = '';
    if (fs.existsSync(changelogPath)) {
        changelog = fs.readFileSync(changelogPath, 'utf8');
    }

    // Get commits since last release
    const commits = getCommitsSinceLastRelease();
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
    const versionType = process.argv[2] || 'patch';

    if (!['major', 'minor', 'patch'].includes(versionType)) {
        log('❌ Invalid version type. Use: major, minor, or patch', 'red');
        process.exit(1);
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

    // Step 2: Run tests
    log('\n🧪 Step 2: Running tests', 'blue');
    exec('npm test');
    log('✅ All tests passed', 'green');

    // Step 3: Run linting
    log('\n🔍 Step 3: Running linting', 'blue');
    exec('npm run lint');
    log('✅ Linting passed', 'green');

    // Step 4: Update version
    log('\n📝 Step 4: Updating version', 'blue');
    const { currentVersion, newVersion } = updateVersion(versionType);
    log(`Version: ${currentVersion} → ${newVersion}`, 'cyan');
    updatePackageJson(newVersion);
    log('✅ Version updated', 'green');

    // Step 5: Update CHANGELOG
    log('\n📋 Step 5: Updating CHANGELOG.md', 'blue');
    updateChangelog(newVersion, versionType);
    log('✅ CHANGELOG updated', 'green');

    // Step 6: Build project
    log('\n🔨 Step 6: Building project', 'blue');
    exec('npm run build');
    log('✅ Project built successfully', 'green');

    // Step 7: Commit changes
    log('\n💾 Step 7: Committing changes', 'blue');
    exec(`git add .`);
    exec(`git commit -m "chore: release v${newVersion}"`);
    log('✅ Changes committed', 'green');

    // Step 8: Create git tag
    log('\n🏷️  Step 8: Creating git tag', 'blue');
    exec(`git tag v${newVersion}`);
    log('✅ Git tag created', 'green');

    // Step 9: Push to GitHub
    log('\n📤 Step 9: Pushing to GitHub', 'blue');
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
    log('1. Create GitHub release at the URL above', 'yellow');
    log('2. Publish to npm: npm publish', 'yellow');
    log('3. Verify the release on npm and GitHub', 'yellow');
    log('4. Announce the release on social media/community channels', 'yellow');
}

main();
