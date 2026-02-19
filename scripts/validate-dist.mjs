#!/usr/bin/env node
// Validation script to ensure the built dist/ output works correctly with Node.js ESM
// This runs the actual compiled JavaScript to catch any ESM issues before release

console.log('🔍 Validating built distribution...\n');

try {
  // Test 1: Import the main module
  console.log('✓ Testing module import...');
  const moroModule = await import('../dist/index.js');

  if (!moroModule.createApp || typeof moroModule.createApp !== 'function') {
    throw new Error('createApp export is missing or invalid');
  }
  if (!moroModule.Moro || typeof moroModule.Moro !== 'function') {
    throw new Error('Moro export is missing or invalid');
  }
  console.log(`  ✅ Main exports present (${Object.keys(moroModule).length} total exports)\n`);

  // Test 2: Create an app instance
  console.log('✓ Testing app creation...');
  const app = await moroModule.createApp({
    server: { port: 9999, host: 'localhost' },
  });

  if (!app || !app.get || !app.post || !app.listen) {
    throw new Error('App instance is missing expected methods');
  }
  console.log('  ✅ App instance created successfully\n');

  // Test 3: Test basic routing setup
  console.log('✓ Testing routing...');
  app.get('/test', (req, res) => {
    res.json({ message: 'ok' });
  });
  console.log('  ✅ Routes can be registered\n');

  console.log('✅ All validation checks passed!');
  console.log('📦 Built distribution is ready for release.\n');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Distribution validation failed!');
  console.error('Error:', error.message);
  console.error('\nStack:', error.stack);
  console.error('\n⚠️  DO NOT RELEASE - Fix ESM issues first!\n');
  process.exit(1);
}
