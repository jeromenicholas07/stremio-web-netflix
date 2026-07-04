# iOS CORS proxy (Cloudflare Worker)

A tiny, free Cloudflare Worker that unblocks two iOS-only features of the web app.
Video **never** flows through it — only headers/JSON — so the Workers free plan
(100k requests/day) is far more than enough.

## Routes

| Route | Purpose |
|-------|---------|
| `ANY /trakt/*` | Proxies to `https://api.trakt.tv/*` with CORS headers so **Trakt sync** works in iOS Safari. Forwards only `Authorization`, `Content-Type`, `trakt-api-key`, `trakt-api-version`. |
| `GET /size?u=<url>&h=<Header:Value>` | Follows the resolve→debrid redirect chain the browser can't see and returns `{ size, contentType }`, so **auto-pick preflight** can tell a real file from the ~2 MB Real-Debrid copyright stub. |
| `GET /health` | `{ ok: true }` |

`/size` only fetches hosts on an allowlist (Real-Debrid / Debrid-Link / AllDebrid /
Premiumize / `strem.fun` by default) so this can't be used as an open proxy. Extend
it with the `SIZE_ALLOW_HOSTS` env var (comma-separated) in `wrangler.toml`.

## Deploy (free)

```sh
cd worker
npx wrangler login          # one-time, opens browser
npx wrangler deploy         # prints the https://<name>.<subdomain>.workers.dev URL
```

## Wire it into the web build

Set the deployed URL as a build-time env var when building the site, so the app uses
it **only on iOS / remote origins** (desktop + the Stremio shell are unaffected):

```sh
# PowerShell
$env:CORS_PROXY_URL = "https://stremio-ios-cors-proxy.<you>.workers.dev"; pnpm run build
```

The app reads `process.env.CORS_PROXY_URL` (injected via webpack `EnvironmentPlugin`).
If it's unset, the iOS Trakt/preflight paths simply fall back to their previous
behavior (Trakt direct; preflight fails open).
