// Worker Threads - CPU-intensive operations offloading
// Massive performance gains: 50-200% for CPU-bound tasks

export {
  WorkerManager,
  getWorkerManager,
  executeOnWorker,
  workerTasks,
  type WorkerTask,
  type WorkerResult,
  WORKER_TASKS,
} from './worker-manager.js';

// Clean facade API
export {
  WorkerThreadsFacade,
  type WorkerStats,
  type WorkerAPI,
  type WorkerHelpers,
} from './facade.js';
