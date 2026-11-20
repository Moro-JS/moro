/**
 * Job message decoding shared by the broker-backed queue adapters
 * (RabbitMQ, Kafka, SQS).
 *
 * A broker delivers whatever was published to the queue: a job enqueued by
 * this process, a job enqueued by another process (or before a restart), or
 * something that is not a job message at all. The message body is therefore
 * decoded exactly once, here, and never trusted to have a particular shape.
 */

import { randomUUID } from 'crypto';
import type { JobOptions } from '../types.js';

/**
 * A decoded job message
 */
export interface JobMessage {
  /** Job id from the body, else the broker's own message id, else generated */
  jobId: string;
  data: any;
  /** Always an object (defaults to `{}` when the body carries none) */
  options: JobOptions;
  /** Enqueue time from the body, else now */
  timestamp: number;
  /** Failed attempts carried with the message (0 on first delivery) */
  attemptsMade: number;
  /** The decoded body as published */
  body: Record<string, any>;
}

/**
 * Decode a job message body.
 *
 * Returns `null` when the payload is missing, is not valid JSON, or is not a
 * JSON object. Never throws.
 */
export function decodeJobMessage(raw: unknown, fallbackId?: unknown): JobMessage | null {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof Uint8Array) {
    text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  } else {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, any>;

  let jobId: string;
  if ((typeof record.jobId === 'string' && record.jobId) || typeof record.jobId === 'number') {
    // A numeric id from a non-Moro producer is passed through as published
    jobId = record.jobId as string;
  } else if (typeof fallbackId === 'string' && fallbackId) {
    jobId = fallbackId;
  } else {
    jobId = randomUUID();
  }

  const options: JobOptions =
    record.options !== null && typeof record.options === 'object' && !Array.isArray(record.options)
      ? record.options
      : {};

  const timestamp =
    typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();

  const attemptsMade =
    typeof record.attemptsMade === 'number' &&
    Number.isFinite(record.attemptsMade) &&
    record.attemptsMade > 0
      ? Math.floor(record.attemptsMade)
      : 0;

  return { jobId, data: record.data, options, timestamp, attemptsMade, body: record };
}
