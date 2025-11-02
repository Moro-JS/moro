// @ts-nocheck
import { CronParser } from '../../../../src/core/jobs/cron-parser.js';

describe('CronParser', () => {
  describe('Cron Expression Parsing', () => {
    it('should parse wildcard expression', () => {
      const parser = new CronParser('* * * * *');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toHaveLength(60);
      expect(schedule.hours).toHaveLength(24);
      expect(schedule.daysOfMonth).toHaveLength(31);
      expect(schedule.months).toHaveLength(12);
      expect(schedule.daysOfWeek).toHaveLength(7);
    });

    it('should parse specific values', () => {
      const parser = new CronParser('5 10 15 6 3');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([5]);
      expect(schedule.hours).toEqual([10]);
      expect(schedule.daysOfMonth).toEqual([15]);
      expect(schedule.months).toEqual([6]);
      expect(schedule.daysOfWeek).toEqual([3]);
    });

    it('should parse comma-separated lists', () => {
      const parser = new CronParser('0,15,30,45 * * * *');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0, 15, 30, 45]);
    });

    it('should parse ranges', () => {
      const parser = new CronParser('1-5 * * * *');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([1, 2, 3, 4, 5]);
    });

    it('should parse step values', () => {
      const parser = new CronParser('*/15 * * * *');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0, 15, 30, 45]);
    });

    it('should parse step values with ranges', () => {
      const parser = new CronParser('10-30/5 * * * *');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([10, 15, 20, 25, 30]);
    });

    it('should parse complex expressions', () => {
      const parser = new CronParser('0,30 9-17 * * 1-5');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0, 30]);
      expect(schedule.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(schedule.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('Cron Macros', () => {
    it('should parse @yearly macro', () => {
      const parser = new CronParser('@yearly');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toEqual([0]);
      expect(schedule.daysOfMonth).toEqual([1]);
      expect(schedule.months).toEqual([1]);
    });

    it('should parse @monthly macro', () => {
      const parser = new CronParser('@monthly');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toEqual([0]);
      expect(schedule.daysOfMonth).toEqual([1]);
    });

    it('should parse @weekly macro', () => {
      const parser = new CronParser('@weekly');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toEqual([0]);
      expect(schedule.daysOfWeek).toEqual([0]);
    });

    it('should parse @daily macro', () => {
      const parser = new CronParser('@daily');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0]);
      expect(schedule.hours).toEqual([0]);
    });

    it('should parse @hourly macro', () => {
      const parser = new CronParser('@hourly');
      const schedule = parser.getSchedule();

      expect(schedule.minutes).toEqual([0]);
    });
  });

  describe('Next Run Calculation', () => {
    it('should calculate next run for every minute', () => {
      const parser = new CronParser('* * * * *');
      const from = new Date('2025-01-01T12:00:30Z');
      const { next } = parser.getNextRun(from);

      expect(next.getMinutes()).toBe(1);
      expect(next.getSeconds()).toBe(0);
    });

    it('should calculate next run for specific time', () => {
      const parser = new CronParser('0 14 * * *');
      const from = new Date('2025-01-01T12:00:00Z');
      const { next } = parser.getNextRun(from);

      expect(next.getHours()).toBe(14);
      expect(next.getMinutes()).toBe(0);
    });

    it('should roll over to next day if time has passed', () => {
      const parser = new CronParser('0 10 * * *');
      const from = new Date('2025-01-01T15:00:00Z');
      const { next } = parser.getNextRun(from);

      // Should be next day or same day depending on timezone
      expect(next.getTime()).toBeGreaterThan(from.getTime());
      expect(next.getHours()).toBe(10);
    });

    it('should calculate multiple next runs', () => {
      const parser = new CronParser('0 * * * *');
      const from = new Date('2025-01-01T12:00:00Z');
      const runs = parser.getNextRuns(3, from);

      expect(runs).toHaveLength(3);
      // Each run should be 1 hour apart
      expect(runs[1].getTime() - runs[0].getTime()).toBe(3600000);
      expect(runs[2].getTime() - runs[1].getTime()).toBe(3600000);
    });
  });

  describe('Validation', () => {
    it('should validate correct expressions', () => {
      const result = CronParser.validate('0 12 * * *');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid field count', () => {
      const result = CronParser.validate('0 12 *');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Expected 5 fields');
    });

    it('should reject invalid values', () => {
      const result = CronParser.validate('60 * * * *');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('should reject invalid step values', () => {
      const result = CronParser.validate('*/0 * * * *');
      expect(result.valid).toBe(false);
    });
  });

  describe('Description', () => {
    it('should describe simple expression', () => {
      const parser = new CronParser('30 14 * * *');
      const description = parser.describe();

      expect(description).toContain('minute 30');
      expect(description).toContain('hour 14');
    });

    it('should describe macros', () => {
      const parser = new CronParser('@daily');
      const description = parser.describe();

      expect(description).toBe('@daily');
    });
  });

  describe('Edge Cases', () => {
    it('should handle February edge case', () => {
      const parser = new CronParser('0 0 29 2 *');
      const from = new Date('2025-01-01T00:00:00Z');
      const { next } = parser.getNextRun(from);

      // Should find next Feb 29 (leap year)
      expect(next.getMonth()).toBe(1); // February
      expect(next.getDate()).toBe(29);
    });

    it('should handle end of month', () => {
      const parser = new CronParser('0 0 31 * *');
      const from = new Date('2025-02-01T00:00:00Z');
      const { next } = parser.getNextRun(from);

      // Should skip February (no 31st)
      expect(next.getMonth()).toBe(2); // March
      expect(next.getDate()).toBe(31);
    });

    it('should handle year boundary', () => {
      const parser = new CronParser('0 0 1 1 *');
      const from = new Date('2025-12-31T23:00:00Z');
      const { next } = parser.getNextRun(from);

      expect(next.getFullYear()).toBe(2026);
      expect(next.getMonth()).toBe(0); // January
      expect(next.getDate()).toBe(1);
    });
  });
});

