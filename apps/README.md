# Flutter Windows client

This is the Flutter source for the VexoStream Windows app. The repository's GitHub Actions workflow generates the standard Windows runner when needed, resolves Flutter packages, runs tests, builds a release, and uploads `VexoStream-Windows.zip`.

Default API: `https://api.vexostream.bond/api/v1`. Override at build time with `--dart-define=VEXOSTREAM_API_BASE=https://your-api.example/api/v1`.

The app is 18+ and uses the site's Worker API for accounts, catalog, performer profiles, status, social information, authorized Check host checks, and stream extraction. Secure account tokens are stored with Windows secure storage. The native player uses the Worker-signed media proxy URLs.
