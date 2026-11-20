// Logging a failure whose message spans several lines

interface ErrorLineLogger {
  error(message: string, context?: string, metadata?: Record<string, any>): void;
}

/**
 * Log `<prefix>: <error>` one line per log entry. Messages that carry an
 * install hint ("package not found", then the command to run) span several
 * lines, and a log entry is a single line: the first line goes out with the
 * prefix, every further non-empty line as an entry of its own, indentation
 * kept. The error itself is left as it is for whoever catches it.
 */
export function logErrorLines(
  logger: ErrorLineLogger,
  prefix: string,
  error: unknown,
  context?: string
): void {
  const lines = String(error)
    .split(/\r\n|\r|\n/)
    .map(line => line.trimEnd())
    .filter(line => line !== '');

  logger.error(`${prefix}: ${lines[0] ?? ''}`, context);
  for (let i = 1; i < lines.length; i++) {
    logger.error(lines[i] as string, context);
  }
}
