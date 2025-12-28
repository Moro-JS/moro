#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, '..', 'package.json');
const MAX_ALLOWED_VERSION = 'v20.52.0';

async function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/uNetworking/uWebSockets.js/releases/latest',
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'MoroJS-Version-Checker',
      },
    };

    const req = https.request(options, res => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API error: ${res.statusCode} ${res.statusMessage}`));
            return;
          }
          const json = JSON.parse(data);
          resolve(json.tag_name);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', error => {
      reject(error);
    });

    req.end();
  }).catch(error => {
    console.error('Failed to fetch latest uWebSockets.js version:', error.message);
    return null;
  });
}

async function getCurrentVersion() {
  try {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf-8'));

    const peerDep = packageJson.peerDependencies?.['uWebSockets.js'];
    const devDep = packageJson.devDependencies?.['uWebSockets.js'];

    if (!peerDep && !devDep) {
      throw new Error('uWebSockets.js not found in dependencies');
    }

    const versionMatch = (peerDep || devDep).match(/#semver:\^?(v[\d.]+)$|#(v[\d.]+)$/);
    if (!versionMatch) {
      throw new Error('Could not parse version from dependency string');
    }

    return versionMatch[1] || versionMatch[2];
  } catch (error) {
    console.error('Failed to read current version:', error.message);
    return null;
  }
}

async function updateVersion(newVersion) {
  try {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf-8'));
    const newDependencyString = `github:uNetworking/uWebSockets.js#semver:^${newVersion}`;

    if (packageJson.peerDependencies?.['uWebSockets.js']) {
      packageJson.peerDependencies['uWebSockets.js'] = newDependencyString;
    }

    if (packageJson.devDependencies?.['uWebSockets.js']) {
      packageJson.devDependencies['uWebSockets.js'] = newDependencyString;
    }

    await writeFile(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');

    return true;
  } catch (error) {
    console.error('Failed to update package.json:', error.message);
    return false;
  }
}

function parseVersion(versionString) {
  const match = versionString.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function compareVersions(v1, v2) {
  const version1 = parseVersion(v1);
  const version2 = parseVersion(v2);

  if (!version1 || !version2) {
    return 0;
  }

  if (version1.major !== version2.major) {
    return version1.major - version2.major;
  }
  if (version1.minor !== version2.minor) {
    return version1.minor - version2.minor;
  }
  return version1.patch - version2.patch;
}

async function main() {
  const args = process.argv.slice(2);
  const autoUpdate = args.includes('--update') || args.includes('-u');
  const silent = args.includes('--silent') || args.includes('-s');

  if (!silent) {
    console.log('Checking uWebSockets.js version...\n');
  }

  const [currentVersion, latestVersion] = await Promise.all([
    getCurrentVersion(),
    fetchLatestVersion(),
  ]);

  if (!currentVersion || !latestVersion) {
    console.error('Failed to check versions');
    process.exit(1);
  }

  if (!silent) {
    console.log(`Current version: ${currentVersion}`);
    console.log(`Latest version:  ${latestVersion}`);
    console.log(`Max allowed:     ${MAX_ALLOWED_VERSION}`);
  }

  const currentVsMax = compareVersions(currentVersion, MAX_ALLOWED_VERSION);
  if (currentVsMax > 0) {
    console.error(
      `\n✗ Current version ${currentVersion} is higher than the maximum allowed version ${MAX_ALLOWED_VERSION}`
    );
    console.error(
      'Versions higher than v20.52.0 have known issues with Node.js support and threading.'
    );
    console.error(`Please downgrade to ${MAX_ALLOWED_VERSION} or lower.`);
    process.exit(1);
  }

  if (currentVersion === latestVersion) {
    if (!silent) {
      console.log('\n✓ uWebSockets.js is up to date');
    }
    process.exit(0);
  }

  const latestVsMax = compareVersions(latestVersion, MAX_ALLOWED_VERSION);

  if (latestVsMax > 0) {
    console.log(`\n⚠ New version available: ${latestVersion}`);
    console.log(
      `However, versions higher than ${MAX_ALLOWED_VERSION} have known issues with Node.js support and threading.`
    );
    console.log(`Current version ${currentVersion} is recommended. Skipping update.`);
    process.exit(0);
  }

  console.log(`\n⚠ New version available: ${latestVersion}`);

  if (autoUpdate) {
    console.log('Updating package.json...');

    const success = await updateVersion(latestVersion);

    if (success) {
      console.log('✓ Successfully updated to', latestVersion);
      console.log('\nPlease run: npm install');
      process.exit(0);
    } else {
      console.error('✗ Failed to update package.json');
      process.exit(1);
    }
  } else {
    console.log('\nTo update, run:');
    console.log('  node scripts/check-uws-version.mjs --update');
    console.log('or manually update package.json and run: npm install');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
