// Worker pool lifetime fixture (plain JavaScript, loading the BUILT framework,
// because worker threads run the compiled worker entry): what happens to the
// process-wide pool once the app that used it is closed.
// tests/integration/workers-config.test.ts runs it as a child process and
// reads the lines it prints and how the process ends.
//
//   MODE=second-app       a second app is created after the first was closed
//   MODE=late-first-use   an app created earlier first uses workers after
//                         the other app, which had used them, was closed
//   MODE=stray            code that outlived its app asks for the pool itself
//   MORO_TEST_DIST        a built framework other than ../../../dist
//
// The fixture never calls process.exit(): the process has to end by itself.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { createApp, getWorkerManager, workerTasks } = await import(
  process.env.MORO_TEST_DIST
    ? pathToFileURL(join(process.env.MORO_TEST_DIST, 'index.js')).href
    : '../../../dist/index.js'
);

const mode = process.env.MODE;
const options = { logger: { level: 'fatal' }, workers: { count: 1 } };
const hashWith = async app => (await app.getCryptoWorker()).hash('moro');

const first = await createApp(options);
const idle = mode === 'late-first-use' ? await createApp({ logger: { level: 'fatal' } }) : null;
console.log(`first ${await hashWith(first)}`);
await first.close();

if (mode === 'second-app') {
  const second = await createApp(options);
  console.log(`second ${await hashWith(second)}`);
  await second.close();
} else if (mode === 'late-first-use') {
  console.log(`late ${await hashWith(idle)}`);
  await idle.close();
} else if (mode === 'stray') {
  console.log(`stray threads ${getWorkerManager().getStats().workerCount}`);
  console.log(`stray ${await workerTasks.hash('moro')}`);
}
console.log('end');
