// Worker Thread Implementation
// Runs in worker threads to execute CPU-intensive operations

import { parentPort } from 'worker_threads';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { resolveUserPackage, isPackageAvailable } from '../utilities/package-utils.js';
import { isPublicKeyPem, PUBLIC_KEY_NEEDS_ALGORITHMS } from '../utilities/public-key-pem.js';

// isolated-vm, the V8 isolate that JSON transforms run in (required for them)
let isolatedVM: any = null;
const isolatedVMAvailable = isPackageAvailable('isolated-vm');

// Optional JWT import (may not be available)
let jwt: any = null;
const jwtAvailable = isPackageAvailable('jsonwebtoken');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

// Default cap on the output of a single decompress task (256 MiB).
// Exported for direct unit testing.
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

// Import task types
import {
  WorkerTask,
  WorkerResult,
  WORKER_TASKS,
  TRANSFORM_JSON_NEEDS_ISOLATED_VM,
} from './worker-manager.js';

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
 * Load `jsonwebtoken` from the application's node_modules, once per thread.
 *
 * jsonwebtoken is CommonJS and builds its exports at runtime, so under ESM
 * `import()` yields `{ default: <the module> }` with no named `verify` or
 * `sign`. A CommonJS build of this file gets the module itself.
 */
async function loadJWT(): Promise<any> {
  if (!jwt) {
    const jwtPath = resolveUserPackage('jsonwebtoken');
    const loaded = await import(jwtPath);
    jwt = loaded.default ?? loaded;
  }
  return jwt;
}

/**
 * JWT verification handler
 *
 * Verifies with HS256 only, unless the caller names the accepted algorithms in
 * `options.algorithms`. A public key is refused under that default instead of
 * being used as an HMAC secret: anyone holding the public key could sign an
 * HS256 token with it (jsonwebtoken 8 and earlier accept such a token).
 * Exported for direct unit testing.
 */
export async function handleJWTVerify(data: {
  token: string;
  secret: string;
  options?: any;
}): Promise<any> {
  if (!jwtAvailable) {
    throw new Error(
      'JWT verification requires the "jsonwebtoken" package. Please install it with: npm install jsonwebtoken @types/jsonwebtoken'
    );
  }

  const jsonwebtoken = await loadJWT();

  const { token, secret, options } = data;
  if (options?.algorithms != null) {
    return jsonwebtoken.verify(token, secret, options);
  }

  if (isPublicKeyPem(secret)) {
    throw new Error(PUBLIC_KEY_NEEDS_ALGORITHMS);
  }
  return jsonwebtoken.verify(token, secret, { ...options, algorithms: ['HS256'] });
}

/**
 * JWT signing handler
 * Exported for direct unit testing.
 */
export async function handleJWTSign(data: {
  payload: any;
  secret: string;
  options?: any;
}): Promise<string> {
  if (!jwtAvailable) {
    throw new Error(
      'JWT signing requires the "jsonwebtoken" package. Please install it with: npm install jsonwebtoken @types/jsonwebtoken'
    );
  }

  const jsonwebtoken = await loadJWT();

  const { payload, secret, options } = data;
  return jsonwebtoken.sign(payload, secret, options);
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
 * When no IV is provided, auto-generates a random 16-byte IV and prepends it to the output.
 */
async function handleCryptoEncrypt(data: {
  data: string;
  algorithm?: string;
  key: string;
  iv?: string;
}): Promise<string> {
  const { data: inputData, algorithm = 'aes-256-cbc', key, iv } = data;

  let effectiveIv: Buffer;
  let prependIv = false;

  if (iv) {
    effectiveIv = Buffer.from(iv, 'hex');
  } else {
    // Auto-generate random IV for security — prepend to output for extraction during decryption
    effectiveIv = crypto.randomBytes(16);
    prependIv = true;
  }

  const cipher = crypto.createCipheriv(algorithm, key, effectiveIv);
  let encrypted = cipher.update(inputData, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Prepend IV to ciphertext so decryption can extract it
  if (prependIv) {
    return effectiveIv.toString('hex') + ':' + encrypted;
  }
  return encrypted;
}

/**
 * Crypto decryption handler
 * Supports both formats:
 * - New format: "iv_hex:ciphertext_hex" (IV prepended, separated by colon)
 * - Legacy format: raw ciphertext_hex (falls back to zero IV for backward compatibility)
 */
async function handleCryptoDecrypt(data: {
  data: string;
  algorithm?: string;
  key: string;
  iv?: string;
}): Promise<string> {
  const { data: encryptedData, algorithm = 'aes-256-cbc', key, iv } = data;

  let effectiveIv: Buffer;
  let ciphertext: string;

  if (iv) {
    // Explicit IV provided
    effectiveIv = Buffer.from(iv, 'hex');
    ciphertext = encryptedData;
  } else if (encryptedData.includes(':')) {
    // New format: extract prepended IV
    const colonIndex = encryptedData.indexOf(':');
    effectiveIv = Buffer.from(encryptedData.substring(0, colonIndex), 'hex');
    ciphertext = encryptedData.substring(colonIndex + 1);
  } else {
    // Legacy format: fall back to zero IV for backward compatibility
    effectiveIv = Buffer.alloc(16, 0);
    ciphertext = encryptedData;
  }

  const decipher = crypto.createDecipheriv(algorithm, key, effectiveIv);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export type CompressionFormat = 'gzip' | 'deflate' | 'brotli';

/**
 * Data compression handler
 * Exported for direct unit testing; normally invoked via the worker task registry.
 */
export async function handleDataCompress(data: {
  input: string | Buffer | Uint8Array;
  format?: CompressionFormat;
}): Promise<Buffer> {
  const { input, format = 'gzip' } = data;
  const buffer = Buffer.from(input as any);

  switch (format) {
    case 'gzip':
      return gzip(buffer);
    case 'deflate':
      return deflate(buffer);
    case 'brotli':
      return brotliCompress(buffer);
    default:
      throw new Error(`Unknown compression format: ${format}`);
  }
}

/**
 * Data decompression handler
 * Exported for direct unit testing; normally invoked via the worker task registry.
 */
export async function handleDataDecompress(data: {
  input: Buffer | Uint8Array;
  format?: CompressionFormat;
  /** Largest decompressed size accepted, in bytes (default: 256 MiB) */
  maxOutputLength?: number;
}): Promise<Buffer> {
  const { input, format = 'gzip' } = data;
  const buffer = Buffer.from(input as any);

  // Cap the output: a small compressed input can expand to gigabytes
  const maxOutputLength =
    typeof data.maxOutputLength === 'number' &&
    Number.isFinite(data.maxOutputLength) &&
    data.maxOutputLength >= 1
      ? Math.floor(data.maxOutputLength)
      : DEFAULT_MAX_DECOMPRESSED_BYTES;

  try {
    switch (format) {
      case 'gzip':
        return await gunzip(buffer, { maxOutputLength });
      case 'deflate':
        return await inflate(buffer, { maxOutputLength });
      case 'brotli':
        return await brotliDecompress(buffer, { maxOutputLength });
      default:
        throw new Error(`Unknown compression format: ${format}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `Decompressed data exceeds the ${maxOutputLength} byte limit (maxOutputLength)`
      );
    }
    throw error;
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
 * Execute a transformer in a true V8 isolate sandbox using isolated-vm.
 * This is the secure path — complete memory and CPU isolation.
 *
 * The isolate has no access to Node.js APIs (process, require, fs, etc.)
 * and is limited to 128MB memory with a 10s execution timeout.
 *
 * @see https://www.npmjs.com/package/isolated-vm
 */
async function executeInIsolate(inputData: any, transformerCode: string): Promise<any> {
  if (!isolatedVM) {
    const ivmPath = resolveUserPackage('isolated-vm');
    isolatedVM = await import(ivmPath);
    // Handle both default and named exports
    if (isolatedVM.default) {
      isolatedVM = isolatedVM.default;
    }
  }

  const isolate = new isolatedVM.Isolate({ memoryLimit: 128 });
  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // Copy input data into the isolate via ExternalCopy (deep copy, no shared references).
    // .copyInto() produces a transferable value that can be set on the isolate's global.
    await jail.set('__inputData', new isolatedVM.ExternalCopy(inputData).copyInto());

    // Compile the transformer script for execution in the isolate
    const script = await isolate.compileScript(`'use strict'; (${transformerCode})(__inputData);`);

    // Execute with timeout and copy the result back out of the isolate.
    // { copy: true } ensures complex objects (arrays, nested objects) are
    // deep-copied back — without it, only primitives transfer.
    const result = await script.run(context, { timeout: 10000, copy: true });

    return result;
  } finally {
    isolate.dispose();
  }
}

/**
 * JSON transformation handler.
 *
 * The transformer arrives as source text, so it runs only inside an
 * isolated-vm isolate, which has no access to Node.js APIs and its own memory
 * and time limits. Without the isolated-vm package the task is refused: there
 * is no in-process way to run that text safely.
 *
 * Exported for direct unit testing.
 */
export async function handleJSONTransform(data: { data: any; transformer: string }): Promise<any> {
  const { data: inputData, transformer: transformerCode } = data;

  if (!isolatedVMAvailable) {
    throw new Error(TRANSFORM_JSON_NEEDS_ISOLATED_VM);
  }

  try {
    return await executeInIsolate(inputData, transformerCode);
  } catch (error) {
    throw new Error(
      `Invalid transformer function: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Worker thread message handling
if (parentPort) {
  parentPort.on('message', (task: WorkerTask) => {
    void (async () => {
      const result = await executeTask(task);

      if (parentPort) {
        parentPort.postMessage(result);
      }
    })();
  });
}
