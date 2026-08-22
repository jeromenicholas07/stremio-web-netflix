# Using this on an iPhone (iOS)

This fork runs on an iPhone as an installable web app (PWA). Most things work in
Safari with **no self-hosted server** — you just need a Real-Debrid account. A
free Cloudflare Worker makes Trakt sync and the auto-pick copyright preflight work
in Safari.

> **Add-ons must be set up on a computer first.** They can't be added from the
> iPhone — installation and configuration are unreliable in mobile Safari, and
> add-ons that hand off to their own site to collect an API key don't return
> cleanly. Because add-ons are stored on the Stremio account rather than the
> device, doing it once on a desktop is enough: sign in on the iPhone and they're
> already there. See the [step-by-step setup guide](../README.md#setup-guide).

## What works on iPhone (and what doesn't)

| Feature | On iPhone |
|---|---|
| Browsing, catalogs, search, library | ✅ Works |
| Auto-pick (prefers web-playable releases on iOS) | ✅ Works |
| Inline playback of H.264 / MP4 (typical Real-Debrid releases) | ✅ Plays in the app |
| Trakt sync | ✅ With the Worker (below) |
| Auto-pick copyright preflight | ✅ With the Worker (below) |
| MKV / HEVC / AC3 / 4K-HDR files | ⚠️ Can't play inline in Safari → one-tap hand-off to **Infuse/VLC** |
| P2P torrent streaming | ❌ Needs a streaming server iOS can't run — use Real-Debrid instead |

## One-time setup (you, the host)

1. **Deploy the site** (already hosted at the project's GitHub Pages URL).
2. **Deploy the free Cloudflare Worker** for Trakt + preflight — see
   [`worker/README.md`](../worker/README.md). Copy its `https://…workers.dev` URL.
3. **Build with the Worker URL** so iOS uses it (desktop is unaffected):
   ```powershell
   $env:CORS_PROXY_URL = "https://stremio-ios-cors-proxy.<you>.workers.dev"
   $env:PUBLIC_PATH = "/stremio-web-netflix/"
   pnpm run build
   ```
   If you skip the Worker, Trakt may be flaky on iOS and preflight simply won't
   pre-skip copyright stubs (it fails open — playback is never blocked).

## One-time setup (your friend)

**On a computer, first:** sign in to the Stremio desktop app with the account
they'll use on the phone, install the add-ons they need, and configure each one
(Real-Debrid API key and so on). Nothing below can substitute for this.

**Then on the iPhone:**

1. Open the site URL in **Safari** → tap **Share** → **Add to Home Screen**. Launch
   it from the new Home-Screen icon — it opens **full-screen** and respects the
   notch / home-indicator safe areas.
   - After deploying a new build, **delete the old icon and re-add** it so iOS
     picks up the updated page and service worker.
   - Note: a standalone WASM app this heavy can hit iOS's per-app memory limit on
     low-memory devices ("A problem repeatedly occurred"). If that happens, the fix
     is reducing startup memory — modern iOS launches it standalone regardless.
2. Sign in with the **same Stremio account** used on the computer — that's what
   carries the add-ons across. Add-ons configured there need no further setup here.
3. **Leave the streaming server unset** (Settings → Streaming) — it's not used on iOS.
4. Install **Infuse** (or VLC) from the App Store — used only for the occasional file
   Safari can't play inline.
5. (Optional) Sign in to **Trakt** to sync watched/watchlist.

## How playback behaves

- Most releases are H.264/MP4 and play **inline** in the app. Auto-pick prefers these.
- If a pick is MKV/HEVC/AC3/4K-HDR, the player shows a row of **one-tap buttons**
  (Infuse, VLC, Outplayer, VidHub) — tap one to play it in that app, then return.

## Privacy & legality (not legal advice)

- All traffic is HTTPS/encrypted. Real-Debrid streams over HTTPS from their
  servers, so your connection is not part of any peer-to-peer swarm.
- The Worker is **your** infrastructure but can see plaintext (e.g. your Trakt token)
  as it passes through — that's inherent to any proxy.
- The app, Trakt, and Real-Debrid are legal. Streaming specific content you don't
  have rights to may infringe copyright depending on the content and your country.
