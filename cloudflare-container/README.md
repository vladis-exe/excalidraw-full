# Deploying excalidraw-full to Cloudflare Containers

Builds this repo (Go backend + the `excalidraw` frontend submodule) from
`../excalidraw-complete.Dockerfile` and runs it on Cloudflare's container platform
behind `excali.vladislav.cc`, using R2 for canvas storage. Cloudflare Access guards
the domain, and the app logs users in from the Access assertion — there is no
separate login screen or OAuth app.

## 0. Prerequisites (in the Cloudflare dashboard)

1. **R2 bucket + API token**: bucket `excali-bucket` already exists, account ID
   `2ec3895df483d0b8f21977a47c3a741e`. R2 → Manage API tokens → create a token
   scoped to that bucket (Object Read & Write). Save the Access Key ID and
   Secret Access Key it gives you.
2. **Access application for the domain**: Zero Trust → Access → Applications → Add
   an application → **Self-hosted**, domain `excali.vladislav.cc`, with a policy that
   allows only your email. Copy its **Application Audience (AUD) tag** into
   `CF_ACCESS_AUD` in `wrangler.jsonc` (it's not a secret). `CF_ACCESS_TEAM_DOMAIN`
   is your Zero Trust team domain (`https://<team>.cloudflareaccess.com`).
3. **Custom domain**: handled by `wrangler.jsonc`'s `routes` block on deploy — as long
   as no other Worker already claims `excali.vladislav.cc`.

## 1. Install and log in

Needs Node.js and Docker (Wrangler builds the container image locally).

```bash
cd cloudflare-container
npm install
npx wrangler login
npx wrangler types   # generates the Env type from wrangler.jsonc
```

## 2. Set secrets (never commit these — they go in Cloudflare, not the repo)

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put AWS_ENDPOINT_URL        # https://2ec3895df483d0b8f21977a47c3a741e.r2.cloudflarestorage.com (no bucket path)
npx wrangler secret put JWT_SECRET              # any long random string
```

## 3. Deploy

```bash
npx wrangler deploy
```

First request after a deploy (or after 15 minutes idle — see `sleepAfter` in
`src/index.ts`) will be slower while the container cold-starts.

## Notes

- The `r2_buckets` binding in `wrangler.jsonc` is declared for future use from Worker
  code. The Go backend inside the container does **not** use it — it talks to R2
  through the S3-compatible API using the `AWS_*` secrets above.
- Container disk is ephemeral: nothing written to disk inside the container survives
  a restart. Drawings and folders live in R2. Live-collaboration room state is kept
  in memory only, so it's lost when the container sleeps; the host's drawing itself
  is autosaved to R2.
- If R2 rejects requests once deployed, path-style vs virtual-hosted-style S3
  addressing is the most likely culprit; the backend switches to path-style with
  `S3_FORCE_PATH_STYLE=true`.
