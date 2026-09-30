# potacat-sstv-packs

Cloudflare Worker that serves POTACAT's SSTV style packs: seasonal and event
scenery, palettes and headline lettering for SSTV templates. POTACAT fetches
the index 30 s after launch and every 6 hours (If-None-Match), and downloads a
pack when the operator claims it. Built like `worker/dxpeditions`: the handler
only reads KV and never depends on anything upstream.

Packs are made in the POTACAT repo under `data/sstv-packs/<id>/` (a
`pack.json`, plus any OFL font and its licence) and reviewed by pull request.
`lib/sstv-pack-validate.js` is the format; CI runs
`node scripts/validate-sstv-packs.js`.

## Endpoints

| Path | Purpose | Cache |
|---|---|---|
| `GET /feeds/sstv-packs.json` | The signed index | 5 min at the edge, ETag |
| `GET /packs/<id>@<version>.json` | One pack, exactly as in the repo | immutable |
| `GET /packs/<id>@<version>/<file>` | A font (`.woff2`, and since schema 2 its `.ttf`/`.otf` for the ECHOCAT app) or licence (`.txt`) the pack names | immutable |
| `GET /healthz` | `{ ok, packs, generated }` | none |

## Wire format

```jsonc
// /feeds/sstv-packs.json
{
  "index": "{\"schema\":1,\"generated\":\"…\",\"packs\":[…]}",  // a JSON STRING
  "sig": "<base64 ed25519 signature over the UTF-8 bytes of index>",
  "keyId": "potacat-packs-1"
}
// the parsed index
{
  "schema": 1,
  "generated": "<ISO 8601>",
  "packs": [
    { "id": "halloween", "name": "Halloween", "version": 2,
      "season": { "from": "10-01", "to": "11-02" }, "by": "POTACAT", "minApp": "1.10.27",
      "size": 6407, "sha256": "<hex of the pack.json bytes>",
      "files": [ { "name": "Rye-Regular.woff2", "size": 41416, "sha256": "<hex>" } ],
      "preview": null }
  ]
}
```

The app verifies the signature against the public key in `lib/sstv-packs.js`
before reading any field, then checks every download against its sha256, then
validates the pack. So the worker, its KV and the CDN are untrusted
transport.

## Publishing

The signing key lives outside the repo at `~/.potacat/sstv-pack-signing-key.pem`
(or `POTACAT_PACK_KEY`). Losing it means a new key in `lib/sstv-packs.js` and
an app release.

```sh
node scripts/publish-sstv-packs.js     # validates, signs, writes dist/sstv-packs/, prints the uploads
cd worker/sstv-packs
# then run the printed commands, e.g.
npx wrangler kv key put --binding=SSTV_PACKS --remote "packs/halloween@2.json" --path "../../dist/sstv-packs/packs/halloween@2.json"
# …packs and files first, feeds/sstv-packs.json LAST.
```

Upload order matters: an index must never name a pack that isn't in KV yet.
Old versions can stay in KV. They're immutable, and an app still on an older
index can finish its download.

## Deploying (once)

```sh
cd worker/sstv-packs
npx wrangler kv namespace create SSTV_PACKS   # paste the id into wrangler.toml
npx wrangler deploy
```

The custom domain `packs.potacat.com` assumes the `potacat.com` zone is in the
same Cloudflare account (as for `dxpeditions.potacat.com`).

## Smoke test (no deploy)

`node --check index.js`. Then `node scripts/sign-sstv-packs.js` and check the
output with `lib/sstv-packs.js`'s `verifyIndex`. `test/sstv-packs-test.js`
covers the client side.
