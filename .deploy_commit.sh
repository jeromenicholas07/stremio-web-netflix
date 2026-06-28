#!/bin/bash
set -e
cd /c/workspace/stremio-web-gh-pages

git fetch fork gh-pages
git reset --hard fork/gh-pages

NEW_HASH="b16788be66d2b255662c155304f381e58eb1ed15"
# Keep the most recent existing hash dir (for clients still on the prior
# deploy) plus the new one; drop anything older.
PREV_HASH=$(ls -dt */ 2>/dev/null | grep -E '^[0-9a-f]{10,}/$' | head -1 | sed 's:/$::')
for dir in $(ls -d */ 2>/dev/null | grep -E '^[0-9a-f]{10,}/$'); do
    name="${dir%/}"
    if [ "$name" = "$PREV_HASH" ] || [ "$name" = "$NEW_HASH" ]; then
        echo "Keeping hash dir: $name"
    else
        echo "Removing old hash dir: $name"
        rm -rf "$name"
    fi
done

rm -f index.html service-worker.js service-worker.js.map manifest.json
rm -f workbox-*.js workbox-*.js.map e34a*.mjs

cp -r /tmp/stremio-deploy/* .
touch .nojekyll

git add -A
if git diff --cached --name-only | grep -qE '(^|/)(node_modules|src|tests)/|^stremio-adult-addon/'; then
    echo "ERROR: source-branch files staged for gh-pages commit. Aborting."
    exit 1
fi
git commit -m "Deploy: network-first index.html so shell exe picks up fixes" 2>&1 | tail -3
git push fork gh-pages 2>&1 | tail -3
echo "=== DONE ==="
