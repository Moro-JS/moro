// How a store key appears in a log line when it is a secret in its own right.

/**
 * A short tag for a key that must not be written to a log: a session id is
 * all a client needs to be that session, so anyone who can read the log could
 * otherwise take one over. The tag is a 32-bit hash of the key (FNV-1a) with
 * the key's length - the same key always gives the same tag, so lines about
 * one session can still be followed, and the key cannot be read back from it.
 * Cheap enough for a debug line that is built on every request.
 */
export function keyTag(key: unknown): string {
  const text = typeof key === 'string' ? key : String(key);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `#${(hash >>> 0).toString(16).padStart(8, '0')}(${text.length})`;
}
