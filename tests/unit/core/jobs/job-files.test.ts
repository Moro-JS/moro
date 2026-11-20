// Leader lock and job state files: the default file names are scoped to the
// working directory, a lock is held while it is live or fresh and taken over
// once it is stale, and the state file is replaced on every persist and read
// back only when it is a regular file of a sane size.
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LeaderElection } from '../../../../src/core/jobs/leader-election.js';
import { JobStateManager } from '../../../../src/core/jobs/job-state-manager.js';
import {
  appScopeId,
  defaultJobStatePath,
  defaultLeaderLockPath,
} from '../../../../src/core/jobs/default-paths.js';
import {
  MoroLogger,
  createFrameworkLogger,
  logger as globalLogger,
} from '../../../../src/core/logger/index.js';

const posix = process.platform !== 'win32';
const posixIt = posix ? it : it.skip;

const LOCK_TIMEOUT = 30000;

const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const ageFile = (file: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
};

// warn() is an instance property (a noop below the active level), so raise the
// level and observe the shared private log(level, message) sink instead.
function captureWarnings() {
  globalLogger.setLevel('debug');
  const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  return () => spy.mock.calls.filter(c => c[0] === 'warn').map(c => String(c[1]));
}

describe('job scheduler files', () => {
  let dir: string;
  const logger = createFrameworkLogger('TestJobFiles');

  beforeEach(() => {
    // A private directory under the (redirected) temp dir for every test
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-job-files-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('default file names', () => {
    const scope = crypto.createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);

    it('scopes the default names to the working directory', () => {
      expect(appScopeId()).toBe(scope);
      expect(appScopeId()).toMatch(/^[0-9a-f]{12}$/);
      expect(appScopeId('/srv/billing')).not.toBe(appScopeId('/srv/email'));
      expect(appScopeId('/srv/billing')).toBe(appScopeId('/srv/billing'));

      expect(defaultLeaderLockPath()).toBe(
        path.join(os.tmpdir(), `moro-jobs-leader-${scope}.lock`)
      );
      expect(defaultJobStatePath()).toBe(path.join(os.tmpdir(), `moro-jobs-state-${scope}.json`));
    });

    it('LeaderElection uses the scoped lock name unless a path is configured', async () => {
      const byDefault = new LeaderElection(logger, { strategy: 'file' });
      const again = new LeaderElection(logger, { strategy: 'file' });
      const explicit = new LeaderElection(logger, {
        strategy: 'file',
        lockPath: path.join(dir, 'custom.lock'),
      });
      const lockPathOf = (election: LeaderElection) =>
        (election as unknown as { lockPath: string }).lockPath;

      expect(lockPathOf(byDefault)).toBe(defaultLeaderLockPath());
      expect(lockPathOf(byDefault)).not.toBe(path.join(os.tmpdir(), 'moro-jobs-leader.lock'));
      // Instances of the same app (same working directory) share one lock
      expect(lockPathOf(again)).toBe(lockPathOf(byDefault));
      expect(lockPathOf(explicit)).toBe(path.join(dir, 'custom.lock'));
    });

    it('JobStateManager uses the scoped state name unless a path is configured', async () => {
      const options = { enableAutoPersist: false, enableRecovery: false };
      const byDefault = new JobStateManager(logger, options);
      const explicit = new JobStateManager(logger, {
        ...options,
        persistPath: path.join(dir, 'custom-state.json'),
      });
      const persistPathOf = (manager: JobStateManager) =>
        (manager as unknown as { persistPath: string }).persistPath;

      expect(persistPathOf(byDefault)).toBe(defaultJobStatePath());
      expect(persistPathOf(byDefault)).not.toBe(path.join(os.tmpdir(), 'moro-jobs-state.json'));
      expect(persistPathOf(explicit)).toBe(path.join(dir, 'custom-state.json'));
    });
  });

  describe('leader lock file', () => {
    let lockPath: string;
    const elections: LeaderElection[] = [];

    const elect = async (instanceId: string): Promise<LeaderElection> => {
      const election = new LeaderElection(logger, {
        strategy: 'file',
        lockPath,
        lockTimeout: LOCK_TIMEOUT,
        heartbeatInterval: 600000,
        instanceId,
      });
      elections.push(election);
      await election.start();
      return election;
    };

    const foreignLock = (lastHeartbeat: Date) =>
      JSON.stringify({
        instanceId: 'someone-else',
        hostname: 'other-host',
        pid: 1,
        electedAt: lastHeartbeat,
        lastHeartbeat,
      });

    beforeEach(() => {
      lockPath = path.join(dir, 'leader.lock');
    });

    afterEach(async () => {
      for (const election of elections.splice(0)) {
        await election.shutdown();
      }
    });

    posixIt('creates the lock with mode 0600', async () => {
      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(true);
      expect(modeOf(lockPath)).toBe(0o600);
    });

    posixIt('keeps mode 0600 when taking over an expired lock', async () => {
      fs.writeFileSync(lockPath, foreignLock(new Date(Date.now() - 2 * LOCK_TIMEOUT)), {
        mode: 0o644,
      });
      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(true);
      expect(modeOf(lockPath)).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['leader.lock']);
    });

    it('still respects a live lock held by another instance', async () => {
      fs.writeFileSync(lockPath, foreignLock(new Date()));
      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(false);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).instanceId).toBe('someone-else');
    });

    it.each([
      ['zero-byte', ''],
      ['unparsable', '{"instanceId": "half-writ'],
      ['non-object', 'null'],
    ])('treats a %s lock as held while the file is fresh', async (_label, content) => {
      fs.writeFileSync(lockPath, content);
      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(false);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(content);
    });

    it.each([
      ['zero-byte', ''],
      ['unparsable', '{"instanceId": "half-writ'],
      ['non-object', 'null'],
    ])('takes over a %s lock once its mtime is older than lockTimeout', async (_label, content) => {
      const warnings = captureWarnings();
      fs.writeFileSync(lockPath, content);
      ageFile(lockPath, LOCK_TIMEOUT + 5000);

      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).instanceId).toBe('a');
      expect(warnings().some(message => message.includes('unreadable and stale'))).toBe(true);
    });

    it('treats a future-dated heartbeat as held while the file is fresh', async () => {
      fs.writeFileSync(lockPath, foreignLock(new Date(Date.now() + 24 * 3600 * 1000)));
      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(false);
    });

    it('takes over a future-dated lock once its mtime is older than lockTimeout', async () => {
      const warnings = captureWarnings();
      fs.writeFileSync(lockPath, foreignLock(new Date(Date.now() + 365 * 24 * 3600 * 1000)));
      ageFile(lockPath, LOCK_TIMEOUT + 5000);

      const election = await elect('a');
      expect(election.isCurrentLeader()).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).instanceId).toBe('a');
      expect(warnings().some(message => message.includes('future-dated and stale'))).toBe(true);
    });
  });

  describe('job state file', () => {
    let statePath: string;
    const managers: JobStateManager[] = [];

    const manager = (overrides: { enableRecovery?: boolean } = {}): JobStateManager => {
      const created = new JobStateManager(logger, {
        persistPath: statePath,
        enableAutoPersist: false,
        enableRecovery: false,
        ...overrides,
      });
      managers.push(created);
      return created;
    };

    const validState = (jobId: string) =>
      JSON.stringify({
        version: '1.0.0',
        timestamp: new Date(),
        hostname: 'h',
        pid: 1,
        jobs: {
          [jobId]: {
            jobId,
            name: jobId,
            enabled: true,
            executionCount: 7,
            failureCount: 0,
            consecutiveFailures: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        runningJobs: [],
      });

    beforeEach(() => {
      statePath = path.join(dir, 'state.json');
    });

    afterEach(async () => {
      for (const created of managers.splice(0)) {
        created.clear();
        (created as unknown as { isDirty: boolean }).isDirty = false;
        await created.shutdown();
      }
    });

    posixIt('writes the state file with mode 0600 and leaves no temp file', async () => {
      const state = manager();
      state.registerJob('job1', 'Job 1');
      await state.persistState();

      expect(modeOf(statePath)).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['state.json']);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf-8')).jobs.job1.name).toBe('Job 1');
    });

    posixIt('does not write through a symlink planted at the old temp name', async () => {
      const victim = path.join(dir, 'victim.txt');
      fs.writeFileSync(victim, 'do not touch');
      fs.symlinkSync(victim, `${statePath}.tmp`);

      const state = manager();
      state.registerJob('job1', 'Job 1');
      await state.persistState();

      expect(fs.readFileSync(victim, 'utf-8')).toBe('do not touch');
      expect(fs.lstatSync(statePath).isFile()).toBe(true);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf-8')).jobs.job1).toBeDefined();
    });

    it('replaces the state file on every persist (overwrite still works)', async () => {
      const state = manager();
      state.registerJob('job1', 'Job 1');
      await state.persistState();
      state.registerJob('job2', 'Job 2');
      await state.persistState();

      expect(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf-8')).jobs)).toEqual([
        'job1',
        'job2',
      ]);
    });

    it('still loads a regular state file', async () => {
      fs.writeFileSync(statePath, validState('restored'));
      const state = manager();
      await state.loadState();
      expect(state.getState('restored')?.executionCount).toBe(7);
    });

    posixIt('ignores a symlink at the state path, with a warning', async () => {
      const warnings = captureWarnings();
      const elsewhere = path.join(dir, 'elsewhere.json');
      fs.writeFileSync(elsewhere, validState('planted'));
      fs.symlinkSync(elsewhere, statePath);

      const state = manager();
      await state.loadState();

      expect(state.getAllStates()).toHaveLength(0);
      expect(warnings().some(message => message.includes('not a regular file'))).toBe(true);
    });

    it('ignores a directory at the state path, with a warning', async () => {
      const warnings = captureWarnings();
      fs.mkdirSync(statePath);

      const state = manager();
      await expect(state.loadState()).resolves.toBeUndefined();

      expect(state.getAllStates()).toHaveLength(0);
      expect(warnings().some(message => message.includes('not a regular file'))).toBe(true);
    });

    it('ignores a state file larger than 16 MiB, with a warning', async () => {
      const warnings = captureWarnings();
      fs.writeFileSync(statePath, validState('huge'));
      fs.truncateSync(statePath, 16 * 1024 * 1024 + 1); // sparse: no real disk use
      const readSpy = jest.spyOn(fs.promises, 'readFile');

      const state = manager();
      await state.loadState();

      expect(state.getAllStates()).toHaveLength(0);
      expect(readSpy).not.toHaveBeenCalled();
      expect(warnings().some(message => message.includes('too large'))).toBe(true);
    });

    it('loads nothing and stays quiet when there is no state file', async () => {
      const warnings = captureWarnings();
      const state = manager();
      await state.loadState();
      expect(state.getAllStates()).toHaveLength(0);
      expect(warnings()).toHaveLength(0);
    });
  });
});
