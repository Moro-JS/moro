// Worker Thread Implementation
// Runs in worker threads to execute CPU-intensive operations

import { parentPort } from 'worker_threads';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { resolveUserPackage, isPackageAvailable } from '../utilities/package-utils.js';

// Optional JWT import (may not be available)
let jwt: any = null;
const jwtAvailable = isPackageAvailable('jsonwebtoken');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Import task types
import { WorkerTask, WorkerResult, WORKER_TASKS } from './worker-manager.js';

/**
 * Execute a worker task
 */
async function executeTask(task: WorkerTask): Promise<WorkerResult> {
  const startTime = Date.now();

  try {
    let result: any;

    switch (task.type) {
      case WORKER_TASKS.JWT_VERIFY:
        result = await handleJWTVerify(task.data);
        break;

      case WORKER_TASKS.JWT_SIGN:
        result = await handleJWTSign(task.data);
        break;

      case WORKER_TASKS.CRYPTO_HASH:
        result = await handleCryptoHash(task.data);
        break;

      case WORKER_TASKS.CRYPTO_ENCRYPT:
        result = await handleCryptoEncrypt(task.data);
        break;

      case WORKER_TASKS.CRYPTO_DECRYPT:
        result = await handleCryptoDecrypt(task.data);
        break;

      case WORKER_TASKS.DATA_COMPRESS:
        result = await handleDataCompress(task.data);
        break;

      case WORKER_TASKS.DATA_DECOMPRESS:
        result = await handleDataDecompress(task.data);
        break;

      case WORKER_TASKS.HEAVY_COMPUTATION:
        result = await handleHeavyComputation(task.data);
        break;

      case WORKER_TASKS.JSON_TRANSFORM:
        result = await handleJSONTransform(task.data);
        break;

      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }

    return {
      taskId: task.id,
      success: true,
      data: result,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      taskId: task.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * JWT verification handler
 */
async function handleJWTVerify(data: {
  token: string;
  secret: string;
  options?: any;
}): Promise<any> {
  if (!jwtAvailable) {
    throw new Error(
      'JWT verification requires the "jsonwebtoken" package. Please install it with: npm install jsonwebtoken @types/jsonwebtoken'
    );
  }

  // Lazy load JWT if needed
  if (!jwt) {
    const jwtPath = resolveUserPackage('jsonwebtoken');
    jwt = await import(jwtPath);
  }

  const { token, secret, options } = data;
  return jwt.verify(token, secret, options);
}

/**
 * JWT signing handler
 */
async function handleJWTSign(data: {
  payload: any;
  secret: string;
  options?: any;
}): Promise<string> {
  if (!jwtAvailable) {
    throw new Error(
      'JWT signing requires the "jsonwebtoken" package. Please install it with: npm install jsonwebtoken @types/jsonwebtoken'
    );
  }

  // Lazy load JWT if needed
  if (!jwt) {
    const jwtPath = resolveUserPackage('jsonwebtoken');
    jwt = await import(jwtPath);
  }

  const { payload, secret, options } = data;
  return jwt.sign(payload, secret, options);
}

/**
 * Crypto hash handler
 */
async function handleCryptoHash(data: { data: string; algorithm?: string }): Promise<string> {
  const { data: inputData, algorithm = 'sha256' } = data;
  return crypto.createHash(algorithm).update(inputData).digest('hex');
}

/**
 * Crypto encryption handler
 */
async function handleCryptoEncrypt(data: {
  data: string;
  algorithm?: string;
  key: string;
  iv?: string;
}): Promise<string> {
  const { data: inputData, algorithm = 'aes-256-cbc', key, iv } = data;
  // Use modern createCipheriv (createCipher is deprecated)
  const cipher = crypto.createCipheriv(algorithm, key, iv || Buffer.alloc(16, 0));
  let encrypted = cipher.update(inputData, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/**
 * Crypto decryption handler
 */
async function handleCryptoDecrypt(data: {
  data: string;
  algorithm?: string;
  key: string;
  iv?: string;
}): Promise<string> {
  const { data: encryptedData, algorithm = 'aes-256-cbc', key, iv } = data;
  // Use modern createDecipheriv (createDecipher is deprecated)
  const decipher = crypto.createDecipheriv(algorithm, key, iv || Buffer.alloc(16, 0));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Data compression handler
 */
async function handleDataCompress(data: {
  input: string | Buffer;
  format?: 'gzip' | 'deflate';
}): Promise<Buffer> {
  const { input, format = 'gzip' } = data;

  if (format === 'gzip') {
    return gzip(Buffer.from(input));
  } else {
    return new Promise((resolve, reject) => {
      zlib.deflate(Buffer.from(input), (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
}

/**
 * Data decompression handler
 */
async function handleDataDecompress(data: {
  input: Buffer;
  format?: 'gzip' | 'deflate';
}): Promise<Buffer> {
  const { input, format = 'gzip' } = data;

  if (format === 'gzip') {
    return gunzip(input);
  } else {
    return new Promise((resolve, reject) => {
      zlib.inflate(input, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
}

/**
 * Heavy computation handler
 */
async function handleHeavyComputation(data: any): Promise<any> {
  // This is a placeholder for heavy computation tasks
  // In real applications, this could be:
  // - Complex mathematical calculations
  // - Data processing pipelines
  // - Image processing
  // - Machine learning inference
  // - Large dataset transformations

  // Simulate heavy computation
  if (Array.isArray(data)) {
    // Simulate processing a large array
    const result = [];
    for (let i = 0; i < data.length; i++) {
      // Simulate CPU-intensive operation
      let sum = 0;
      for (let j = 0; j < 1000; j++) {
        sum += Math.sin(i) * Math.cos(j) + Math.sqrt(i + j);
      }
      result.push(sum);
    }
    return result;
  }

  if (typeof data === 'object' && data.iterations) {
    // Simulate configurable heavy computation
    let result = 0;
    for (let i = 0; i < (data.iterations || 1000000); i++) {
      result += Math.pow(Math.sin(i), 2) + Math.pow(Math.cos(i), 2);
    }
    return { result, iterations: data.iterations };
  }

  return data; // Echo back if not recognized
}

/**
 * JSON transformation handler
 */
async function handleJSONTransform(data: { data: any; transformer: string }): Promise<any> {
  const { data: inputData, transformer: transformerCode } = data;

  // Create a function from the transformer code string
  // NOTE: This is potentially unsafe - in production, you'd want to validate/sanitize the transformer
  try {
    const transformer = new Function('data', `return (${transformerCode})(data);`);
    return transformer(inputData);
  } catch (error) {
    throw new Error(
      `Invalid transformer function: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Worker thread message handling
if (parentPort) {
  parentPort.on('message', async (task: WorkerTask) => {
    const result = await executeTask(task);

    if (parentPort) {
      parentPort.postMessage(result);
    }
  });
}
