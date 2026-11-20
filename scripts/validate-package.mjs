#!/usr/bin/env node
// Validation script to test the package as a real user would install it
// This creates a test installation and imports using the actual package name

import { execSync } from 'child_process';
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { join, relative, resolve, isAbsolute } from 'path';
import { tmpdir } from 'os';

// Size budget for the published package, in bytes. The package is compiled
// JavaScript, declarations and source maps without embedded sources: about
// 1.1 MB packed and 5.0 MB installed. The ceilings leave room for the code to
// grow and are well below what the package weighs with sources embedded in
// the maps (1.9 MB / 7.8 MB), so that coming back fails here. Raise them on
// purpose when the code itself has outgrown them.
const MAX_PACKED_BYTES = 1_400_000;
const MAX_UNPACKED_BYTES = 6_000_000;

/** Every file under `dir`, as absolute paths. */
function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Checks the package as it was installed from the tarball: every compiled
 * file has its source map (so `node --enable-source-maps` reports the
 * original file names and line numbers), no map embeds the sources or names
 * a path on the machine that built it, and the package is within its size
 * budget. Returns the problems found, one line each.
 */
function checkShippedFiles(packageDir, packedBytes) {
  const problems = [];
  const files = filesUnder(packageDir).filter(
    file => !relative(packageDir, file).startsWith('node_modules')
  );
  const names = new Set(files);
  const shown = list =>
    list
      .slice(0, 5)
      .map(file => relative(packageDir, file))
      .join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '');

  const unmapped = files.filter(file => file.endsWith('.js') && !names.has(`${file}.map`));
  if (unmapped.length > 0) {
    problems.push(
      `${unmapped.length} compiled file(s) ship without a source map, so stack traces under ` +
        `--enable-source-maps lose the original file names and line numbers: ${shown(unmapped)}`
    );
  }

  const embedding = [];
  const absolute = [];
  let maps = 0;
  for (const file of files) {
    if (!file.endsWith('.map')) continue;
    maps++;
    const map = JSON.parse(readFileSync(file, 'utf-8'));
    if (map.sourcesContent !== undefined) embedding.push(file);
    const sources = Array.isArray(map.sources) ? map.sources : [];
    if (sources.some(source => isAbsolute(source) || /^[a-z]+:/i.test(source))) absolute.push(file);
  }
  if (embedding.length > 0) {
    problems.push(
      `${embedding.length} source map(s) embed the sources (sourcesContent); build with ` +
        `"inlineSources": false in tsconfig.json: ${shown(embedding)}`
    );
  }
  if (absolute.length > 0) {
    problems.push(
      `${absolute.length} source map(s) name an absolute path of the build machine: ${shown(absolute)}`
    );
  }

  const unpackedBytes = files.reduce((total, file) => total + statSync(file).size, 0);
  if (packedBytes > MAX_PACKED_BYTES) {
    problems.push(`the tarball is ${packedBytes} bytes; the ceiling is ${MAX_PACKED_BYTES}`);
  }
  if (unpackedBytes > MAX_UNPACKED_BYTES) {
    problems.push(
      `the installed package is ${unpackedBytes} bytes; the ceiling is ${MAX_UNPACKED_BYTES}`
    );
  }

  return { problems, files: files.length, maps, packedBytes, unpackedBytes };
}

// Set once the directory and the tarball exist, so the error path only removes
// what we created. A tarball named on the command line is the caller's: it is
// validated and left where it is.
let testDir;
let tarball;
const givenTarball = process.argv[2];

console.log('🔍 Validating package as users will consume it...\n');

try {
  // Step 1: Create test directory. mkdtempSync creates a new, uniquely named
  // directory (mode 0700) atomically, so the path cannot be predicted or
  // pre-created by another process the way tmpdir()/moro-test-<timestamp> could.
  console.log('✓ Creating test environment...');
  testDir = mkdtempSync(join(tmpdir(), 'moro-test-'));

  // Step 2: Pack the package (creates a .tgz like npm publish would), or take
  // the tarball named on the command line: the release workflow packs once
  // and publishes that same file, so that file is the one to validate.
  if (givenTarball) {
    console.log(`✓ Using ${givenTarball}\n`);
  } else {
    console.log('✓ Packing package...');
    // The tarball goes into a directory of its own and is found by listing
    // it. `npm pack` prints the file name on stdout, but so does anything a
    // lifecycle script prints (`prepare` runs on pack), so the last line of
    // that output is not always the name.
    const packDir = join(testDir, 'pack');
    mkdirSync(packDir);
    execSync(`npm pack --pack-destination "${packDir}"`, { encoding: 'utf-8' });
    const packed = readdirSync(packDir).filter(name => name.endsWith('.tgz'));
    if (packed.length !== 1) {
      throw new Error(`npm pack wrote ${packed.length} tarballs to ${packDir}, expected one`);
    }
    tarball = join(packDir, packed[0]);
    console.log(`  Created: ${packed[0]}\n`);
  }
  const tarballPath = resolve(givenTarball ?? tarball);

  // Step 3: Create a test package.json in test directory
  const testPackageJson = {
    name: 'moro-test',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@morojs/moro': `file:${tarballPath}`,
    },
  };
  writeFileSync(join(testDir, 'package.json'), JSON.stringify(testPackageJson, null, 2));

  // Step 4: Install the package. --ignore-scripts: nothing the package needs
  // comes from an install script (the engine's native binary ships as a
  // prebuilt optional dependency), so none has to run here.
  console.log('✓ Installing package...');
  execSync('npm install --silent --ignore-scripts', { cwd: testDir, stdio: 'pipe' });
  console.log('  ✅ Package installed\n');

  // Step 4b: Check what the tarball put on disk
  console.log('✓ Checking shipped files...');
  const shipped = checkShippedFiles(
    join(testDir, 'node_modules', '@morojs', 'moro'),
    statSync(tarballPath).size
  );
  console.log(
    `  ${shipped.files} files, ${shipped.maps} source maps, ` +
      `${shipped.packedBytes} bytes packed, ${shipped.unpackedBytes} bytes installed`
  );
  if (shipped.problems.length > 0) {
    throw new Error(`Shipped files:\n  - ${shipped.problems.join('\n  - ')}`);
  }
  console.log('  ✅ Source maps present without embedded sources; size within budget\n');

  // Step 5: Create test file that imports like a real user
  console.log('✓ Testing user import pattern...');
  const testFile = `
import { createApp, Moro, z } from '@morojs/moro';

// Test 1: Check exports exist
if (!createApp || typeof createApp !== 'function') {
  throw new Error('createApp is not exported correctly');
}
if (!Moro || typeof Moro !== 'function') {
  throw new Error('Moro is not exported correctly');
}
console.log('  ✅ All exports available via package name');

// Test 2: Create app instance (createApp is async — must be awaited)
const app = await createApp({ server: { port: 9998 } });
if (!app.get || !app.post || !app.listen) {
  throw new Error('App methods not available');
}
console.log('  ✅ App creation works');

// Test 3: Add a route
app.get('/test', (req, res) => res.json({ ok: true }));
console.log('  ✅ Routing works');

console.log('\\n✅ Package imports work exactly as users will use them!');
process.exit(0);
`;

  writeFileSync(join(testDir, 'test.mjs'), testFile);

  // Step 6: Run the test
  execSync('node test.mjs', { cwd: testDir, stdio: 'inherit' });

  console.log('\n📦 Package validation complete - ready for npm publish!\n');

  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });

  process.exit(0);
} catch (error) {
  console.error('\n❌ Package validation failed!');
  console.error('Error:', error.message);
  console.error('\n⚠️  DO NOT PUBLISH - Fix the package first!\n');

  // Cleanup on error
  try {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    if (tarball) rmSync(tarball, { force: true });
  } catch {
    // If the directory doesn't exist, ignore the error
  }

  process.exit(1);
}
