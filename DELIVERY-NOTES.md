# VexoStream 1.0.6 delivery notes

## Changes

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

If the first query returns multiple owners, stop and resolve that conflict deliberately before migration. The unique index also gets created by the Worker during admin schema setup; conflicting owner records can prevent admin sign-in until resolved. Confirm `site/wrangler.toml` references your own Cloudflare account, zone and database. The separate legacy `site/site/` tree is not the active Worker build.

Deploy the Worker from `site/` after installing dependencies and running tests (`npm install`, `npm test`, `npx wrangler deploy`). The compiled `site/dist/worker.js` is included, but the Git repository ignores `dist/`; rebuild before deploying from a checkout. Configure `STREAM_SIGN_SECRET`, `EDGE_TOKEN`, `APP_KEY`, and the separate VexoStream Core backend as described in the main README. Rebuild the Windows and Android apps and configure the matching APP_KEY to use the new controls.

## Verification and limits

The Worker build, TypeScript check and automated Node tests were run locally with installed Node tooling and mocked integrations; see the final delivery message for the test count. Flutter/Dart, Android SDK, WebView2, and NSIS were unavailable here, and the sandbox has no internet access: the Flutter tests, native builds, live Cloudflare/D1 deployment, provider playback, and real-device interaction were not verified. A successful mocked test is not a guarantee that the project has no defects. Do not use this release in production without CI and real-device testing.
