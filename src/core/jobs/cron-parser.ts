// Production-grade Cron Expression Parser
// Supports standard 5-field cron syntax + extended macros

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

export interface NextRunResult {
  next: Date;
  delay: number;
}

// Macro definitions for common schedules
const CRON_MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@every-15m': '*/15 * * * *',
  '@every-30m': '*/30 * * * *',
};

export class CronParser {
  private schedule: CronSchedule;
  private timezone: string;
  private originalExpression: string;

  constructor(expression: string, timezone: string = 'UTC') {
    this.originalExpression = expression;
    this.timezone = timezone;

    // Handle macros
    const normalizedExpression = CRON_MACROS[expression.toLowerCase()] || expression;
    this.schedule = this.parse(normalizedExpression);
  }

  /**
   * Parse cron expression into schedule object
   * Format: minute hour dayOfMonth month dayOfWeek
   * Each field can be: *, number, range (1-5), step (*\/2), list (1,3,5)
   */
  private parse(expression: string): CronSchedule {
    const fields = expression.trim().split(/\s+/);

    if (fields.length !== 5) {
      throw new Error(
        `Invalid cron expression "${this.originalExpression}". Expected 5 fields (minute hour day month weekday), got ${fields.length}`
      );
    }

    const [minuteField, hourField, dayField, monthField, weekdayField] = fields;

    return {
      minutes: this.parseField(minuteField, 0, 59, 'minute'),
      hours: this.parseField(hourField, 0, 23, 'hour'),
      daysOfMonth: this.parseField(dayField, 1, 31, 'day of month'),
      months: this.parseField(monthField, 1, 12, 'month'),
      daysOfWeek: this.parseField(weekdayField, 0, 6, 'day of week'),
    };
  }

  /**
   * Parse individual cron field
   */
  private parseField(field: string, min: number, max: number, fieldName: string): number[] {
    if (!field || field.trim() === '') {
      throw new Error(`Empty field for ${fieldName}`);
    }

    // Wildcard - all values
    if (field === '*') {
      return this.range(min, max);
    }

    const values = new Set<number>();

    // Handle comma-separated values
    const parts = field.split(',');

    for (const part of parts) {
      // Step values: */5 or 1-10/2
      if (part.includes('/')) {
        const [rangeOrWildcard, stepStr] = part.split('/');
        const step = parseInt(stepStr, 10);

        if (isNaN(step) || step <= 0) {
          throw new Error(`Invalid step value "${stepStr}" in ${fieldName}`);
        }

        let rangeStart = min;
        let rangeEnd = max;

        if (rangeOrWildcard !== '*') {
          if (rangeOrWildcard.includes('-')) {
            const [start, end] = rangeOrWildcard.split('-').map(v => parseInt(v, 10));
            rangeStart = start;
            rangeEnd = end;
          } else {
            rangeStart = parseInt(rangeOrWildcard, 10);
            rangeEnd = max;
          }
        }

        for (let i = rangeStart; i <= rangeEnd; i += step) {
          if (i >= min && i <= max) {
            values.add(i);
          }
        }
      }
      // Range: 1-5
      else if (part.includes('-')) {
        const [startStr, endStr] = part.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);

        if (isNaN(start) || isNaN(end)) {
          throw new Error(`Invalid range "${part}" in ${fieldName}`);
        }

        if (start > end) {
          throw new Error(`Invalid range "${part}" in ${fieldName}: start > end`);
        }

        for (let i = start; i <= end; i++) {
          if (i >= min && i <= max) {
            values.add(i);
          }
        }
      }
      // Single value
      else {
        const value = parseInt(part, 10);

        if (isNaN(value)) {
          throw new Error(`Invalid value "${part}" in ${fieldName}`);
        }

        if (value < min || value > max) {
          throw new Error(`Value ${value} out of range [${min}-${max}] in ${fieldName}`);
        }

        values.add(value);
      }
    }

    if (values.size === 0) {
      throw new Error(`No valid values parsed for ${fieldName}`);
    }

    return Array.from(values).sort((a, b) => a - b);
  }

  /**
   * Generate range of numbers [min, max]
   */
  private range(min: number, max: number): number[] {
    const result: number[] = [];
    for (let i = min; i <= max; i++) {
      result.push(i);
    }
    return result;
  }

  /**
   * Calculate next run time from given date
   */
  public getNextRun(from: Date = new Date()): NextRunResult {
    const next = this.calculateNextRun(from);
    const delay = next.getTime() - from.getTime();

    return { next, delay };
  }

  /**
   * Calculate all next N run times
   */
  public getNextRuns(count: number, from: Date = new Date()): Date[] {
    const runs: Date[] = [];
    let current = from;

    for (let i = 0; i < count; i++) {
      const { next } = this.getNextRun(current);
      runs.push(next);
      current = new Date(next.getTime() + 1000); // Move 1 second forward
    }

    return runs;
  }

  /**
   * Core algorithm to find next matching time
   */
  private calculateNextRun(from: Date): Date {
    // Start from next minute (reset seconds and milliseconds)
    let candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Prevent infinite loop with max iterations
    let iterations = 0;
    const maxIterations = 4 * 365 * 24 * 60; // 4 years in minutes

    while (iterations < maxIterations) {
      if (this.matches(candidate)) {
        return candidate;
      }

      // Move to next minute
      candidate = new Date(candidate.getTime() + 60000);
      iterations++;
    }

    throw new Error(
      `Could not find next run time for cron expression "${this.originalExpression}" within 4 years`
    );
  }

  /**
   * Check if date matches cron schedule
   */
  private matches(date: Date): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // JS months are 0-indexed
    const dayOfWeek = date.getDay();

    // All fields must match
    return (
      this.schedule.minutes.includes(minute) &&
      this.schedule.hours.includes(hour) &&
      this.schedule.daysOfMonth.includes(dayOfMonth) &&
      this.schedule.months.includes(month) &&
      this.schedule.daysOfWeek.includes(dayOfWeek)
    );
  }

  /**
   * Validate if expression is valid
   */
  public static validate(expression: string): { valid: boolean; error?: string } {
    try {
      new CronParser(expression);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get human-readable description
   */
  public describe(): string {
    if (CRON_MACROS[this.originalExpression.toLowerCase()]) {
      return this.originalExpression;
    }

    const parts: string[] = [];

    // Minutes
    if (this.schedule.minutes.length === 60) {
      parts.push('every minute');
    } else if (this.schedule.minutes.length === 1) {
      parts.push(`at minute ${this.schedule.minutes[0]}`);
    } else {
      parts.push(`at minutes ${this.schedule.minutes.join(', ')}`);
    }

    // Hours
    if (this.schedule.hours.length !== 24) {
      if (this.schedule.hours.length === 1) {
        parts.push(`at hour ${this.schedule.hours[0]}`);
      } else {
        parts.push(`at hours ${this.schedule.hours.join(', ')}`);
      }
    }

    return parts.join(', ');
  }

  /**
   * Get schedule details
   */
  public getSchedule(): CronSchedule {
    return { ...this.schedule };
  }
}
