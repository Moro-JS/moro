#!/bin/sh
# Regenerates the committed TEST-ONLY PKI. Run from this directory:
#   sh gen.sh
# Output is committed so tests are deterministic on every platform with no
# runtime openssl dependency. 36500-day expiry: these must never rot in CI.
#
# THESE PRIVATE KEYS ARE INTENTIONALLY PUBLIC. Never reuse for anything real.
set -eu

DAYS=36500
PASS=moro-test

# --- Test CA (ECDSA P-256) ---------------------------------------------------
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -days "$DAYS" -sha256 \
  -subj "/CN=MoroJS Test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.pem

# SAN extension shared by the localhost-facing leaves
cat > san-localhost.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment,keyAgreement
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
EOF

cat > san-alt.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment,keyAgreement
extendedKeyUsage=serverAuth
subjectAltName=DNS:alt.example.test
EOF

# --- localhost leaf, ECDSA P-256 (primary server cert) ------------------------
openssl ecparam -name prime256v1 -genkey -noout -out localhost.key
openssl req -new -key localhost.key -subj "/CN=localhost" -out localhost.csr
openssl x509 -req -in localhost.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -sha256 -extfile san-localhost.ext -out localhost.pem

# Encrypted copy of the localhost key (passphrase tests). PKCS#8 AES-256.
openssl pkcs8 -topk8 -in localhost.key -passout "pass:$PASS" \
  -v2 aes-256-cbc -out localhost-encrypted.key

# --- RSA-2048 leaf (algorithm coverage) ---------------------------------------
openssl genrsa -out rsa.key 2048
openssl req -new -key rsa.key -subj "/CN=localhost" -out rsa.csr
openssl x509 -req -in rsa.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -sha256 -extfile san-localhost.ext -out rsa.pem

# --- alt.example.test leaf (SNI second identity) ------------------------------
openssl ecparam -name prime256v1 -genkey -noout -out alt.key
openssl req -new -key alt.key -subj "/CN=alt.example.test" -out alt.csr
openssl x509 -req -in alt.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -sha256 -extfile san-alt.ext -out alt.pem

# --- self-signed leaf, NOT CA-signed (unknown-CA rejection tests) --------------
openssl ecparam -name prime256v1 -genkey -noout -out selfsigned.key
openssl req -x509 -new -key selfsigned.key -days "$DAYS" -sha256 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -out selfsigned.pem

rm -f localhost.csr rsa.csr alt.csr san-localhost.ext san-alt.ext ca.srl
echo "done - fixture PKI regenerated"
