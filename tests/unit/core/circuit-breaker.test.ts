 
// @ts-nocheck
// import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CircuitBreaker } from '../../../src/core/utilities/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 1000,
      monitoringPeriod: 5000,
    });
  });

  describe('CLOSED state (normal operation)', () => {
    it('should execute functions successfully when closed', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      const result = await circuitBreaker.execute(mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should track failures but stay closed under threshold', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      // Fail twice (under threshold of 3)
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should reset failure count on success', async () => {
      const mockFailFn = jest.fn().mockRejectedValue(new Error('fail'));
      const mockSuccessFn = jest.fn().mockResolvedValue('success');

      // Fail twice
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');

      // Then succeed
      const result = await circuitBreaker.execute(mockSuccessFn);
      expect(result).toBe('success');

      // Should be able to fail twice more without opening
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
    });
  });

  describe('OPEN state (circuit tripped)', () => {
    it('should open circuit after reaching failure threshold', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      // Fail 3 times to reach threshold
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');

      // Next call should be rejected immediately without calling function
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN');

      expect(mockFn).toHaveBeenCalledTimes(3); // Function not called on 4th attempt
    });

    it('should reject all calls immediately when open', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      // Trip the circuit
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');

      // Multiple calls should all be rejected immediately
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN');

      expect(mockFn).toHaveBeenCalledTimes(3); // No additional calls
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      const mockFailFn = jest.fn().mockRejectedValue(new Error('fail'));
      const mockSuccessFn = jest.fn().mockResolvedValue('success');

      // Trip the circuit
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');

      // Verify it's open
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('Circuit breaker is OPEN');

      // Wait for reset timeout (using fake timers would be better, but this works)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Next call should attempt execution (HALF_OPEN state)
      const result = await circuitBreaker.execute(mockSuccessFn);
      expect(result).toBe('success');
      expect(mockSuccessFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('HALF_OPEN state (recovery attempt)', () => {
    it('should close circuit on successful execution in half-open state', async () => {
      const mockFailFn = jest.fn().mockRejectedValue(new Error('fail'));
      const mockSuccessFn = jest.fn().mockResolvedValue('success');

      // Trip the circuit
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Successful call should close the circuit
      await circuitBreaker.execute(mockSuccessFn);

      // Should now work normally (CLOSED state)
      const result = await circuitBreaker.execute(mockSuccessFn);
      expect(result).toBe('success');
      expect(mockSuccessFn).toHaveBeenCalledTimes(2);
    });

    it('should reopen circuit on failure in half-open state', async () => {
      const mockFailFn = jest.fn().mockRejectedValue(new Error('fail'));

      // Trip the circuit
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Failure should reopen the circuit
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('fail');

      // Should be open again
      await expect(circuitBreaker.execute(mockFailFn)).rejects.toThrow('Circuit breaker is OPEN');

      expect(mockFailFn).toHaveBeenCalledTimes(4); // 3 initial + 1 half-open attempt
    });
  });

  describe('configuration options', () => {
    it('should respect custom failure threshold', async () => {
      const customBreaker = new CircuitBreaker({
        failureThreshold: 2, // Lower threshold
        resetTimeout: 1000,
        monitoringPeriod: 5000,
      });

      const mockFn = jest.fn().mockRejectedValue(new Error('fail'));

      // Should open after 2 failures instead of 3
      await expect(customBreaker.execute(mockFn)).rejects.toThrow('fail');
      await expect(customBreaker.execute(mockFn)).rejects.toThrow('fail');

      // Should be open now
      await expect(customBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN');

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should respect custom reset timeout', async () => {
      const fastBreaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 500, // Shorter timeout
        monitoringPeriod: 5000,
      });

      const mockFailFn = jest.fn().mockRejectedValue(new Error('fail'));
      const mockSuccessFn = jest.fn().mockResolvedValue('success');

      // Trip the circuit
      await expect(fastBreaker.execute(mockFailFn)).rejects.toThrow('fail');
      await expect(fastBreaker.execute(mockFailFn)).rejects.toThrow('fail');

      // Verify it's open
      await expect(fastBreaker.execute(mockFailFn)).rejects.toThrow('Circuit breaker is OPEN');

      // Wait for shorter reset timeout
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should allow execution again
      const result = await fastBreaker.execute(mockSuccessFn);
      expect(result).toBe('success');
    });
  });

  describe('error propagation', () => {
    it('should propagate original errors when circuit is closed', async () => {
      const customError = new Error('Custom error message');
      const mockFn = jest.fn().mockRejectedValue(customError);

      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Custom error message');
      await expect(circuitBreaker.execute(mockFn)).rejects.toBe(customError);
    });

    it('should throw circuit breaker specific error when open', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('original error'));

      // Trip the circuit
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('original error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('original error');
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('original error');

      // Should throw circuit breaker error, not original error
      await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN');
      await expect(circuitBreaker.execute(mockFn)).rejects.not.toThrow('original error');
    });
  });
});
