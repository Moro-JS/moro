// Worker Thread Implementation
// Runs in worker threads to execute CPU-intensive operations

import { parentPort } from 'worker_threads';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { resolveUserPackage, isPackageAvailable } from '../utilities/package-utils.js';

// Optional isolated-vm for true V8 isolate sandboxing of JSON transforms
let isolatedVM: any = null;
const isolatedVMAvailable = isPackageAvailable('isolated-vm');
let jsonTransformWarningShown = false;

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
 * Dangerous globals that must be shadowed to prevent access from transformer code.
 * Passed as explicit undefined parameters to new Function() so they shadow the real globals.
 *
 * IMPORTANT: Shadowing alone is NOT sufficient — attackers can bypass it via the prototype
 * chain (e.g., [].constructor.constructor('return process')()). The blocklist patterns
 * below are the primary defense; shadowing is defense-in-depth.
 */
const DANGEROUS_GLOBALS = [
  // Node.js core
  'process',
  'require',
  'global',
  'globalThis',
  'Buffer',
  'module',
  // Code execution
  'eval',
  'Function',
  // File/module paths
  '__dirname',
  '__filename',
  // Network/IO
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  // Dynamic import
  'import',
  // Timer functions (can accept string code like eval)
  'setTimeout',
  'setInterval',
  'setImmediate',
  // Reflection/proxy (can be used to bypass restrictions)
  'Proxy',
  'Reflect',
  // Worker thread globals (this file runs in a worker)
  'parentPort',
  'workerData',
  // Advanced APIs
  'WebAssembly',
  'SharedArrayBuffer',
];

/**
 * Blocklist patterns that indicate potentially malicious transformer code.
 *
 * These are checked BEFORE execution and are the primary security layer.
 * The prototype chain bypass ([].constructor.constructor) is the #1 attack vector
 * against global shadowing, so we block access to prototype chain navigation.
 */
const DANGEROUS_IDENTIFIER_PATTERNS = DANGEROUS_GLOBALS.map(g => new RegExp(`\\b${g}\\b`));

/**
 * Structural patterns that indicate prototype chain attacks or other bypass attempts.
 * These catch attacks like [].constructor.constructor('return process')().
 */
const DANGEROUS_STRUCTURAL_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Prototype chain navigation — the #1 bypass for global shadowing
  // [].constructor.constructor, ''.constructor, ({}).constructor, etc.
  { pattern: /\.constructor\b/, description: 'prototype chain access (.constructor)' },
  { pattern: /\.__proto__\b/, description: 'prototype chain access (__proto__)' },
  { pattern: /\.prototype\b/, description: 'prototype access (.prototype)' },
  // Object reflection methods that can navigate the prototype chain
  { pattern: /\bgetPrototypeOf\b/, description: 'prototype chain navigation (getPrototypeOf)' },
  { pattern: /\bdefineProperty\b/, description: 'property definition (defineProperty)' },
  { pattern: /\bsetPrototypeOf\b/, description: 'prototype mutation (setPrototypeOf)' },
  // Bracket notation with dangerous identifiers — catches obj['constructor'], obj["__proto__"], etc.
  // Narrowly targeted: allows legitimate bracket access like data['first-name'] or ['a','b'] arrays
  {
    pattern:
      /\[\s*['"`]\s*(constructor|__proto__|prototype|process|require|global|globalThis|eval|Function|import|module|exports|parentPort|workerData)\s*['"`]\s*\]/,
    description: 'bracket notation access to blocked identifier',
  },
  // String concatenation tricks to reassemble blocked identifiers dynamically
  { pattern: /\bString\.fromCharCode\b/, description: 'dynamic string construction' },
  // Async patterns that could be used for deferred execution
  { pattern: /\bawait\b/, description: 'async execution (await)' },
  { pattern: /\bnew\s+Promise\b/, description: 'promise construction' },
];

/**
 * Validates that transformer code looks like a function expression (arrow or function keyword).
 * Rejects arbitrary statements, assignments to globals, etc.
 */
function validateTransformerShape(code: string): void {
  const trimmed = code.trim();

  // Must look like a function expression: starts with ( for arrow/grouped, function keyword,
  // or a single identifier followed by => (arrow shorthand like "data => data.x")
  const isArrowShorthand = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>/.test(trimmed);
  const isArrowParens = trimmed.startsWith('(');
  const isFunctionKeyword = trimmed.startsWith('function');

  if (!isArrowShorthand && !isArrowParens && !isFunctionKeyword) {
    throw new Error(
      'Transformer must be a function expression (arrow function or function keyword)'
    );
  }
}

/**
 * Checks transformer code against blocklist of dangerous identifiers and structural patterns.
 *
 * Layer 1: Block known dangerous global identifiers (process, require, etc.)
 * Layer 2: Block prototype chain navigation (.constructor, __proto__, etc.)
 * Layer 3: Block bracket notation string access (obj['constructor'] bypass)
 */
function checkDangerousPatterns(code: string): void {
  // Check dangerous global identifiers
  for (let i = 0; i < DANGEROUS_IDENTIFIER_PATTERNS.length; i++) {
    if (DANGEROUS_IDENTIFIER_PATTERNS[i].test(code)) {
      throw new Error(
        `Transformer code contains blocked identifier: "${DANGEROUS_GLOBALS[i]}". ` +
          'Transformer functions must be pure data transforms without access to Node.js internals.'
      );
    }
  }

  // Check structural bypass patterns (prototype chain, bracket notation, etc.)
  for (const { pattern, description } of DANGEROUS_STRUCTURAL_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(
        `Transformer code contains blocked pattern: ${description}. ` +
          'Transformer functions must be pure data transforms using only dot notation on the data parameter.'
      );
    }
  }
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
 * Execute a transformer using the hardened new Function() path.
 * This is NOT a true sandbox — it is defense-in-depth hardening only.
 */
function executeHardened(inputData: any, transformerCode: string): any {
  // Layer 1: Validate the code looks like a function expression
  validateTransformerShape(transformerCode);

  // Layer 2: Check for dangerous global identifiers and structural patterns
  checkDangerousPatterns(transformerCode);

  // Layer 3: Create function with dangerous globals explicitly shadowed as undefined
  const transformer = new Function(
    'data',
    ...DANGEROUS_GLOBALS,
    `'use strict'; return (${transformerCode})(data);`
  );

  // Execute with all dangerous globals set to undefined
  return transformer(inputData, ...DANGEROUS_GLOBALS.map(() => undefined));
}

/**
 * JSON transformation handler.
 *
 * Security model (two paths):
 *   1. If `isolated-vm` is installed: uses a true V8 isolate with memory/CPU limits.
 *      This is a real sandbox — the transformer cannot access Node.js APIs.
 *   2. Otherwise: uses a hardened new Function() with layered defenses (shape validation,
 *      blocklist, global shadowing, strict mode). This blocks common attacks but is NOT
 *      a true sandbox. Do not use this path with untrusted user-provided transformer code.
 *
 * To enable the secure path:
 *   npm install isolated-vm
 */
async function handleJSONTransform(data: { data: any; transformer: string }): Promise<any> {
  const { data: inputData, transformer: transformerCode } = data;

  try {
    if (isolatedVMAvailable) {
      return await executeInIsolate(inputData, transformerCode);
    }

    // Hardened fallback — emit a one-time warning
    if (!jsonTransformWarningShown) {
      jsonTransformWarningShown = true;
      // eslint-disable-next-line no-console -- one-time security notice in worker thread
      console.warn(
        '[MoroJS Security] transformJSON is using the hardened fallback (new Function). ' +
          'This is NOT a secure sandbox for untrusted code. If the transformer or data ' +
          'originates from user input, install isolated-vm for true V8 isolate sandboxing:\n' +
          '  npm install isolated-vm\n' +
          'See: https://www.npmjs.com/package/isolated-vm'
      );
    }

    return executeHardened(inputData, transformerCode);
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
