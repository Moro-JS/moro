# TEST-ONLY TLS fixtures

**The private keys in this directory are intentionally public.** They exist so
the TLS conformance suites are deterministic on every platform without a
runtime `openssl` dependency. Never reuse any of this material outside tests.

| File                                | What                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `ca.key` / `ca.pem`                 | Test CA (ECDSA P-256) — clients pass `ca.pem` to trust the leaves            |
| `localhost.key` / `localhost.pem`   | Primary server cert, ECDSA P-256, SAN `localhost, 127.0.0.1, ::1`, CA-signed |
| `localhost-encrypted.key`           | Same key, PKCS#8 AES-256, passphrase `moro-test`                             |
| `rsa.key` / `rsa.pem`               | RSA-2048 leaf, same SANs (algorithm coverage)                                |
| `alt.key` / `alt.pem`               | SAN `alt.example.test` (SNI second identity)                                 |
| `selfsigned.key` / `selfsigned.pem` | Self-signed, NOT CA-signed (unknown-CA rejection tests)                      |

Key/cert **mismatch** tests need no fixture: pass `localhost.key` with
`alt.pem`.

Regenerate with `sh gen.sh` (36500-day expiry — these must never rot in CI).
