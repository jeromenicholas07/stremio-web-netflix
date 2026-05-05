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
# Safety net: refuse to commit if node_modules or src somehow got staged.
if git diff --cached --name-only | grep -qE '^(node_modules/|src/|tests/)'; then
    echo "ERROR: source-branch files staged for gh-pages commit. Aborting."
    git diff --cached --name-only | grep -E '^(node_modules/|src/|tests/)' | head -20
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
