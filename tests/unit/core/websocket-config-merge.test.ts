// Unit Tests - WebSocket config merge (moro.config.ts + createApp() options)
import { describe, it, expect } from '@jest/globals';
import { mergeWebSocketConfig } from '../../../src/core/networking/websocket-adapter.js';

describe('mergeWebSocketConfig', () => {
  it('returns config when options are empty', () => {
    const cfg = {
      enabled: true,
      adapter: 'socket.io',
      options: { path: '/a/', cors: { origin: ['http://localhost:3000'], credentials: true } },
    };
    const merged = mergeWebSocketConfig(cfg, {});
    expect(merged.adapter).toBe('socket.io');
    expect(merged.options.path).toBe('/a/');
    expect(merged.options.cors.origin).toEqual(['http://localhost:3000']);
    expect(merged.options.cors.credentials).toBe(true);
  });

  it('returns options when config is empty', () => {
    const opts = { adapter: 'ws', options: { path: '/b/' } };
    const merged = mergeWebSocketConfig({}, opts);
    expect(merged.adapter).toBe('ws');
    expect(merged.options.path).toBe('/b/');
  });

  it('createApp() options override moro.config.ts at top level', () => {
    const cfg = { adapter: 'socket.io', compression: false };
    const opts = { adapter: 'ws', compression: true };
    const merged = mergeWebSocketConfig(cfg, opts);
    expect(merged.adapter).toBe('ws');
    expect(merged.compression).toBe(true);
  });

  it('createApp() options.path overrides config.options.path', () => {
    const cfg = { options: { path: '/a/' } };
    const opts = { options: { path: '/b/' } };
    const merged = mergeWebSocketConfig(cfg, opts);
    expect(merged.options.path).toBe('/b/');
  });

  it('merges cors fields from both sides with options winning', () => {
    const cfg = { options: { cors: { origin: ['http://a'], credentials: true } } };
    const opts = { options: { cors: { origin: ['http://b'] } } };
    const merged = mergeWebSocketConfig(cfg, opts);
    expect(merged.options.cors.origin).toEqual(['http://b']);
    expect(merged.options.cors.credentials).toBe(true);
  });

  it('preserves config.options keys not in opts.options', () => {
    const cfg = { options: { path: '/a/', maxPayloadLength: 16384 } };
    const opts = { options: { path: '/b/' } };
    const merged = mergeWebSocketConfig(cfg, opts);
    expect(merged.options.path).toBe('/b/');
    expect(merged.options.maxPayloadLength).toBe(16384);
  });

  it('preserves adapter instance passed via options (regression)', () => {
    const instance = { initialize: () => {}, getAdapterName: () => 'custom' };
    const merged = mergeWebSocketConfig({ adapter: 'socket.io' }, { adapter: instance });
    expect(merged.adapter).toBe(instance);
  });

  it('handles both sides nullish', () => {
    expect(mergeWebSocketConfig(undefined, undefined)).toEqual({ options: { cors: {} } });
    expect(mergeWebSocketConfig(null, null)).toEqual({ options: { cors: {} } });
  });
});
