// permessage-deflate on the `ws` library, for the two adapters that serve
// WebSockets with it: the ws adapter, and Socket.IO, whose WebSocket transport
// is a `ws` server. What `websocket.compression: true` hands to `ws`, and the
// handshakes `ws` would refuse once it is on.

/**
 * The server's window, in bits: 4 KB. A message is compressed on its own (see
 * below), so the window only has to span one message; JSON loses a few percent
 * against the 32 KB default and the compressor is a fraction of the size.
 */
const SERVER_MAX_WINDOW_BITS = 12;

/**
 * `perMessageDeflate` as given to `ws` when compression is asked for.
 *
 * - threshold: a message under 1024 bytes is sent as it is, as on the native
 *   engine. `ws` applies its threshold only without context takeover.
 * - serverNoContextTakeover: each message the server sends is compressed on
 *   its own, with nothing carried over from the one before.
 * - serverMaxWindowBits, memLevel and chunkSize keep the zlib streams `ws`
 *   holds per connection small. They are created with the first compressed
 *   message in each direction and kept until the connection closes: measured
 *   on the ws adapter, about 200 KB a connection with these settings, where
 *   the `ws` defaults hold nearly twice that (an uncompressed connection:
 *   about 30 KB).
 * - concurrencyLimit is left at the `ws` default: ten zlib jobs at a time for
 *   the whole process.
 *
 * A message is refused (close code 1009) once it inflates past the server's
 * `maxPayload`: `ws` counts the inflated bytes against the same limit as the
 * bytes of an uncompressed message.
 */
export function wsPerMessageDeflate(): Record<string, unknown> {
  return {
    threshold: 1024,
    serverNoContextTakeover: true,
    serverMaxWindowBits: SERVER_MAX_WINDOW_BITS,
    zlibDeflateOptions: { memLevel: 5, chunkSize: 4096 },
    zlibInflateOptions: { chunkSize: 4096 },
  };
}

// A Sec-WebSocket-Extensions value `ws` is certain to take: a list of
// extensions, each a token with `; name` or `; name=token` parameters, where
// a permessage-deflate offer carries only its four parameters, with values in
// range. Deliberately narrower than what `ws` parses (no quoted values, no
// blanks around `=`).
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const WINDOW_BITS = '(?:[89]|1[0-5])';
const DEFLATE_OFFER =
  'permessage-deflate(?:;[ \\t]*(?:server_no_context_takeover|client_no_context_takeover' +
  `|client_max_window_bits(?:=${WINDOW_BITS})?|server_max_window_bits=${WINDOW_BITS}))*`;
const OTHER_EXTENSION = `(?!permessage-deflate[ \\t]*(?:[;,]|$))${TOKEN}(?:;[ \\t]*${TOKEN}(?:=${TOKEN})?)*`;
const EXTENSION = `(?:${DEFLATE_OFFER}|${OTHER_EXTENSION})`;
const WELL_FORMED = new RegExp(`^${EXTENSION}(?:,[ \\t]*${EXTENSION})*$`);
const SERVER_WINDOW = /server_max_window_bits=(\d+)/;

/**
 * Take the extension offers out of a handshake that `ws` would answer 400
 * with compression on: one it cannot parse, a permessage-deflate offer with a
 * parameter it does not know or one given twice, and (with a server window
 * configured) an offer asking for a smaller one, `server_max_window_bits`
 * under 12. Such a client connects when compression is off; this way it
 * still does, and is served uncompressed.
 */
export function declineUnacceptableOffers(req: {
  headers?: Record<string, string | string[] | undefined>;
}): void {
  const header = req.headers?.['sec-websocket-extensions'];
  if (header === undefined) return;
  const offers = (Array.isArray(header) ? header.join(', ') : header).trim();
  if (WELL_FORMED.test(offers)) {
    let acceptable = true;
    for (const offer of offers.split(',')) {
      const parameters = offer.split(';').map(part => part.trim().split('=')[0]);
      if (parameters[0] !== 'permessage-deflate') continue;
      const window = SERVER_WINDOW.exec(offer);
      if (
        new Set(parameters).size !== parameters.length ||
        (window !== null && Number(window[1]) < SERVER_MAX_WINDOW_BITS)
      ) {
        acceptable = false;
        break;
      }
    }
    if (acceptable) return;
  }
  delete req.headers?.['sec-websocket-extensions'];
}
