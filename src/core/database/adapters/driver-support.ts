// Shared by the database adapters: loading the user's driver package, and
// turning the adapters' TLS config into what the drivers hand to Node's TLS.
import { resolveUserPackage } from '../../utilities/package-utils.js';

const MODULE_NOT_FOUND_CODES = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

/**
 * Import a driver from the application's node_modules.
 *
 * Only a package that cannot be found is reported with `notInstalledMessage`
 * (the "install it" hint). Any other failure, such as a native binding that
 * does not load, is the driver's own error and is rethrown as it is.
 */
export async function importDriver(specifier: string, notInstalledMessage: string): Promise<any> {
  try {
    return await import(resolveUserPackage(specifier));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && MODULE_NOT_FOUND_CODES.has(code)) {
      throw new Error(notInstalledMessage);
    }
    throw error;
  }
}

/**
 * The adapters type `checkServerIdentity` as a boolean; Node's TLS takes a
 * function there and rejects anything else. `false` becomes a function that
 * accepts every host name (the certificate chain is still verified unless
 * `rejectUnauthorized` is off), `true` asks for the default check and is left
 * out, and a function is passed through untouched.
 */
export function tlsSocketOptions<T extends object>(
  options: T
): Omit<T, 'checkServerIdentity'> & {
  checkServerIdentity?: () => undefined;
} {
  const { checkServerIdentity, ...rest } = options as T & { checkServerIdentity?: unknown };
  if (checkServerIdentity === false) {
    return { ...rest, checkServerIdentity: acceptAnyServerIdentity };
  }
  if (typeof checkServerIdentity === 'function') {
    return { ...rest, checkServerIdentity: checkServerIdentity as () => undefined };
  }
  return rest;
}

/** A `checkServerIdentity` that accepts: the form Node expects for "do not check". */
export function acceptAnyServerIdentity(): undefined {
  return undefined;
}
