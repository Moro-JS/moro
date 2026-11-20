# TEST-ONLY TLS fixtures

**The leaf private keys in this directory are intentionally public.** They exist
so the TLS conformance suites are deterministic on every platform without a
runtime `openssl` dependency. Never reuse any of this material outside tests.

| File                                | What                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `ca.pem`                            | Test CA certificate (ECDSA P-256) — clients pass it to trust the leaves      |
| `localhost.key` / `localhost.pem`   | Primary server cert, ECDSA P-256, SAN `localhost, 127.0.0.1, ::1`, CA-signed |
| `localhost-encrypted.key`           | Same key, PKCS#8 AES-256, passphrase `moro-test`                             |
| `rsa.key` / `rsa.pem`               | RSA-2048 leaf, same SANs (algorithm coverage)                                |
| `alt.key` / `alt.pem`               | SAN `alt.example.test` (SNI second identity)                                 |
| `selfsigned.key` / `selfsigned.pem` | Self-signed, NOT CA-signed (unknown-CA rejection tests)                      |
| `ed448.key` / `ed448.pem`           | Self-signed Ed448 leaf (a key type only the OpenSSL build of the engine has) |

**There is no CA private key, here or anywhere.** `gen.sh` creates it in a
temporary directory, signs the three CA-signed leaves and deletes it, so no
further certificate can be issued under `ca.pem`. The CA is also limited by
name constraints to `localhost`, `*.test`, `127.0.0.1` and `::1`. Trusting
`ca.pem` therefore vouches for the leaves above and nothing else; it still has
no business in a system or browser trust store.

Key/cert **mismatch** tests need no fixture: pass `localhost.key` with
`alt.pem`.

Regenerate with `sh gen.sh` (36500-day expiry — these must never rot in CI).
It needs OpenSSL 3 (Ed448 and `-addext`; the LibreSSL that macOS ships as
`/usr/bin/openssl` will not do) and replaces every file, the CA included.
