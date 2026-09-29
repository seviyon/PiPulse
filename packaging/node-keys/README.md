# Node release keys

`pubring.kbx` holds the Node.js release team's active signing keys, from
[`nodejs/release-keys`](https://github.com/nodejs/release-keys)
(`gpg-only-active-keys/pubring.kbx`). `fetch-node.sh` checks every Node
download's `SHASUMS256.txt` against them with `gpgv` before trusting it.

Refresh it when Node adds a releaser (a verification failure naming an
unknown key is the sign):

```bash
curl -fsSL -o packaging/node-keys/pubring.kbx https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx
```
