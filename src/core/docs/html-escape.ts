// Escaping for values interpolated into the generated documentation pages.
// Titles, descriptions, paths and tags come from route metadata and
// configuration, and each must be written for the context it lands in.

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for HTML text content or for a quoted attribute value. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char] as string);
}

const SCRIPT_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * Write a value as a JavaScript literal for an inline <script>: JSON, with the
 * characters that could end the script element or the statement written as
 * \uXXXX escapes. `undefined` stays `undefined`.
 */
export function toScriptLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'undefined';
  return json.replace(/[<>&\u2028\u2029]/g, char => SCRIPT_ESCAPES[char] as string);
}
