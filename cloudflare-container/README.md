# Deploying excalidraw-full to Cloudflare Containers

Runs the existing `ghcr.io/betterandbetterii/excalidraw-full` image on Cloudflare's
container platform, behind `excali.vladislav.cc`, using R2 for canvas storage and
Cloudflare Access (SaaS OIDC app) as the only login screen — no Dex.

## 0. Prerequisites (in the Cloudflare dashboard)

1. **R2 bucket + API token**: bucket `excali-bucket` already exists, account ID
   `2ec3895df483d0b8f21977a47c3a741e`. R2 → Manage API tokens → create a token
   scoped to that bucket (Object Read & Write). Save the Access Key ID and
   Secret Access Key it gives you.
2. **Access SaaS OIDC app** (this replaces Dex): Zero Trust → Access → Applications →
   Add an application → **SaaS** → Application: **OIDC**. Set the redirect URL to
   `https://excali.vladislav.cc/auth/callback`. Save it — Cloudflare shows you a
   Client ID, a Client Secret (shown once), and the issuer URL, which looks like:
   `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`
   Attach an Access policy (e.g. "allow my email") so only you can log in.
3. **Custom domain**: this is handled by `wrangler.jsonc`'s `routes` block once you
   deploy — no need to add a DNS record by hand, Wrangler creates it for you as long
   as `vladislav.cc` is already on Cloudflare.

## 1. Install and log in

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
npx wrangler secret put OIDC_ISSUER_URL         # the cloudflareaccess.com sso/oidc URL from step 0.2
npx wrangler secret put OIDC_CLIENT_ID
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put OIDC_REDIRECT_URL       # https://excali.vladislav.cc/auth/callback
```

## 3. Deploy

```bash
npx wrangler deploy
```

First request after a deploy (or after 10 minutes idle — see `sleepAfter` in
`src/index.ts`) will be slower while the container cold-starts.

## Notes

- The `r2_buckets` binding in `wrangler.jsonc` is declared for future use from Worker
  code (e.g. if you later want the Worker itself to proxy uploads). The Go backend
  inside the container does **not** use it — it talks to R2 through the S3-compatible
  API using the `AWS_*` secrets above, exactly like it would talk to real AWS S3.
- Container disk is ephemeral: nothing written to disk inside the container survives
  a restart. That's fine here since storage is R2, not local SQLite/filesystem.
- If R2 rejects requests once deployed, path-style vs virtual-hosted-style S3 addressing
  is the most likely culprit — check Cloudflare's current R2 S3-compatibility notes.
