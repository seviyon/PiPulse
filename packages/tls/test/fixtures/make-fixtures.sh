#!/bin/sh
# make-fixtures.sh — regenerates the committed test certificates (needs OpenSSL 3).
# The keys here are for tests only; nothing else may use them.
set -eu
cd "$(dirname "$0")"
openssl version | grep -q '^OpenSSL 3' || { echo 'make-fixtures.sh needs OpenSSL 3' >&2; exit 1; }
WORK=$(mktemp -d)
export WORK
trap 'rm -rf "$WORK"' EXIT
: > "$WORK/index.txt"
echo 1000 > "$WORK/serial"
cat > "$WORK/ca.cnf" <<'EOF'
[ca]
default_ca = fixture
[fixture]
database = $ENV::WORK/index.txt
new_certs_dir = $ENV::WORK
serial = $ENV::WORK/serial
default_md = sha256
policy = any
unique_subject = no
copy_extensions = none
[any]
commonName = supplied
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, DNS:pipulse.test, IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[v3_dns_only]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:example.internal
[v3_ip_only]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1
[v3_no_san]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
EOF

ec() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1"; }
# sign KEY CN ISSUER_CRT|self ISSUER_KEY EXTENSIONS START END OUT
sign() {
  openssl req -new -key "$1" -subj "/CN=$2" -out "$WORK/req.csr"
  if [ "$3" = self ]; then
    openssl ca -batch -config "$WORK/ca.cnf" -selfsign -keyfile "$1" -extensions "$5" \
      -startdate "$6" -enddate "$7" -in "$WORK/req.csr" -out "$8" -notext
  else
    openssl ca -batch -config "$WORK/ca.cnf" -cert "$3" -keyfile "$4" -extensions "$5" \
      -startdate "$6" -enddate "$7" -in "$WORK/req.csr" -out "$8" -notext
  fi
}
NOW=20260101000000Z
FAR=21260101000000Z
LEAF_END=21250101000000Z

ec root-ca.key
sign root-ca.key 'PiPulse Test Root' self - v3_ca "$NOW" "$FAR" root-ca.crt
ec intermediate.key
sign intermediate.key 'PiPulse Test Intermediate' root-ca.crt root-ca.key v3_ca "$NOW" "$FAR" intermediate.crt
ec leaf.key
sign leaf.key localhost intermediate.crt intermediate.key v3_leaf "$NOW" "$LEAF_END" leaf.crt
ec leaf2.key
sign leaf2.key localhost intermediate.crt intermediate.key v3_leaf "$NOW" "$LEAF_END" leaf2.crt
ec expired.key
sign expired.key localhost intermediate.crt intermediate.key v3_leaf 20200101000000Z 20210101000000Z expired.crt
ec future.key
sign future.key localhost intermediate.crt intermediate.key v3_leaf 21200101000000Z 21210101000000Z future.crt
ec other-ca.key
sign other-ca.key 'Unrelated Test Root' self - v3_ca "$NOW" "$FAR" other-ca.crt
ec other-leaf.key
sign other-leaf.key localhost other-ca.crt other-ca.key v3_leaf "$NOW" "$LEAF_END" other-leaf.crt
ec dns-only.key
sign dns-only.key example.internal intermediate.crt intermediate.key v3_dns_only "$NOW" "$LEAF_END" dns-only.crt
ec ip-only.key
sign ip-only.key 127.0.0.1 intermediate.crt intermediate.key v3_ip_only "$NOW" "$LEAF_END" ip-only.crt
openssl pkey -in leaf.key -traditional -out leaf.ec.key
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/rsa.key"
openssl pkey -in "$WORK/rsa.key" -traditional -out rsa-leaf.rsa.key
sign "$WORK/rsa.key" localhost intermediate.crt intermediate.key v3_leaf "$NOW" "$LEAF_END" rsa-leaf.crt
openssl pkcs8 -topk8 -in leaf.key -out leaf.encrypted.key -passout pass:test
ec cn-only.key
sign cn-only.key io.lan intermediate.crt intermediate.key v3_no_san "$NOW" "$LEAF_END" cn-only.crt
# A valid leaf under an intermediate that expired long ago.
ec expired-intermediate.key
sign expired-intermediate.key 'PiPulse Test Expired Intermediate' root-ca.crt root-ca.key v3_ca 20200101000000Z 20210101000000Z expired-intermediate.crt
ec under-expired.key
sign under-expired.key localhost expired-intermediate.crt expired-intermediate.key v3_leaf "$NOW" "$LEAF_END" under-expired.crt
chmod 600 ./*.key
echo 'fixtures written'
