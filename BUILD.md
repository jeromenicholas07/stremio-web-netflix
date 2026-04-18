# Build & Deploy Notes

Everything needed to ship a new launcher + web bundle to `gh-pages`.

## TL;DR

```powershell
powershell -ExecutionPolicy Bypass -File build-launchers.ps1
```

Then copy `build/` onto the `gh-pages` branch and push. Do **not** run
`pnpm build` by itself before invoking the script — the script runs it with
the env var below and will refuse to continue if the output looks wrong.

---

## §1. The `publicPath` gotcha (the one that keeps biting us)

**Symptom**: user runs `StremioLauncherFULL.exe`, everything logs "[OK]",
Stremio shell launches, Stremio window opens blank, shell exits with code 0
a second later, launcher terminal closes.

**Root cause**: `webpack.config.js` reads `publicPath` from the
`PUBLIC_PATH` env var, falling back to `/`. If unset at build time, the
generated `build/index.html` references

    /<commit-hash>/scripts/main.js

which resolves to `https://jeromenicholas07.github.io/<commit-hash>/...`
on GitHub Pages — **404**, because the site is served under
`/stremio-web-netflix/`, not the domain root. The webview loads a blank
page, Stremio shell exits, and the user sees nothing.

**Fix**: always build with

    PUBLIC_PATH=/stremio-web-netflix/

`build-launchers.ps1` sets this, invokes `pnpm run build`, and then
grep-asserts that `build/index.html` contains
`/stremio-web-netflix/<hash>/scripts/main.js`. The script **throws** if
that assertion fails, so the broken bundle can never be packaged.

### Do NOT set `PUBLIC_PATH` from git-bash

MSYS translates leading slashes into Windows paths:

    PUBLIC_PATH=/stremio-web-netflix/ pnpm build
    # webpack receives PUBLIC_PATH=C:/Program Files/Git/stremio-web-netflix/

Always use PowerShell (`$env:PUBLIC_PATH = '/stremio-web-netflix/'`) or
the one-shot `build-launchers.ps1`.

---

## §2. Incremental web-only rebuilds

If you already ran `pnpm build` manually (with the env var set) and just
want the script to repackage launchers + zip:

```powershell
powershell -ExecutionPolicy Bypass -File build-launchers.ps1 --skip-web
```

---

## §3. `PAYLOAD_VERSION` bump rules

`StremioLauncherFULL.cs` defines `PAYLOAD_VERSION`. Bump it whenever:

- The addon source changes (new route, new dep, bug fix)
- The Prowlarr or Node URLs change
- `StremioLauncher.exe` (base) changes

Existing installs only re-download if the version string changes — the
install path is `%LOCALAPPDATA%\StremioLauncherFULL\<version>\`.

---

## §4. Deploy checklist

1. `powershell -ExecutionPolicy Bypass -File build-launchers.ps1`
2. `git worktree add /tmp/gh-pages gh-pages`
3. In the worktree: wipe old `<hash>/`, `*.mjs`, `favicons`, `fonts`,
   `images`, `screenshots`, `index.html`, `manifest.json`,
   `service-worker.js*`, `workbox-*`.
4. `cp -r <repo>/build/. /tmp/gh-pages/`
5. `cd /tmp/gh-pages && git add -A && git commit -m "Deploy: ..."`
6. `git push fork gh-pages` (remote named `fork` is the personal one)
7. Verify after ~30–60s:
   ```bash
   curl -s https://jeromenicholas07.github.io/stremio-web-netflix/ \
     | grep -oE 'src="[^"]*main.js"'
   ```
   must print something matching
   `src="/stremio-web-netflix/<hash>/scripts/main.js"`.

---

## §5. Keeping the launcher terminal open

`StremioLauncherFULL.Main` routes every `return` through `ExitWithPause`
which prints `"(press any key to close this window)"` and blocks on
`Console.ReadKey`. Do not add bare `return` statements — always go
through `ExitWithPause(code)` so double-clickers can see the last 20
lines of output before the window closes.
