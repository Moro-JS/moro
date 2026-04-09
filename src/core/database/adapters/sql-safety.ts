// SQL Identifier Safety — validates and quotes table/column names to prevent injection

const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_DOTTED_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/**
 * Validates that a SQL identifier (table or column name) contains only safe characters.
 * Rejects anything that doesn't match alphanumeric + underscores (+ dots for schema.table).
 */
function validateIdentifier(name: string, allowDots = false): void {
  const pattern = allowDots ? VALID_DOTTED_IDENTIFIER : VALID_IDENTIFIER;
  if (!pattern.test(name)) {
    throw new Error(
      `Invalid SQL identifier: "${name}". Identifiers must be alphanumeric/underscore only.`
    );
  }
}

/**
 * Quotes a SQL identifier for PostgreSQL/SQLite (double quotes).
 * Also validates the identifier is safe.
 */
export function quoteIdentifier(name: string): string {
  validateIdentifier(name, name.includes('.'));
  if (name.includes('.')) {
    return name
      .split('.')
      .map(part => `"${part}"`)
      .join('.');
  }
  return `"${name}"`;
}

/**
 * Quotes a SQL identifier for MySQL (backticks).
 * Also validates the identifier is safe.
 */
export function quoteIdentifierMySQL(name: string): string {
  validateIdentifier(name, name.includes('.'));
  if (name.includes('.')) {
    return name
      .split('.')
      .map(part => `\`${part}\``)
      .join('.');
  }
  return `\`${name}\``;
}

/**
 * Quotes an array of column names and joins with commas.
 */
export function quoteColumns(keys: string[], quoteFn: (name: string) => string): string {
  return keys.map(quoteFn).join(', ');
}

/**
 * Builds a SET clause like "col1" = ?, "col2" = ? for UPDATE statements.
 */
export function buildSetClause(
  keys: string[],
  quoteFn: (name: string) => string,
  paramStyle: 'question' | 'dollar' = 'question',
  startIndex = 1
): string {
  return keys
    .map((key, index) => {
      const param = paramStyle === 'dollar' ? `$${startIndex + index}` : '?';
      return `${quoteFn(key)} = ${param}`;
    })
    .join(', ');
}

/**
 * Builds a WHERE clause like "col1" = ? AND "col2" = ? for queries.
 */
export function buildWhereClause(
  keys: string[],
  quoteFn: (name: string) => string,
  paramStyle: 'question' | 'dollar' = 'question',
  startIndex = 1
): string {
  return keys
    .map((key, index) => {
      const param = paramStyle === 'dollar' ? `$${startIndex + index}` : '?';
      return `${quoteFn(key)} = ${param}`;
    })
    .join(' AND ');
}
