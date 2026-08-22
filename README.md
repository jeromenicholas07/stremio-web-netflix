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

![Subtitles Auto-Sync](screenshots/subtitles.png)

## Setup Guide

Everything below takes about ten minutes, most of which is waiting for a
download. You don't need to be technical, and you don't need to install
anything beyond Stremio itself.

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

Stremio on its own is a media centre with no content. **Add-ons** are what give
it something to play, and you choose which ones to trust.

1. Click **Add-ons** in the left sidebar.
2. Browse the catalogue and install the ones you want.
3. If an add-on offers settings — an account or API key for a service you pay
   for, for example — click **Configure** and fill them in.

Which add-ons to use is your decision, and it's worth knowing what each one
does before you install it. The custom UI works with whatever you pick.

### 4. Download the launcher

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
