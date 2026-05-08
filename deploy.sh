#!/bin/bash
# ============================================================
#  Build & Deploy Script for Stremio Custom UI (GitHub Pages)
# ============================================================
#
#  Usage:   ./deploy.sh [commit message]
#  Example: ./deploy.sh "Fix subtitle sync"
#
#  IMPORTANT NOTES:
#  1. PUBLIC_PATH must be /stremio-web-netflix/ (the repo name)
#     because GitHub Pages serves from:
#     https://jeromenicholas07.github.io/stremio-web-netflix/
#
#  2. MSYS_NO_PATHCONV=1 is required on Git Bash (Windows)
#     otherwise /stremio-web-netflix/ gets mangled to
#     C:/Program Files/Git/stremio-web-netflix/
#
#  3. The gh-pages branch needs a .nojekyll file so GitHub
#     Pages serves all files (not just Jekyll-processed ones)
#
#  4. The build output hash changes with every commit because
#     webpack uses COMMIT_HASH in the output path. Old hash
#     dirs must be cleaned from gh-pages before copying new.
#
#  5. To recompile StremioLauncher.exe (C# 5, .NET 4.x):
#     MSYS_NO_PATHCONV=1 "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe" \
#       /target:exe /out:StremioLauncher.exe /platform:anycpu /optimize StremioLauncher.cs
#     Then upload: gh release upload v1.0.0 StremioLauncher.exe --clobber \
#       --repo jeromenicholas07/stremio-web-netflix
# ============================================================

set -e

REPO="jeromenicholas07/stremio-web-netflix"
REMOTE="fork"
SOURCE_BRANCH="netflix-redesign"
PUBLIC_PATH="/stremio-web-netflix/"
MSG="${1:-Deploy update}"

echo "=== Step 1: Ensure we're on $SOURCE_BRANCH ==="
git checkout "$SOURCE_BRANCH"

echo "=== Step 2: Install dependencies ==="
pnpm install

echo "=== Step 3: Build with correct PUBLIC_PATH ==="
# MSYS_NO_PATHCONV prevents Git Bash from mangling the path
MSYS_NO_PATHCONV=1 PUBLIC_PATH="$PUBLIC_PATH" pnpm build

echo "=== Step 4: Verify build output ==="
HASH=$(ls build/ | grep -E '^[0-9a-f]{10,}$' | head -1)
if [ -z "$HASH" ]; then
    echo "ERROR: No build hash directory found in build/"
    exit 1
fi
echo "Build hash: $HASH"

# Verify publicPath is correct in index.html
if ! grep -q "$PUBLIC_PATH$HASH" build/index.html; then
    echo "ERROR: index.html does not contain correct publicPath ($PUBLIC_PATH$HASH)"
    echo "Found:"
    grep -o 'href="[^"]*css"' build/index.html
    exit 1
fi
echo "publicPath verified OK"

echo "=== Step 5: Save build to /tmp (git checkout wipes build/) ==="
rm -rf /tmp/stremio-deploy
cp -r build /tmp/stremio-deploy

echo "=== Step 5b: Compile launchers + extract version strings ==="
# Build StremioLauncher.exe + StremioLauncherFULL.exe and read the version
# constants out of the .cs sources so we can write matching .version files
# on gh-pages. The launchers self-update by polling these .version URLs.
CSC="/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
DLL_DIR='C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
# Compile into a local build/ first then move — csc spawns a Win32 resource
# writer that fails if it can't write a sibling .TMP file in the output dir,
# and the system /tmp on Windows MSYS sometimes resolves to a path that
# trips it up. Local build/ is always reliable.
mkdir -p build /tmp/stremio-deploy
if [ -x "$CSC" ]; then
    # Embed the Stremio launcher icon (generated from
    # assets/images/stremio_custom_logo.svg via scripts/generate-icons.js)
    # so Explorer / taskbar / Alt-Tab show the branded icon.
    ICON_FLAG=""
    if [ -f StremioLauncher.ico ]; then
        ICON_FLAG="/win32icon:StremioLauncher.ico"
    fi
    MSYS_NO_PATHCONV=1 "$CSC" /target:exe /optimize /nologo $ICON_FLAG \
        /out:build/StremioLauncher.exe StremioLauncher.cs \
        || { echo "ERROR: StremioLauncher.cs failed to compile"; exit 1; }
    MSYS_NO_PATHCONV=1 "$CSC" /target:exe /optimize /nologo $ICON_FLAG \
        "/r:$DLL_DIR\\System.IO.Compression.dll" \
        "/r:$DLL_DIR\\System.IO.Compression.FileSystem.dll" \
        /out:build/StremioLauncherFULL.exe StremioLauncherFULL.cs \
        || { echo "ERROR: StremioLauncherFULL.cs failed to compile"; exit 1; }
    cp build/StremioLauncher.exe     /tmp/stremio-deploy/StremioLauncher.exe
    cp build/StremioLauncherFULL.exe /tmp/stremio-deploy/StremioLauncherFULL.exe
    # Extract version constants — the launcher uses these strings to decide
    # whether to self-update. Must match exactly. Using sed (portable) instead
    # of grep -P which requires a UTF-8 locale that MSYS doesn't always have.
    # Pick the FIRST match for LAUNCHER_VERSION and the BASE_ one separately.
    LAUNCHER_VER=$(sed -n 's/.*const string LAUNCHER_VERSION = "\([^"]*\)".*/\1/p' StremioLauncherFULL.cs | head -1)
    BASE_VER=$(sed -n 's/.*const string BASE_LAUNCHER_VERSION = "\([^"]*\)".*/\1/p' StremioLauncherFULL.cs | head -1)
    if [ -z "$LAUNCHER_VER" ] || [ -z "$BASE_VER" ]; then
        echo "ERROR: failed to extract version constants from StremioLauncherFULL.cs"
        exit 1
    fi
    echo "LAUNCHER_VERSION=$LAUNCHER_VER"
    echo "BASE_LAUNCHER_VERSION=$BASE_VER"
    printf '%s' "$LAUNCHER_VER" > /tmp/stremio-deploy/StremioLauncherFULL.version
    printf '%s' "$BASE_VER"     > /tmp/stremio-deploy/StremioLauncher.version
    echo "OK: launchers compiled + .version files written"
else
    echo "WARN: csc.exe not found at $CSC — keeping existing launcher binaries on gh-pages"
fi

# Seed an empty pornstars.json on gh-pages if one doesn't exist already.
# The Incognito search dictionary fetches this once a day and merges any
# names into its bundled list — so growing the list later is just an
# edit-and-push on this file, no rebuild needed.
if [ ! -f /tmp/stremio-deploy/pornstars.json ]; then
    echo '[]' > /tmp/stremio-deploy/pornstars.json
fi

echo "=== Step 5c: Rebuild addon zip ==="
# stremio-adult-addon.zip is what the launcher fetches when ADDON_VERSION
# moves. If we don't repackage it on every deploy, addon source changes never
# reach users — they get a stale zip on update.
ADDON_DIR="stremio-adult-addon"
ADDON_VER=$(sed -n 's/.*const string ADDON_VERSION = "\([^"]*\)".*/\1/p' StremioLauncherFULL.cs | head -1)
if [ -z "$ADDON_VER" ]; then
    echo "ERROR: failed to extract ADDON_VERSION from StremioLauncherFULL.cs"
    exit 1
fi
echo "ADDON_VERSION=$ADDON_VER"
# Production deps in the addon are bundled into the zip (no `npm install` on
# the user's machine). Install them if they're missing.
if [ ! -d "$ADDON_DIR/node_modules" ]; then
    echo "Installing addon production dependencies..."
    (cd "$ADDON_DIR" && npm install --omit=dev --silent) || { echo "ERROR: npm install failed for addon"; exit 1; }
fi
# Stage and zip via PowerShell's Compress-Archive (no `zip` binary on MSYS).
STAGING_WIN="$(pwd -W 2>/dev/null || pwd)/build/_addon_staging"
ADDON_ZIP_WIN="$(pwd -W 2>/dev/null || pwd)/build/stremio-adult-addon.zip"
rm -rf build/_addon_staging build/stremio-adult-addon.zip
mkdir -p build/_addon_staging/stremio-adult-addon
cp     "$ADDON_DIR/index.js"     build/_addon_staging/stremio-adult-addon/
cp     "$ADDON_DIR/package.json" build/_addon_staging/stremio-adult-addon/
cp -r  "$ADDON_DIR/src"          build/_addon_staging/stremio-adult-addon/
cp -r  "$ADDON_DIR/node_modules" build/_addon_staging/stremio-adult-addon/
# Drop the version marker into the staging dir so the launcher's
# .addon-version check has something to compare against immediately on
# extraction (otherwise EnsureAddonUpToDate sees a missing marker on
# first run and treats it as needing a refresh).
printf '%s' "$ADDON_VER" > build/_addon_staging/stremio-adult-addon/.addon-version
MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -Command \
    "Compress-Archive -Path '$STAGING_WIN\\*' -DestinationPath '$ADDON_ZIP_WIN' -CompressionLevel Optimal -Force" \
    || { echo "ERROR: failed to compress addon zip"; exit 1; }
rm -rf build/_addon_staging
cp build/stremio-adult-addon.zip /tmp/stremio-deploy/stremio-adult-addon.zip
ZIP_SIZE=$(du -k build/stremio-adult-addon.zip | cut -f1)
echo "OK: addon zipped (${ZIP_SIZE} KB)"
echo "Saved build to /tmp/stremio-deploy"

echo "=== Step 6: Switch to gh-pages and deploy ==="
git checkout gh-pages

# Keep the most recent previous hash dir so users on cached pages from the
# previous deploy can still load their worker scripts (old service workers
# reference the hash baked into the page bundle). Anything older goes.
PREV_HASH=$(ls -dt */ 2>/dev/null | grep -E '^[0-9a-f]{10,}/$' | head -1 | sed 's:/$::')
for dir in $(ls -d */ 2>/dev/null | grep -E '^[0-9a-f]{10,}/$'); do
    name="${dir%/}"
    if [ "$name" = "$PREV_HASH" ] || [ "$name" = "$HASH" ]; then
        echo "Keeping hash dir: $dir"
    else
        echo "Removing old hash dir: $dir"
        rm -rf "$dir"
    fi
done
# Also clean stale root files from previous deploys
rm -f index.html service-worker.js service-worker.js.map manifest.json
rm -f workbox-*.js workbox-*.js.map e34a*.mjs
rm -rf build .well-known
# Source-branch artifacts that git checkout leaves behind in the working
# tree (they're untracked on gh-pages, so `git add -A` would commit them).
rm -rf node_modules src tests assets screenshots/board_*.webp
rm -rf stremio-adult-addon stremio-adult-addon-source
rm -f package.json pnpm-lock.yaml tsconfig.json eslint.config.mjs webpack.config.js manifest.json
rm -f start-dev.js cors-proxy.js audio-extract-server.js trakt-bridge.js test-autosync.js http_server.js
rm -f Dockerfile build-launchers.ps1 launch-stremio.bat launch-stremio.command
rm -f StremioLauncher.cs StremioLauncherFULL.cs README.md BUILD.md CODE_OF_CONDUCT.md LICENSE.md

# Copy from saved build (NOT from build/ which git checkout may have clobbered)
cp -r /tmp/stremio-deploy/* .

# Ensure .nojekyll exists
touch .nojekyll

echo "=== Step 7: Commit and push gh-pages ==="
# Add only the files we actually want on gh-pages: build artifacts, launcher
# binaries/zip, hash dirs, and the standard root files. Refuse to add the
# source-branch tree if any of it is still hanging around.
git add -A
# Safety net: refuse to commit if any source-branch artifacts got staged.
# Match `node_modules/` ANYWHERE in the path (not just root) so nested ones
# like stremio-adult-addon/node_modules/... can't sneak through.
if git diff --cached --name-only | grep -qE '(^|/)(node_modules|src|tests)/|^stremio-adult-addon/'; then
    echo "ERROR: source-branch files staged for gh-pages commit. Aborting."
    git diff --cached --name-only | grep -E '(^|/)(node_modules|src|tests)/|^stremio-adult-addon/' | head -20
    exit 1
fi
git commit -m "$MSG

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push "$REMOTE" gh-pages

echo "=== Step 8: Switch back to $SOURCE_BRANCH ==="
git checkout "$SOURCE_BRANCH"

echo ""
echo "=== DEPLOYED ==="
echo "URL: https://jeromenicholas07.github.io/stremio-web-netflix/"
echo "Build hash: $HASH"
echo ""
echo "Allow 1-2 minutes for GitHub Pages to update."
