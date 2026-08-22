# Stremio Custom UI — Netflix Redesign + Whisper Auto-Sync

A custom Stremio Web UI with a Netflix-style redesign and AI-powered automatic subtitle synchronization.

**🌐 Live demo:** [jeromenicholas07.github.io/stremio-web-netflix](https://jeromenicholas07.github.io/stremio-web-netflix/#/)
*(Open in any browser to preview the UI. For full streaming + auto-sync, follow the Setup Guide below to run it inside the Stremio shell.)*

![Home](screenshots/home.png)

## Features

- **Netflix-style UI** — clean, modern interface with hero banners, continue watching, and watchlist rows
- **Whisper Auto-Sync** — automatically syncs external subtitles using OpenAI's Whisper model running locally in your browser (WASM/WebGPU)
- **Trakt Integration** — watchlist, ratings, scrobbling, and personalized recommendations
- **GPU Acceleration** — uses WebGPU when available for fast transcription, falls back to WASM
- **Zero Setup** — download one file, double-click, done
- **Works on iPhone** — add it to your Home Screen from Safari, no App Store needed

![Subtitles Auto-Sync](screenshots/subtitles.png)

## Setup Guide

Everything below takes about ten minutes, most of which is waiting for a
download. You don't need to be technical, and you don't need to install
anything beyond Stremio itself.

Start here even if you mainly want it on your iPhone. **Steps 1–3 have to be
done on a computer**, and the iPhone instructions further down pick up from
there.

### 1. Install Stremio

Go to [stremio.com/downloads](https://www.stremio.com/downloads) and download
Stremio for your computer. Open the file you downloaded and follow the
installer. This is the official app from Stremio — the custom UI runs inside it.

### 2. Create a Stremio account

Open Stremio. On the welcome screen choose **Sign up** and register with an
email address, or **Log in** if you already have an account.

You need an account: it's what stores your library and settings, and the custom
UI reads them from there.

### 3. Add a source add-on

> **⚠️ Do this on a computer — it cannot be done from an iPhone or iPad.**
> Add-on installation and configuration is unreliable in mobile Safari, and
> some add-ons send you to their own website to enter a key, which doesn't
> come back cleanly on iOS. Set them up once on a computer and they follow you
> everywhere (see below).

Stremio on its own is a media centre with no content. **Add-ons** are what give
it something to play, and you choose which ones to trust.

1. Click **Add-ons** in the left sidebar.
2. Browse the catalogue and install the ones you want.
3. If an add-on offers settings — an account or API key for a service you pay
   for, for example — click **Configure** and fill them in.

Which add-ons to use is your decision, and it's worth knowing what each one
does before you install it. The custom UI works with whatever you pick.

**Your add-ons live on your Stremio account, not on the computer.** That's why
this step only has to happen once: sign in on any other device — including your
iPhone — and the same add-ons are already there. Whenever you want to add or
reconfigure one later, go back to a computer to do it.

### 4. Download the launcher

> Only want this on your iPhone? You're done with the computer — skip to
> [Setting it up on an iPhone or iPad](#setting-it-up-on-an-iphone-or-ipad).
> Steps 4–8 are for watching on the computer itself.

Go to the [latest release](https://github.com/jeromenicholas07/stremio-web-netflix/releases/latest)
and download:

| Your computer | File to download | How to open it |
|---|---|---|
| Windows | `StremioLauncherFULL.exe` | Double-click |
| macOS | `launch-stremio.command` | Right-click → **Open** the first time, then double-click |

Put it somewhere you'll find again — your Desktop is fine. This one file is the
whole thing; there's nothing to install.

### 5. Get past the Windows warning (Windows only, first time)

The first time you open the launcher, Windows will show a blue box saying
**"Windows protected your PC"**.

This is expected. It appears for any program that hasn't been through Microsoft's
paid code-signing process, which this one hasn't. To continue:

1. Click **More info** — it's small text in the middle of the blue box, easy to miss.
2. A **Run anyway** button appears at the bottom. Click it.

You'll only have to do this once. If you'd rather not, that's a completely
reasonable place to stop.

### 6. Launch

Double-click the launcher. It opens Stremio with the custom UI.

The very first launch takes a moment while it sets itself up; after that it
opens straight away. Leave the launcher running while you watch — closing it
closes Stremio too.

### 7. Connect your Trakt account (optional)

[Trakt](https://trakt.tv) tracks what you've watched and syncs your watchlist
and ratings. The custom UI uses it for personalised rows on the home screen.
Skip this if you don't want it — everything else works without it.

You'll be signing in to **your own** Trakt account. Nothing is shared with
whoever gave you this app, and you can disconnect whenever you like.

1. Create a free account at [trakt.tv](https://trakt.tv) if you don't have one.
2. In the custom UI, open **Settings** (the person icon, top right) and click
   **Modern UI** in the list on the left.
3. Under **Trakt Integration**, click **Connect to Trakt**.
4. A short code appears, and a browser tab opens at trakt.tv/activate. Click the
   code to copy it, paste it into that page, and approve.
5. Back in Settings, click **Sync Now** to pull in your watchlist and ratings.

You can ignore the **Advanced** row underneath — those fields are already filled
in and you don't need to touch them.

![Settings](screenshots/settings.png)

### 8. Set your preferences (optional)

Still in **Settings → Modern UI**:

- **TMDB API Key** — already filled in and working. Leave it alone unless you
  have your own.
- **Trailer Language** — which language trailers should be in.
- **Auto-Pick Stream** — plays the best available stream automatically instead
  of showing you a list. Drag the **Sources** and **Quality** rows into the
  order you prefer, and switch off any you never want.

## Setting it up on an iPhone or iPad

There's no app to install from the App Store. The UI runs as a web app you add
to your Home Screen, and it looks and behaves like a normal app once it's there.

**Before you start**, you must have done **steps 1–3 above on a computer** —
created your Stremio account and installed your add-ons. Add-ons cannot be added
from an iPhone. They're stored on your account, so once they're set up on a
computer they appear on your phone automatically.

### 1. Add it to your Home Screen

1. Open **Safari** on your iPhone. It has to be Safari — Chrome and Firefox on
   iOS can't add web apps to the Home Screen.
2. Go to
   [jeromenicholas07.github.io/stremio-web-netflix](https://jeromenicholas07.github.io/stremio-web-netflix/#/)
3. Tap the **Share** button (the square with an arrow pointing up, at the bottom
   of the screen).
4. Scroll down the list and tap **Add to Home Screen**, then **Add** in the top
   right.
5. Close Safari and open the new icon from your Home Screen — it's called
   **Stremio**. It fills the whole screen, with no address bar.

Always open it from that Home Screen icon. Opening the address in Safari again
works, but you get the browser chrome and it feels like a website.

### 2. Sign in

Tap the person icon in the top right, then **Log in**, and use the same Stremio
account you created on the computer. Your add-ons, library and watch history are
already there.

### 3. Leave the streaming server alone

Go to **Settings → Streaming** and leave the server URL empty. iPhones can't run
the streaming server, and the app doesn't need it — playback comes straight from
your add-on over the internet.

This is also why **peer-to-peer streams don't work on iPhone**. You need an
add-on backed by a service that streams over HTTPS, such as Real-Debrid. Auto-pick
already knows this and prefers streams your iPhone can actually play.

### 4. Install a video player app (recommended)

Install **[Infuse](https://apps.apple.com/app/infuse-7/id1136220934)** or **VLC**
from the App Store. Most things play directly in the app, but Safari can't handle
certain formats (MKV, HEVC, AC3, 4K HDR). When that happens the player shows a
row of buttons — tap Infuse or VLC and it plays there, then come back.

### 5. Connect Trakt (optional)

Same as on a computer: **Settings → Modern UI → Connect to Trakt**. This links
your own Trakt account.

### Updating on iPhone

The app updates itself when you open it, so normally there's nothing to do. If
it seems stuck on an old version, remove the Home Screen icon (press and hold →
**Remove App** → **Delete from Home Screen**) and add it again with the steps
above. Nothing is lost — everything is on your Stremio account.

## If something goes wrong

**Stremio opens but the window is blank.**
Close everything, wait a few seconds, and run the launcher again. If it's still
blank, your internet connection may have dropped mid-load — the UI is fetched
from the web on each start.

**"Port already in use", or the launcher closes immediately.**
An old copy is probably still running. Open Task Manager (Ctrl+Shift+Esc), end
any `Stremio` or `StremioLauncher` tasks, then try again.

**Nothing plays.**
That's the add-on side, not the UI. Check in Stremio's own **Add-ons** section
that what you installed is still working and still configured.

**I want to start over.**
Delete the folder `%LOCALAPPDATA%\StremioLauncherFULL` — paste that into the
Windows Explorer address bar to find it. The next launch rebuilds it from
scratch. To reset just your custom-UI preferences, use **Settings → Modern UI**
and clear the fields you changed.

**I want to remove it completely.**
Delete the folder above, delete the launcher file, and uninstall Stremio the
normal way through Windows Settings → Apps.

### On iPhone

**I can't find "Add to Home Screen".**
You're not in Safari. Chrome and Firefox on iOS don't offer it — open the address
in Safari instead. If you are in Safari, scroll further down the share sheet; it
sits below the row of app icons.

**There's nothing to watch — no sources appear.**
Your add-ons aren't set up yet, or you're signed into a different account. Add-ons
can only be added on a computer (step 3 above). Do that, then check under the
person icon that your iPhone is signed into the same Stremio account.

**A stream won't play, or plays sound with no picture.**
Safari can't decode that file. Tap the **Infuse** or **VLC** button in the player.
If you don't see those buttons, install one of those apps first.

**Everything fails to play.**
Peer-to-peer streams can't work on an iPhone. You need an add-on backed by a
service that streams over HTTPS, such as Real-Debrid, configured on a computer.

**It says "A problem repeatedly occurred".**
The page ran out of memory, which happens on older iPhones. Close the app fully
(swipe up from the bottom and swipe it away) and reopen it.

## How Auto-Sync Works

When you select external subtitles, Whisper automatically:

1. Extracts a sample of audio from the video
2. Transcribes it locally using AI (nothing sent to the cloud)
3. Aligns the transcription against subtitle text
4. Applies the correct delay offset

The Whisper model (~75MB) downloads once on first use and caches locally. Subsequent uses are instant.

## For Developers

### Prerequisites

- Node.js 18+
- [pnpm](https://pnpm.io/installation) 10+

### Development

```bash
pnpm install
pnpm start
```

### Production Build

```bash
PUBLIC_PATH="/stremio-web-netflix/" pnpm run build
```

## License

Based on [Stremio Web](https://github.com/Stremio/stremio-web), copyright 2017-2023 Smart code, available under GPLv2. See [LICENSE](/LICENSE.md).
