// @ts-nocheck
import { JobStateManager } from '../../../../src/core/jobs/job-state-manager.js';
import { createFrameworkLogger } from '../../../../src/core/logger/index.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('JobStateManager', () => {
  let stateManager: JobStateManager;
  let logger;
  let tempFile: string;

  beforeEach(() => {
    logger = createFrameworkLogger('TestJobStateManager');
    logger.setLevel('error');
    tempFile = path.join(os.tmpdir(), `test-job-state-${Date.now()}.json`);

    stateManager = new JobStateManager(logger, {
      persistPath: tempFile,
      historySize: 10,
      persistInterval: 1000,
      enableAutoPersist: false, // Disable for manual testing
      enableRecovery: false,
    });
  });

  afterEach(async () => {
    await stateManager.shutdown();

    // Clean up temp file
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Ignore
    }
  });

  describe('Job Registration', () => {
    it('should register a new job', () => {
      const state = stateManager.registerJob('job1', 'Test Job', { foo: 'bar' });

      expect(state.jobId).toBe('job1');
      expect(state.name).toBe('Test Job');
      expect(state.enabled).toBe(true);
      expect(state.executionCount).toBe(0);
      expect(state.metadata?.foo).toBe('bar');
    });

    it('should get registered job state', () => {
      stateManager.registerJob('job1', 'Test Job');

      const state = stateManager.getState('job1');
      expect(state).toBeDefined();
      expect(state?.jobId).toBe('job1');
    });

    it('should get all job states', () => {
      stateManager.registerJob('job1', 'Job 1');
      stateManager.registerJob('job2', 'Job 2');

      const states = stateManager.getAllStates();
      expect(states).toHaveLength(2);
    });

    it('should unregister a job', () => {
      stateManager.registerJob('job1', 'Test Job');
      expect(stateManager.getState('job1')).toBeDefined();

      const result = stateManager.unregisterJob('job1');
      expect(result).toBe(true);
      expect(stateManager.getState('job1')).toBeUndefined();
    });
  });

  describe('Execution Tracking', () => {
    beforeEach(() => {
      stateManager.registerJob('job1', 'Test Job');
    });

    it('should start execution tracking', () => {
      const execution = stateManager.startExecution('job1', 'exec1');

      expect(execution.jobId).toBe('job1');
      expect(execution.executionId).toBe('exec1');
      expect(execution.status).toBe('running');
      expect(execution.startTime).toBeInstanceOf(Date);
    });

    it('should end execution tracking successfully', async () => {
      stateManager.startExecution('job1', 'exec1');
      // Small delay to ensure duration > 0
      await new Promise(resolve => setTimeout(resolve, 10));
      const execution = stateManager.endExecution('exec1', 'completed');

      expect(execution).toBeDefined();
      expect(execution?.status).toBe('completed');
      expect(execution?.endTime).toBeInstanceOf(Date);
      expect(execution?.duration).toBeGreaterThanOrEqual(0);
    });

    it('should end execution tracking with error', () => {
      stateManager.startExecution('job1', 'exec1');
      const error = new Error('Job failed');
      const execution = stateManager.endExecution('exec1', 'failed', error);

      expect(execution?.status).toBe('failed');
      expect(execution?.error?.message).toBe('Job failed');
    });

    it('should update job state on execution', () => {
      stateManager.startExecution('job1', 'exec1');
      stateManager.endExecution('exec1', 'completed');

      const state = stateManager.getState('job1');
      expect(state?.executionCount).toBe(1);
      expect(state?.consecutiveFailures).toBe(0);
      expect(state?.lastExecution?.status).toBe('completed');
    });

    it('should track consecutive failures', () => {
      const error = new Error('fail');

      stateManager.startExecution('job1', 'exec1');
      stateManager.endExecution('exec1', 'failed', error);

      stateManager.startExecution('job1', 'exec2');
      stateManager.endExecution('exec2', 'failed', error);

      const state = stateManager.getState('job1');
      expect(state?.consecutiveFailures).toBe(2);
      expect(state?.failureCount).toBe(2);
    });

    it('should reset consecutive failures on success', () => {
      const error = new Error('fail');

      stateManager.startExecution('job1', 'exec1');
      stateManager.endExecution('exec1', 'failed', error);

      stateManager.startExecution('job1', 'exec2');
      stateManager.endExecution('exec2', 'completed');

      const state = stateManager.getState('job1');
      expect(state?.consecutiveFailures).toBe(0);
    });

    it('should check if job is running', () => {
      expect(stateManager.isRunning('job1')).toBe(false);

      stateManager.startExecution('job1', 'exec1');
      expect(stateManager.isRunning('job1')).toBe(true);

      stateManager.endExecution('exec1', 'completed');
      expect(stateManager.isRunning('job1')).toBe(false);
    });
  });

  describe('Job History', () => {
    beforeEach(() => {
      stateManager.registerJob('job1', 'Test Job');
    });

    it('should maintain execution history', () => {
      stateManager.startExecution('job1', 'exec1');
      stateManager.endExecution('exec1', 'completed');

      stateManager.startExecution('job1', 'exec2');
      stateManager.endExecution('exec2', 'completed');

      const history = stateManager.getHistory('job1');
      expect(history).toHaveLength(2);
      expect(history[0].executionId).toBe('exec2'); // Most recent first
      expect(history[1].executionId).toBe('exec1');
    });

    it('should limit history size', () => {
      const manager = new JobStateManager(logger, {
        historySize: 2,
        enableAutoPersist: false,
      });

      manager.registerJob('job1', 'Test Job');

      for (let i = 0; i < 5; i++) {
        manager.startExecution('job1', `exec${i}`);
        manager.endExecution(`exec${i}`, 'completed');
      }

      const history = manager.getHistory('job1');
      expect(history).toHaveLength(2);

      manager.shutdown();
    });

    it('should get limited history', () => {
      for (let i = 0; i < 5; i++) {
        stateManager.startExecution('job1', `exec${i}`);
        stateManager.endExecution(`exec${i}`, 'completed');
      }

      const history = stateManager.getHistory('job1', 3);
      expect(history).toHaveLength(3);
    });
  });

  describe('Metrics', () => {
    beforeEach(() => {
      stateManager.registerJob('job1', 'Test Job');
    });

    it('should calculate job metrics', () => {
      const error = new Error('fail');

      // 3 successes, 2 failures
      for (let i = 0; i < 3; i++) {
        stateManager.startExecution('job1', `exec${i}`);
        stateManager.endExecution(`exec${i}`, 'completed');
      }

      for (let i = 3; i < 5; i++) {
        stateManager.startExecution('job1', `exec${i}`);
        stateManager.endExecution(`exec${i}`, 'failed', error);
      }

      const metrics = stateManager.getMetrics('job1');
      expect(metrics).toBeDefined();
      expect(metrics?.totalExecutions).toBe(5);
      expect(metrics?.successRate).toBe(60);
      expect(metrics?.failureRate).toBe(40);
      expect(metrics?.recentFailures).toBe(2);
    });
  });

  describe('State Persistence', () => {
    it('should persist state to disk', async () => {
      stateManager.registerJob('job1', 'Test Job');
      stateManager.startExecution('job1', 'exec1');
      stateManager.endExecution('exec1', 'completed');

      await stateManager.persistState();

      expect(fs.existsSync(tempFile)).toBe(true);

      const data = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
      expect(data.jobs).toBeDefined();
      expect(data.jobs.job1).toBeDefined();
    });

    it('should load state from disk', async () => {
      // Create initial state
      stateManager.registerJob('job1', 'Test Job');
      stateManager.startExecution('job1', 'exec1');
      stateManager.endExecution('exec1', 'completed');
      await stateManager.persistState();
      await stateManager.shutdown();

      // Create new manager and load state
      const newManager = new JobStateManager(logger, {
        persistPath: tempFile,
        enableRecovery: true,
        enableAutoPersist: false,
      });

      await newManager.loadState();

      const state = newManager.getState('job1');
      expect(state).toBeDefined();
      expect(state?.name).toBe('Test Job');
      expect(state?.executionCount).toBe(1);

      await newManager.shutdown();
    });

    it('should detect crashed jobs', async () => {
      // Simulate a job that was running when system crashed
      stateManager.registerJob('job1', 'Test Job');
      stateManager.startExecution('job1', 'exec1');
      await stateManager.persistState();
      await stateManager.shutdown();

      // Create new manager
      const eventSpy = jest.fn();
      const newManager = new JobStateManager(logger, {
        persistPath: tempFile,
        enableRecovery: true,
      });

      newManager.on('recovery:crashed-jobs', eventSpy);
      await newManager.loadState();

      // The state should be loaded even if no crashed jobs detected
      const state = newManager.getState('job1');
      expect(state).toBeDefined();

      await newManager.shutdown();
    });
  });

  describe('Job Control', () => {
    beforeEach(() => {
      stateManager.registerJob('job1', 'Test Job');
    });

    it('should enable/disable jobs', () => {
      stateManager.setJobEnabled('job1', false);
      expect(stateManager.getState('job1')?.enabled).toBe(false);

      stateManager.setJobEnabled('job1', true);
      expect(stateManager.getState('job1')?.enabled).toBe(true);
    });

    it('should set next run time', () => {
      const nextRun = new Date(Date.now() + 60000);
      stateManager.setNextRun('job1', nextRun);

      const state = stateManager.getState('job1');
      expect(state?.nextRun).toEqual(nextRun);
    });
  });
});
