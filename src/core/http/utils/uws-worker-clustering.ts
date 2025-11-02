// uWebSockets.js Worker Thread Clustering Implementation
// Uses worker threads with acceptor pattern for maximum performance
//
// NOTE: When terminating, you may see "uv_loop_close() while having open handles" warnings
// from Node.js. This is a known limitation when using uWebSockets.js with worker threads.
// The uWS C++ addon maintains internal libuv poll handles that cannot be cleanly closed
// through JavaScript APIs. These warnings are harmless - the process will still exit cleanly.
// To suppress these warnings, you can run Node.js with: --no-warnings or
// NODE_NO_WARNINGS=1 environment variable.

import { Worker, isMainThread, threadId, parentPort } from 'worker_threads';
import os from 'os';
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('UWSClustering');

export interface UWSClusterConfig {
  workers?: number | 'auto';
  memoryPerWorkerGB?: number;
  port: number;
  host?: string;
  ssl?: {
    key_file_name?: string;
    cert_file_name?: string;
    passphrase?: string;
  };
}

export class UWSWorkerClusterManager {
  private workers: Worker[] = [];
  private acceptorApp: any = null;
  private acceptorListenSocket: any = null;
  private uws: any = null;
  private config: UWSClusterConfig;
  private workerCount: number;
  private isShuttingDown = false;

  constructor(config: UWSClusterConfig) {
    this.config = config;
    this.workerCount = this.calculateWorkerCount();
  }

  private calculateWorkerCount(): number {
    let workerCount = this.config.workers || os.cpus().length;

    if (workerCount === 'auto') {
      const cpuCount = os.cpus().length;
      const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);

      let memoryPerWorkerGB = this.config.memoryPerWorkerGB;

      if (!memoryPerWorkerGB) {
        const headroomGB = 4;
        memoryPerWorkerGB = Math.max(0.5, Math.floor((totalMemoryGB - headroomGB) / cpuCount));
      }

      workerCount = Math.min(cpuCount, Math.floor(totalMemoryGB / memoryPerWorkerGB));

      logger.info(
        `Auto-calculated worker count: ${workerCount} (CPU: ${cpuCount}, RAM: ${totalMemoryGB.toFixed(1)}GB, ${memoryPerWorkerGB}GB per worker)`,
        'WorkerCalculation'
      );
    } else if (typeof workerCount === 'number') {
      logger.info(`Using specified worker count: ${workerCount}`, 'WorkerCalculation');
    }

    return workerCount;
  }

  async startAcceptorAndWorkers(_appFactory: () => any): Promise<void> {
    if (!isMainThread) {
      throw new Error('startAcceptorAndWorkers can only be called from main thread');
    }

    try {
      // Lazy load uWebSockets.js
      const uwsModule = await import('uWebSockets.js');
      this.uws = uwsModule.default || uwsModule;

      // Create acceptor app - must match SSL config of worker apps
      const ssl = this.config.ssl;
      if (ssl && ssl.key_file_name && ssl.cert_file_name) {
        this.acceptorApp = this.uws.SSLApp({
          key_file_name: ssl.key_file_name,
          cert_file_name: ssl.cert_file_name,
          passphrase: ssl.passphrase,
        });
        logger.info('uWebSockets SSL acceptor app created', 'Acceptor');
      } else {
        this.acceptorApp = this.uws.App();
        logger.info('uWebSockets acceptor app created', 'Acceptor');
      }

      // Start listening on acceptor
      const port = this.config.port;
      this.acceptorApp.listen(port, (token: any) => {
        if (token) {
          this.acceptorListenSocket = token;
          logger.info(`Acceptor listening on port ${port} from thread ${threadId}`, 'Acceptor');
        } else {
          throw new Error(`Failed to listen on port ${port} from thread ${threadId}`);
        }
      });

      // Spawn workers
      logger.info(`Starting ${this.workerCount} worker threads`, 'Workers');

      for (let i = 0; i < this.workerCount; i++) {
        await this.spawnWorker(i);
      }

      // Setup graceful shutdown
      this.setupGracefulShutdown();
    } catch (error) {
      logger.error('Failed to start acceptor and workers', 'Startup', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async spawnWorker(index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(process.argv[1], {
        workerData: {
          isUWSWorker: true,
          workerIndex: index,
          config: this.config,
        },
        argv: process.argv.slice(2),
        env: {
          ...process.env,
          UWS_WORKER_MODE: 'true',
          UWS_WORKER_INDEX: String(index),
        },
      });

      let descriptorReceived = false;

      worker.on('message', (message: any) => {
        if (message.type === 'descriptor' && message.descriptor) {
          if (!this.acceptorApp) {
            logger.error('Acceptor app not initialized', 'WorkerSpawn');
            reject(new Error('Acceptor app not initialized'));
            return;
          }

          try {
            this.acceptorApp.addChildAppDescriptor(message.descriptor);
            descriptorReceived = true;
            logger.info(
              `Worker ${index} (thread ${message.threadId}) registered with acceptor`,
              'WorkerSpawn'
            );
            resolve();
          } catch (error) {
            logger.error('Failed to add child app descriptor', 'WorkerSpawn', {
              error: error instanceof Error ? error.message : String(error),
            });
            reject(error);
          }
        } else if (message.type === 'error') {
          logger.error(`Worker ${index} initialization error: ${message.error}`, 'WorkerSpawn');
          reject(new Error(message.error));
        }
      });

      worker.on('error', (error: Error) => {
        logger.error(`Worker ${index} error`, 'Worker', {
          error: error.message,
        });
        if (!descriptorReceived) {
          reject(error);
        }
      });

      worker.on('exit', (code: number) => {
        // Worker threads don't have exitedAfterDisconnect like cluster workers
        // Restart on any non-zero exit code
        if (code !== 0) {
          logger.warn(`Worker ${index} died unexpectedly (code: ${code}). Restarting...`, 'Worker');

          // Remove from workers array
          const workerIdx = this.workers.indexOf(worker);
          if (workerIdx > -1) {
            this.workers.splice(workerIdx, 1);
          }

          // Restart worker
          this.spawnWorker(index).catch(error => {
            logger.error('Failed to restart worker', 'Worker', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      });

      this.workers.push(worker);

      // Timeout for descriptor reception
      setTimeout(() => {
        if (!descriptorReceived) {
          logger.error(`Worker ${index} failed to send descriptor within timeout`, 'WorkerSpawn');
          worker.terminate();
          reject(new Error(`Worker ${index} initialization timeout`));
        }
      }, 10000); // 10 second timeout
    });
  }

  private setupGracefulShutdown(): void {
    const gracefulShutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info('Gracefully shutting down worker cluster...', 'Shutdown');

      // Close acceptor listen socket first
      if (this.acceptorListenSocket && this.uws) {
        try {
          this.uws.us_listen_socket_close(this.acceptorListenSocket);
          this.acceptorListenSocket = null;
          logger.info('Acceptor listen socket closed', 'Shutdown');
        } catch (error) {
          logger.error('Error closing acceptor socket', 'Shutdown', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Send shutdown message to all workers and wait for them to close
      const shutdownPromises = this.workers.map((worker, index) => {
        return new Promise<void>(resolve => {
          let workerExited = false;

          const timeout = setTimeout(() => {
            if (!workerExited) {
              logger.info(
                `Worker ${index} taking too long to exit, terminating forcefully`,
                'Shutdown'
              );
              try {
                // Terminate is the last resort for stuck workers
                worker.terminate();
              } catch {
                logger.error(`Error terminating worker ${index}`, 'Shutdown');
              }
            }
            resolve();
          }, 2000); // Give 2 seconds for graceful exit

          worker.once('exit', code => {
            workerExited = true;
            clearTimeout(timeout);
            if (code === 0) {
              logger.info(`Worker ${index} exited cleanly`, 'Shutdown');
            } else if (code === 1) {
              logger.info(`Worker ${index} terminated (exit code ${code})`, 'Shutdown');
            } else {
              logger.warn(`Worker ${index} exited with unexpected code ${code}`, 'Shutdown');
            }
            resolve();
          });

          // Send shutdown message
          try {
            worker.postMessage({ type: 'shutdown' });
          } catch {
            logger.error(`Failed to send shutdown message to worker ${index}`, 'Shutdown');
            clearTimeout(timeout);
            try {
              worker.terminate();
            } catch {
              // Ignore termination errors
            }
            resolve();
          }
        });
      });

      await Promise.all(shutdownPromises);
      logger.info('All workers shut down', 'Shutdown');

      // Clear acceptor app reference to allow uWebSockets to cleanup
      if (this.acceptorApp) {
        this.acceptorApp = null;
      }

      // Give uWebSockets event loop time to fully cleanup before exiting
      await new Promise(resolve => setTimeout(resolve, 200));

      logger.info('Shutdown complete', 'Shutdown');
      process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  }

  static isUWSWorker(): boolean {
    return !isMainThread && process.env.UWS_WORKER_MODE === 'true';
  }

  static async sendDescriptorToAcceptor(app: any): Promise<void> {
    if (isMainThread || !parentPort) {
      throw new Error('sendDescriptorToAcceptor can only be called from worker thread');
    }

    try {
      const descriptor = app.getDescriptor();

      parentPort.postMessage({
        type: 'descriptor',
        descriptor,
        threadId,
      });

      logger.info(`Worker thread ${threadId} sent descriptor to acceptor`, 'Worker');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to send descriptor to acceptor', 'Worker', { error: errorMessage });

      if (parentPort) {
        parentPort.postMessage({
          type: 'error',
          error: errorMessage,
        });
      }

      throw error;
    }
  }

  static setupWorkerShutdownHandler(closeCallback: () => void | Promise<void>): void {
    if (!parentPort) {
      return;
    }

    parentPort.on('message', async (message: any) => {
      if (message.type === 'shutdown') {
        logger.info(`Worker thread ${threadId} shutting down...`, 'Worker');

        try {
          // Call the close callback and wait if it's async
          const result = closeCallback();
          if (result && typeof result.then === 'function') {
            await result;
          }

          // Give uWebSockets event loop time to fully cleanup
          await new Promise(resolve => setTimeout(resolve, 150));

          // Close parent port to signal we're ready to exit
          if (parentPort) {
            parentPort.close();
          }

          logger.info(`Worker thread ${threadId} cleanup complete`, 'Worker');

          // DON'T call process.exit() - let Node.js exit naturally
          // This allows the event loop to properly drain all uWebSockets handles
          // The worker will exit on its own once all handles are closed
        } catch (error) {
          logger.error('Error during worker shutdown', 'Worker', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Still don't force exit - let it drain naturally
        }
      }
    });
  }
}
