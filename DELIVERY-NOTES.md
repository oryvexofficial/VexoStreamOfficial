# VexoStream 1.0.6 delivery notes

## Changes

- Embedded-player recovery preserves the stall watchdog across same-source native retries, recognizes HLS from case-insensitive URL, MIME/type and query hints, retains distinct same-quality stream URLs, and tries alternates before lower qualities or refresh. Manual quality selection stays pinned to that quality.
- Playback startup is now bounded: stalled source loads and failed play starts advance through alternatives, stale errors from the previous quality are ignored, and the HLS fallback loader times out cleanly. Core no longer caches expiring stream URLs and marks extraction responses `no-store`.
- The Core API sources are included under `core/` and deploy separately from the Worker. The duplicate legacy `site/site/` source tree was removed to prevent deploying the stale player by mistake.
- Flutter version: `1.0.6+9`; Windows installer fallback: `1.0.6.9`.
- Site and app maintenance are independent. Owner has both controls; team members need the corresponding `site` or `app` permission. Existing global maintenance falls back to both services until the separate settings are set. The old API `maintenanceOn` global write is owner-only.
- Member access settings, ban/unban and permanent account deletion now have separate permissions: `member_settings`, `member_moderation`, and `member_remove`. Existing admins need to be explicitly granted the new permissions by the Owner. Team admins cannot delegate powers they do not hold, or manage accounts with greater powers.
- A ban disables the member account and invalidates existing sessions; unban requires a new login. New app embed grants are bound to the member's current account stamp. Older unbound grants expire within five minutes.
- Browser and app thumbnail cards show Loading while the image is pending. Failed candidates move to another thumbnail or a fallback. App poster upgrades preload before replacing a visible image.
- Maintenance state is checked regularly by the app. The active WebView is removed when the app receives a maintenance response. Existing signed media requests and buffered content are not forcibly revoked server-side. App/site classification for shared embed routes uses the route and referrer; it is not a security boundary and can be imitated by a browser. Use member access rules for access control.
- A unique owner index prevents concurrent bootstrap from creating multiple Owner records. Admin session checks read fresh database state and fail closed on D1 errors.

## Important deployment preflight

Back up D1 and check for multiple owners *before deployment*. In the active `site/` directory:

```bat
npx wrangler d1 execute DB --remote --command="SELECT username,is_owner,disabled FROM admin_users WHERE is_owner=1"
npx wrangler d1 execute DB --remote --file=./migrations/2026-11-13-single-owner.sql
```

If the first query returns multiple owners, stop and resolve that conflict deliberately before migration. The unique index also gets created by the Worker during admin schema setup; conflicting owner records can prevent admin sign-in until resolved. Confirm `site/wrangler.toml` references your own Cloudflare account, zone and database. Deploy only from the top-level `site/` directory.

Deploy the Worker from `site/` after installing dependencies and running tests (`npm install`, `npm test`, `npx wrangler deploy`). The compiled `site/dist/worker.js` is included, but the Git repository ignores `dist/`; rebuild before deploying from a checkout. Configure `STREAM_SIGN_SECRET`, `EDGE_TOKEN`, `APP_KEY`, and the separate VexoStream Core backend as described in the main README. Rebuild the Windows and Android apps and configure the matching APP_KEY to use the new controls.

## Verification and limits

The Worker build and TypeScript check passed; all 86 Worker Node tests and both Core freshness tests passed, and the Core files compile. Flutter/Dart, Android SDK, WebView2, and NSIS were unavailable here, and the sandbox has no internet access: Flutter tests, native builds, live Cloudflare/D1 deployment, provider playback, and real-device interaction were not verified. A successful mocked test is not a guarantee that the project has no defects. Do not use this release in production without CI and real-device testing.
