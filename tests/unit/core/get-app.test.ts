/* eslint-disable */
// Unit Tests - getApp() singleton accessor
import { describe, it, expect, beforeEach } from '@jest/globals';
import { createApp, getApp } from '../../../src/index.js';

describe('getApp()', () => {
  it('should return the app instance created by createApp()', async () => {
    const app = await createApp({ logger: { level: 'error' } });
    const retrieved = getApp();

    expect(retrieved).toBe(app);
  });

  it('should return the most recent app if createApp() is called multiple times', async () => {
    const first = await createApp({ logger: { level: 'error' } });
    const second = await createApp({ logger: { level: 'error' } });
    const retrieved = getApp();

    expect(retrieved).toBe(second);
    expect(retrieved).not.toBe(first);
  });

  it('should return a Moro instance with expected methods', async () => {
    await createApp({ logger: { level: 'error' } });
    const app = getApp();

    expect(typeof app.get).toBe('function');
    expect(typeof app.post).toBe('function');
    expect(typeof app.put).toBe('function');
    expect(typeof app.delete).toBe('function');
    expect(typeof app.patch).toBe('function');
    expect(typeof app.group).toBe('function');
    expect(typeof app.loadModule).toBe('function');
    expect(typeof app.listen).toBe('function');
    expect(typeof app.websocket).toBe('function');
  });
});
