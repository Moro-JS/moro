#!/usr/bin/env node
// Validation script to test the package as a real user would install it
// This creates a test installation and imports using the actual package name

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), 'moro-test-' + Date.now());

console.log('🔍 Validating package as users will consume it...\n');

try {
  // Step 1: Create test directory
  console.log('✓ Creating test environment...');
  mkdirSync(testDir, { recursive: true });

  // Step 2: Pack the package (creates a .tgz like npm publish would)
  console.log('✓ Packing package...');
  const packOutput = execSync('npm pack', { encoding: 'utf-8' });
  const tarball = packOutput.trim().split('\n').pop();
  console.log(`  Created: ${tarball}\n`);

  // Step 3: Create a test package.json in test directory
  const testPackageJson = {
    name: 'moro-test',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@morojs/moro': `file:${process.cwd()}/${tarball}`,
    },
  };
  writeFileSync(join(testDir, 'package.json'), JSON.stringify(testPackageJson, null, 2));

  // Step 4: Install the package
  console.log('✓ Installing package...');
  execSync('npm install --silent', { cwd: testDir, stdio: 'pipe' });
  console.log('  ✅ Package installed\n');

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
  execSync(`rm ${tarball}`);

  process.exit(0);
} catch (error) {
  console.error('\n❌ Package validation failed!');
  console.error('Error:', error.message);
  console.error('\n⚠️  DO NOT PUBLISH - Fix package exports first!\n');

  // Cleanup on error
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // If the directory doesn't exist, ignore the error
  }

  process.exit(1);
}
