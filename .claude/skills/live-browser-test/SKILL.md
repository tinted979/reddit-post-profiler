---
name: live-browser-test
description: How to run the page in a headless browser for live or mocked UI checks (Playwright), including behind a sandbox's TLS-intercepting proxy. Use before checking a UI change, accessibility or a live scan in a browser.
---
Serve the page first: `python3 -m http.server -d web` (ES modules need http), then open
http://localhost:8000 (the archive's CORS policy, tools/r2-cors.json, allows only that origin
and the Pages site).

Headless Chromium doesn't trust the container's proxy CA. For live browser tests, relay the requests to both hosts the page reads, Arctic Shift and the archive (rpp-db.tinted979.dev), through Node `fetch` with `page.route` (run Node with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`) rather than disabling TLS. For UI checks that don't need live data, mock both with `page.route`: an archive read that fails switches `DumpSource` off and sends the scan's lookups to the API.

Live requests go to the shared, rate-limited Arctic Shift API (about 0.8 requests/s for
everyone): keep live checks to one small thread, and prefer mocks. Check both colour schemes
(`page.emulateMedia({ colorScheme })`) and keyboard focus when elements hide, as the
accessibility rule in CLAUDE.md asks.
