# VexoStream site and Cloudflare Worker

This directory contains the VexoStream site Worker source and the app-facing API. A tested compiled bundle is included at `dist/worker.js`, so `npx wrangler deploy` can be run directly from this `site/` folder.

## Manual deploy from Windows CMD

From the extracted repository, use the `site` folder, not the old v22.2 project folder:

```bat
cd /d C:\Users\CynetAdmin\Downloads\repo\site
npx wrangler login
npx wrangler deploy
```

Replace `repo` in the path with the folder name you used when extracting the ZIP. If you are already in the `site` directory, just run `npx wrangler login` once and then `npx wrangler deploy`.

If you edit Worker source files, rebuild before deploying:

```bat
npm install
npm run build
npx wrangler deploy
```

`npx wrangler deploy` does not run the build script on its own. If `dist/worker.js` is missing, `npm run build` regenerates it. The Worker deployment is manual; GitHub Actions only tests and builds the Flutter Windows app.

## App API database migration

Before first use of the Flutter app, apply the idempotent API session migration to the remote `DB` database from this same folder:

```bat
npx wrangler d1 execute DB --file=./migrations/2026-11-11-api-sessions.sql --remote
```

The Worker also creates this table lazily, but applying the migration explicitly is cleaner.

## Required setup

Confirm that `wrangler.toml` points at the Cloudflare zone and D1 database IDs you intend to use. In Cloudflare, configure `STREAM_SIGN_SECRET` and `EDGE_TOKEN` as Worker secrets, and set `RAILWAY_URL` or `BACKEND_URL` to your public VexoStream Core backend. Never put `EDGE_TOKEN` in the Flutter app or commit secrets.

The Worker serves `vexostream.bond/*` and `www.vexostream.bond/*`, plus `api.vexostream.bond` as a custom domain. `npx wrangler deploy` creates the `api` DNS record and certificate for you; if Cloudflare already has an `api` DNS record, delete it before deploying.
