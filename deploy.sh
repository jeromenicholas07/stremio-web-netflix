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

# Remove old build hash directories (keep non-hash dirs like images/, fonts/)
for dir in $(ls -d */ 2>/dev/null | grep -E '^[0-9a-f]{10,}/$'); do
    echo "Removing old hash dir: $dir"
    rm -rf "$dir"
done
# Also clean stale root files from previous deploys
rm -f index.html service-worker.js service-worker.js.map manifest.json
rm -f workbox-*.js workbox-*.js.map e34a*.mjs
rm -rf build .well-known

# Copy from saved build (NOT from build/ which git checkout may have clobbered)
cp -r /tmp/stremio-deploy/* .

# Ensure .nojekyll exists
touch .nojekyll

echo "=== Step 7: Commit and push gh-pages ==="
git add -A
git commit -m "$MSG

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push "$REMOTE" gh-pages

echo "=== Step 8: Switch back to $SOURCE_BRANCH ==="
git checkout "$SOURCE_BRANCH"

echo ""
echo "=== DEPLOYED ==="
echo "URL: https://jeromenicholas07.github.io/stremio-web-netflix/"
echo "Build hash: $HASH"
echo ""
echo "Allow 1-2 minutes for GitHub Pages to update."
