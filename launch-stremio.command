#!/bin/bash
# Stremio Custom UI Launcher for macOS
# Double-click to run, or: chmod +x launch-stremio.command && ./launch-stremio.command
# Disables CORS so the web UI on GitHub Pages can talk to the local streaming server

export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-web-security"

STREMIO_APP="/Applications/Stremio.app"

if [ -d "$STREMIO_APP" ]; then
    open "$STREMIO_APP" --args --webui-url=https://jeromenicholas07.github.io/stremio-web-netflix/
else
    echo "Stremio not found at $STREMIO_APP"
    echo "Please install from https://www.stremio.com/downloads"
    read -p "Press Enter to exit..."
fi
