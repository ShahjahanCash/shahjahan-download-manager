# Shahjahan Download Manager (IDM-style) — Phase 0–7, UI 0.6.4

## What works now (0.6.4: bug fixes + YouTube downloader)

Bug fixes (all covered by new regression tests, 45/45 passing):
- New Task Segments and Speed limit are now actually honoured per download (they were silently ignored and the manager defaults were always used).
- Servers that advertise `Accept-Ranges: bytes` on HEAD but ignore Range on GET now fall back to a single stream instead of failing after retries.
- HTTP 416 for an already-complete segment is handled (was dead code behind the "expected 206" check).
- Bridge Host/Origin checks now match hostnames exactly (`127.0.0.1.evil.com` no longer passes as loopback).
- Stream detection (`.m3u8`/`.mpd`) now looks at the URL path only, not query strings, in both the bridge and the extension.
- Stream chunk bars are bucketed to max 64 bars (long HLS videos used to render hundreds of divs per tick); the details dialog caps rows at 100.
- Changing theme/accent in Settings no longer wipes the Segments/Speed limit you typed in the New Task form.

YouTube downloader (new "▶ YouTube" button in the top bar):
- Powered by yt-dlp + ffmpeg, both bundled in the installer (no separate setup). If either is ever missing, the card offers one-click downloads.
- Fetch info shows thumbnail, title, uploader, duration and max quality before you download.
- Options: Video (best / 2160p / 1440p / 1080p / 720p / 480p / 360p) or Audio only (MP3 / M4A / Opus / WAV / FLAC at best / 320 / 192 / 128 kbps), container MP4 / WebM / source, subtitles (language + auto-generated + embed), full-playlist download with from/to range, embed thumbnail, embed metadata & chapters, SponsorBlock sponsor removal, parallel fragments (1 / 4 / 8).
- Progress, pause (resumes from yt-dlp partial files), cancel and queue/concurrency all reuse the normal job list. Saves under Downloads, sorted by category (Video / Audio).
- Honest limits: age-restricted / login-only videos are not supported (no cookie handling); live streams are not supported; a download that needs ffmpeg features warns in the job instead of failing when ffmpeg is missing.

A separate TypeScript/Node app built on patterns borrowed from `morluto/rea`
(layered engine, Zod-style contracts in spirit, loopback-safe local servers,
fixture-based tests) — **not** a fork of REA, and REA itself is untouched.

## What works now (UI 0.6.3: Figma dark style)

The user chose the Figma Community "Download Manager" design (Erfan
Amade, CC BY 4.0, single preview, no settings screen) over the
Behance light/green cards, so 0.6.3 restyles the app around it as an
original implementation (not copied assets): dark theme is now the
default, with near-black surfaces (#0b0b11), a darker sidebar, light
gray text, and a purple-to-teal gradient accent ("Figma Gradient" in
Settings — buttons, progress bars, disk bar). The download list is now
a table-style grid: file tile | file + thin gradient bar | size |
status pill | time left (speed + ETA) | date | actions, with a
column header row in list view. New Figma affordances, all
functional: a toolbar row (Resume All, Pause All, Clear Completed,
Options), a right-click context menu per row (Open, Open Folder,
Pause/Resume, Properties = details dialog, Delete), and a Disk Space
card in the sidebar (free/total/used % for the downloads drive, via
`statfs`, refreshed every 60 s and on folder change). The Behance
light theme and other accents remain selectable in Settings; the
Premium $32 offer card from the Figma preview was deliberately not
copied. Fresh installs start dark + Figma accent; existing saved
settings are untouched.

## What works now (UI 0.6.2: Behance IDM redesign style + Settings)

The app is now named **Shahjahan Download Manager** (window title,
brand, installer, shortcuts, extension). The Electron UI follows the
Behance IDM 7.0 redesign the user shared (see 0.6.1 notes below), and
the sidebar gear button now opens a full **Settings panel** instead
of a single dark-mode toggle. Everything in it applies live:

The Electron UI now follows the Behance IDM 7.0 redesign the user
shared: Apple Green (#60CD38) primary, Bleu De France (#2D96F6)
secondary, #F2F2F2 background, charcoal text, thin green progress
bars, colored file-type tiles (blue MP4, red MP3, gray DOC, yellow
ZIP, purple EXE), a narrow sidebar (All Downloads, Downloading,
Compressed, Document, Music, Program, Video, Completed, Paused,
Failed), a top bar with Search Tasks + a green pill "+ New Task",
and a New Download Task card with URL, Category dropdown (now
functional: manager.add accepts a category override), segments, and
speed limit. Progress updates move bars in place instead of
rebuilding the list, so the UI no longer flickers. The design is an
original implementation inspired by that gallery, not a copy of its
assets.

- **Appearance:** Theme Light / Dark / System (follows Windows),
  accent colour (Apple Green, Bleu De France, Dark Orchid, Sunset
  Orange, Teal — drives buttons, bars and highlights), layout
  density Comfortable / Compact.
- **Downloads:** default segments, default speed limit, max
  concurrent downloads (1–5), downloads folder with Browse… and
  Open folder. Folder + concurrency are saved in the app's userData
  `settings.json` and survive restarts; they apply to new UI and
  bridge downloads.
- **Display:** per-chunk progress bars on/off, file path under each
  download on/off, in-app completion toast on/off.
- **About + Reset to defaults** in the same panel. The old single
  `dm-theme` localStorage toggle migrates into the new settings on
  first run, and the details dialog follows the same theme/accent.

## What works now (Phase 7: Windows hardening & release)

- **Long paths** (`src/engine/paths.ts`): on win32, destinations are
  passed to fs with the `\\?\` extended-length prefix (UNC form for
  network paths), so paths over the classic 260-character MAX_PATH
  work. No-op on other platforms.
- **Antivirus locks** (`src/engine/fileOps.ts`): rename/unlink/journal
  writes retry on EPERM/EBUSY/ENOTEMPTY/EACCES with backoff (6 attempts,
  ~3.1 s total) instead of failing the download when a scanner briefly
  locks a just-written file. Non-lock errors fail immediately.
- **>4 GiB files:** audited — the engine uses plain JS numbers (exact
  to 2^53) with no 32-bit truncation anywhere, so segment offsets
  above 4 GiB plan correctly (tested: 5 GiB + 123 bytes, full coverage,
  last segment start > 4 GiB). Disk space, not arithmetic, is the limit.
- **Installer:** a real NSIS `Download Manager-Setup-0.6.0.exe`
  (111 MB, LZMA, 374 MB payload) was built on this Linux container
  with the native Linux makensis from electron-builder's NSIS cache
  (`scripts/download-manager.nsi`, install to
  `$PROGRAMFILES64\Download Manager`, desktop + Start Menu shortcuts,
  Add/Remove Programs entry + uninstaller). electron-builder's own
  NSIS step needs Wine, which apt could not provide here, so the
  script route above is the reproducible build. The installer is
  unsigned, so SmartScreen will warn on first run: More info -> Run anyway.
- **Code signing:** opt-in via `CSC_LINK` + `CSC_KEY_PASSWORD`
  (or a Windows certificate store). Without them the build is unsigned
  — sign the .exe after building if you need SmartScreen trust.
- **Updates** (`src/app/updater.ts`, wired in `electron/main.mjs`):
  one startup check against a JSON feed `{version, url}` from
  `DM_UPDATE_URL`, with a user-confirmed dialog that only opens the
  installer URL in the browser. Nothing downloads or installs
  automatically, and no code runs from the feed.
- **Packaging check:** `npm run packaging:check` validates the
  builder config, icons, and main-process wiring without building.
  It also scans every bare import in `dist/` + `electron/` and fails
  if any is neither a Node builtin nor a declared `dependencies`
  entry, and — when `dist-installer/win-unpacked/resources/app.asar`
  exists — verifies every declared dependency is inside the asar.
  `tests/packaging-deps.test.ts` runs the same import rule over
  `src/`. This is the regression guard for the 0.6.7 launch crash:
  `src/engine/proxy.ts` imported `undici`, which was never declared
  in `package.json`, so dev tests passed (node_modules happened to
  contain it via @electron/get) while the packaged installer died on
  launch with `ERR_MODULE_NOT_FOUND`. Since 0.7.0, `undici` is a
  declared runtime dependency and no build with an unresolvable
  import can pass these checks.

### Phase 7 limits (honest)

- The NSIS installer and the Windows .exe have not been *run* on
  Windows — only packaged (dir build) and smoke-tested under Linux
  Xvfb. Real Windows testing (long paths, AV locks, installer,
  signing) still needs a Windows machine.
- Auto-update is a check + browser download, not an in-app silent
  installer (electron-updater was deliberately not added).

## What works now (Phase 6: HLS/DASH assembly)

- **Stream downloads** (`src/stream/`): HLS master/media playlists and
  DASH MPDs (SegmentTemplate with SegmentTimeline, SegmentList).
  Segments download in parallel (default 4), with retry, a
  `.stream.json` journal, and pause/resume that skips finished segments.
- **Assembly:** HLS fMP4 (EXT-X-MAP init + segments) concatenates to a
  valid MP4 with no remux. HLS MPEG-TS concatenates, then remuxes to
  MP4 with ffmpeg when it is installed. DASH video+audio muxes with
  ffmpeg; without ffmpeg, or when remux/mux fails on the input, the app
  **falls back instead of failing**: a playable .ts file, or separate
  video/audio files, with the fallback and final path reported.
- **AES-128:** HLS segments encrypted with EXT-X-KEY METHOD=AES-128
  are decrypted (explicit IV, or the segment media sequence as IV).
  DRM/EME and live streams (no EXT-X-ENDLIST, dynamic MPD) are out of
  scope and are rejected with a clear error.
- **Wiring:** `dm stream <manifest-url> [--out <path>] [--variant <url>]`,
  manager `addStream()` (shared queue/concurrency with regular jobs,
  pause/resume/cancel), bridge `add_download` with `stream: true`
  (auto-detected from .m3u8/.mpd URLs, .m3u8/.mpd filenames become
  .mp4), and the extension now flags HLS/DASH forwards as streams.
- **Limits:** segment downloads collect each segment in memory before
  writing (segments are normally a few MB); live streams, SAMPLE-AES,
  and DRM are not supported. Real TS/MP4 remux with ffmpeg is not
  covered by the dummy-byte tests — the tests prove concatenation,
  decryption, and the ffmpeg-failure fallback, not a real remux.

## What works now (Phase 5: browser extension)

The extension lives in `extension/` (Chrome/Edge `manifest.json`,
Firefox `manifest.firefox.json`). Validate it without a browser with
`npm run extension:check`.

- **Download interception** (`background.js`): pings the desktop app
  first; only on success does it cancel the browser download and
  forward the URL (+ cookies for that URL). If the app is absent, the
  browser download is left alone. Blob/data URLs are skipped (page-local).
- **Video overlay** (`content.js` + `injected.js`): a Shadow DOM
  "Download this video" button over qualifying `<video>` elements,
  with a quality menu. The MAIN-world injected script hooks fetch/XHR,
  scans performance entries and video elements, and parses HLS/DASH
  manifests (`lib/parsers.js`, tested) so the picker lists variants by
  resolution/bandwidth.
- **Popup:** connection status, interception/overlay toggles, and
  videos on the current tab with download buttons. Context menu:
  "Download with Download Manager" for links, video, audio, images.
- **Install:** load unpacked, copy the extension id, then
  `node dist/cli.js install-host --browser chrome --extension-id <id>`,
  import the `.reg` on Windows, reload the extension. Full steps and
  limits are in `extension/README.md`.

### Phase 5 limits (honest, updated by Phase 6)

- HLS/DASH segment assembly is now done (Phase 6 above); picking a
  variant downloads and assembles it. Progressive MP4/WebM downloads
  work end-to-end.
- DRM/EME streams are out of scope; blob/data downloads are not intercepted.
- The extension has been validated statically + parser-tested here, but
  **not yet loaded in a real desktop browser** — that needs a desktop
  browser, which this container does not provide. Firefox MAIN-world
  detection is also less complete than Chrome's.

## What works now (Phase 4: bridge)

### Desktop ↔ browser bridge (Phase 4, new)

- **Protocol v1** (`src/bridge/protocol.ts`): `ping`, `get_bridge_info`,
  `list`, `add_download`, `pause`, `resume`, `cancel`. URLs must be
  http/https, filenames must be bare names (no traversal), headers are
  a capped flat string map, unknown types are rejected.
- **Native Messaging host** (`src/bridge/nativeHost.ts`): Chrome/Firefox
  4-byte length-prefixed JSON over stdio. It validates, then forwards
  to the loopback bridge. If the desktop app is not running it answers
  `app_not_running` — it never silently starts a second manager.
- **Loopback HTTP bridge** (`src/bridge/server.ts`): bound to
  127.0.0.1 only, bearer-token protected, Host must be loopback,
  hostile Origins rejected, no CORS allow-origin. Endpoints:
  `GET /health`, `GET /api/downloads`, `POST /api/downloads`,
  `POST /api/downloads/:id/pause|resume|cancel`, and
  `GET /api/events` (SSE progress/jobs).
- **Discovery:** the running app (Electron, or `dm bridge`) writes
  `~/.download-manager/bridge.json` with port + token; the host reads
  it. The Electron app starts the bridge on launch and deletes the
  file on quit.
- **Host registration:** `dm install-host --browser chrome|edge|firefox
  --extension-id <id> --out <dir>` writes the browser manifest and a
  Windows `.reg` file to import on Windows.
- **Headless bridge for testing:** `dm bridge --dir <dir> [--port <n>]`,
  `dm native-host`, `dm bridge-info`.

## What works now (headless engine + CLI + Electron UI)

### Electron desktop UI (Phase 3, new)

- **Main window** (`electron/`): download list with file, category,
  overall progress bar, live speed, ETA, status, and Pause / Resume /
  Details / Cancel actions. Add form takes a URL, segment count, and
  optional speed limit. Downloads auto-categorise into the OS Downloads
  folder under `DownloadManager/<Category>/`.
- **IDM-style progress dialog:** the Details button opens a separate
  window per download showing filename, URL, destination, status,
  progress, speed, ETA, and **one progress bar per chunk**, updating
  from the engine's progress events.
- **Tray (best-effort):** Show / Quit menu; tray creation is guarded
  so desktops without a tray still run.
- **Security model:** `contextIsolation` on, `nodeIntegration` off,
  renderer gets only a narrow `window.dm` API via preload. The Electron
  main process is a thin IPC shell over `src/app/manager.ts`, so all
  queue/pause/resume logic is headless and unit-tested.
- **Run it:** `npm run electron` (on Windows, no sandbox flag needed).
  Smoke test here: `npm run electron:smoke` — verified under Xvfb,
  window opens and logs "Download Manager window ready", then exits.
  The D-Bus warnings in that container run are harmless (no system bus).

## What works now (headless engine + CLI)

- **Probe:** HEAD, then a `0-0` Range GET fallback. Size, `Accept-Ranges`,
  `ETag`, `Last-Modified`, filename from `Content-Disposition` or URL.
- **Dynamic file segmentation:** files are split into concurrent Range
  segments (default 8, min 256 KiB per segment). An idle worker re-splits
  the largest remaining claimed segment instead of waiting for a straggler.
- **Pause, resume, recovery:** a JSON journal next to the `.part` file
  records every segment. `Ctrl+C` pauses gracefully; `resume` continues
  from the journal. If the server file changed size/`ETag`, the `.part`
  file is gone, or Range is unsupported, it restarts from scratch rather
  than producing a corrupt file.
- **Retry:** per-segment retries with exponential backoff after a
  mid-stream disconnect, resuming that segment from its last byte.
- **Redirects and no-Range fallback:** a 200 response to a Range-less
  server downloads as a single stream.
- **Speed limiting:** shared token bucket (`--limit <bytes/sec>`).
- **Categories:** Video, Audio, Documents, Compressed, Programs, General
  by extension, with MIME fallback. Auto downloads go to
  `downloads/<Category>/<filename>`.
- **Queue/scheduler library:** `DownloadQueue` orders by priority, defers
  items with a future `scheduledAt`, and caps concurrent jobs. It is
  library code for now — there is no persistent daemon yet.
- **CLI progress:** live percent, downloaded/total, smoothed speed, ETA,
  and per-chunk percentages.

## Usage

```bash
npm install
npm run build

# Download (auto-categorised into downloads/<Category>/)
node dist/cli.js add https://example.com/file.zip

# With options
node dist/cli.js add https://example.com/video.mp4 \
  --out /tmp/demo.mp4 --segments 8 --limit 1048576

# Pause with Ctrl+C, then resume / inspect
node dist/cli.js resume /tmp/demo.mp4.part
node dist/cli.js status /tmp/demo.mp4
```

## Verified

```bash
npm run typecheck   # clean
npm test            # 32 tests pass (local HTTP server fixtures)
npm run electron:smoke  # Electron window opens under Xvfb, then exits
npm run extension:check # Extension manifests + behaviour strings
npm run packaging:check # Windows packaging inputs (no installer build)
npm run dist:win:dir   # Windows unpacked bundle (verified on Linux)
```

Tests cover: segment coverage, categorisation, segmented byte-exact
download, no-Range fallback, redirect, disconnect-and-retry,
pause-and-resume from the journal, queue ordering/scheduling,
AppDownloadManager concurrency + pause/resume (including pause during
startup), bridge protocol/framing/manifests, loopback auth + downloads,
native-host forwarding + `app_not_running`, extension manifests,
interception/overlay strings, HLS/DASH parser correctness
(including two parser bugs the tests caught: relative-URL resolution
without a URL global, and `width` matching inside `bandwidth`),
and stream assembly: HLS TS concat + ffmpeg-failure fallback, HLS
fMP4 concat, AES-128 decryption, DASH video/audio fallback, and
stream pause/resume from the journal, plus Windows hardening:
long-path prefixing, AV-lock retry, >4 GiB segment planning, and
update-feed version comparison.

### Audit fixes applied before Phase 4

- **Manager pause/cancel race (real bug):** pausing or cancelling while
  `startDownload`/`resumeDownload` was still probing silently let the
  download continue and overwrite the paused/cancelled state. The pump
  now checks for pause/cancel after startup and pauses/cleans up, and
  completion handlers ignore jobs that no longer exist.
- **CLI dispatch bug (real bug, caught end-to-end):** flag-only
  commands (`bridge`, `install-host`) lost their first flag, so
  `--dir` was ignored and downloads landed in `downloads/` instead of
  the requested dir. Dispatch now separates positional commands from
  flag-only commands; re-tested end-to-end with matching SHA-256.
- **Dead code removed:** `src/app/format.ts` was unused — the CLI now
  imports it instead of duplicating it; the unused `Runner` type in
  `queue.ts` was removed.
- **Typecheck gap closed:** `npm run typecheck` now also typechecks
  `tests/` (previously only `src/`), and a redundant dynamic import
  in the downloader was replaced with a top-level import.
- **Stray folders removed:** CLI/manager no longer pre-create category
  folders; the engine creates the destination folder on start.

A real end-to-end CLI run against a local Range server downloaded
5.0 MiB with matching SHA-256 hashes for source and output.

## Not built yet (later phases)

- Persistent queue daemon and scheduler service (in-memory queue with
  max-concurrency is done; jobs do not yet survive an app restart —
  the per-download journal does, so paused downloads can be resumed
  after relaunch by re-adding them).
- Real Windows run-through: install the NSIS build on Windows, test
  long paths / AV locks / signing end-to-end, and register the Native
  Messaging host from the installer (today: manual `install-host`).
- HLS/DASH segment download and ffmpeg remux.
- Windows installer, code signing, auto-update.

## Known limits (v0.1, by design)

- A server that advertises `Accept-Ranges` but answers a Range request
  with anything other than 206 fails that download (fail-closed) instead
  of silently falling back mid-flight.
- Auth headers/cookies are **not** persisted in the journal. The browser
  extension must re-supply them on resume — that is the correct place
  for the expired-link recovery flow.
- DRM/EME-protected streams are out of scope.
- Windows-specific UI/installer behaviour has not been tested here
  (this environment is Linux); it needs a Windows machine in Phase 3+.

## 0.6.6 — 14 features (queues, capture, power tools)

- Persistent queue: job list (incl. completed history) saved to userData/queue.json and restored on startup; interrupted jobs come back paused and resume from journals.
- Multiple queues: sidebar queue list, create/delete (empty only), move jobs via right-click menu, per-queue concurrency respected by the pump.
- Completion action: do nothing / shut down / sleep / close app when everything is finished (shutdown and sleep always ask first).
- Clipboard monitor: a copied http/https/ftp link prefills New Task (toggle in Settings, default on).
- Site grabber: paste a page URL, tick links by type (media/image/document/archive), download the selection.
- Drag & drop: drop a link anywhere on the window to start it (YouTube links open the YouTube card).
- Proxy: HTTP(S) proxy setting applied to fetch-based downloads, streams, grabber and yt-dlp (--proxy). SOCKS is not supported.
- FTP/FTPS: single-stream downloads with REST resume (basic-ftp). SFTP is not included yet.
- Checksum: optional expected SHA-256 per download, verified after completion; computed SHA-256 shown in job data; mismatch raises a warning.
- Per-category folders: each category can point at its own folder in Settings.
- Auto-retry: failed jobs retry on transient errors only (never 404/auth), with doubling backoff; status "retrying".
- Speed graph + search: aggregate speed sparkline in the toolbar; search now matches filename, URL, destination and category.
- YouTube cookies: --cookies-from-browser (Chrome/Edge/Firefox/Brave) or a cookies.txt file, for age-restricted / login-only videos.
- Live HLS capture: polls a live .m3u8, appends new segments, pause finalises to .mp4 (ffmpeg) or .ts. Live DASH remains unsupported.

## 0.6.7 — extension grabber, notifications, queue caps, torrents, Glass

- Extension site grabber: the popup's "Grab links on this page" lists the page's links (anchors, images, media) with checkboxes and sends the selection to the desktop app.
- Windows native notifications: OS notification when a download completes (click focuses the app); toggle in Settings, default on.
- Per-queue speed limits: each queue can cap its downloads (Settings section); the cap limits each job's own limit and is persisted in queue.json.
- Torrent / magnet support: paste a magnet link or a .torrent URL in New Task; WebTorrent downloads with pause/resume from partial files; cancel deletes only that torrent's files. Queue caps and global limits do not apply to torrent streams (WebTorrent has no per-torrent rate limiter wired in); streams and FTP are likewise unaffected by queue caps.
- Glass theme: new "Glass" theme option — frosted translucent panels with blur over an aurora gradient (CSS only, works on any Windows version).
- Release hardening (before the first 0.6.7 installer): queue saves are serialised so concurrent writes cannot lose state; restore no longer triggers a save (it raced with teardown); quitting now flushes the queue before exit; a pause during a download probe no longer stalls the rest of the queue; Windows packaging skips the native-module rebuild (cross-compiling utp-native from Linux is unsupported — WebTorrent falls back to TCP on Windows, its uTP require is guarded).
- Low-end PC optimization: progress broadcasts to the window are throttled to 1 Hz (state changes still push instantly); job cards cache their DOM elements and write text only when it changes; chunk bars are capped at 32 and repaint at most twice a second; the speed graph repaints at most twice a second; no DOM work happens while the window is hidden; Glass blur now applies only to the sidebar/modal/menus (never to per-download rows); new Settings → Display toggle "Reduce effects (low-end PC)" disables blur, animations and transitions.
- Installer packaging note: the Windows package ships only the en-US Chromium locale (the other 54 locale .pak files are deleted from win-unpacked before running makensis). Reason: the Linux makensis build crashes (SIGBUS) once the total payload passes ~512 MiB — 517 MiB in, 468 MiB after the trim, and the trimmed build succeeds. The app UI itself is English, so Chromium dialogs fall back to English. Re-trim after every `dist:win:dir` rebuild before running makensis.

## 0.7.3

- Liquid Glass theme: bright, highly translucent glass with specular edge highlights and backdrop blur (Settings → Appearance and the first-run wizard). Blur follows the same low-end rule as Glass — large panels only — and the global "Reduce effects" toggle still kills it.
- Theme picker overflow fix: the 11 theme pills now wrap onto a second row instead of spilling past the settings modal (the bug visible in the 0.7.2 Settings screenshot).

## 0.7.2 — speed fix + OmniGet-inspired UI/UX batch

- Speed fix, root cause: the New Task Segments select defaults to "Auto" (value 0), and the engine computed `workerCount = min(0, n) = 1` — so every Auto download silently ran single-stream. Fixed: 0 now means "use all segments". Same 100 MB file via CLI: 19 s sequential before, 6 s fully parallel after. Regression test in tests/engine.test.ts (Auto on the drip-feed endpoint must move 2+ segments at once).
- Speed tuning: yt-dlp default concurrent fragments 1 → 4 (covers extension/bridge paths; the YouTube card already passed 4); Auto segment recommendations raised (≤100 MB → 8, ≤1 GB → 16, >1 GB → 32); dynamic tail-split threshold 1 MB → 512 KB.
- Stepped first-run wizard: Look (theme + accent with live preview) → Downloads (folder, speed limit, default segments) → Tools (yt-dlp/ffmpeg status checked fresh on open, with Install buttons) → Ready (responsible-use note + extension guide). Skip setup marks first-run done without saving.
- Settings search + per-section Reset: a search box filters settings rows (its own marker class, so rows hidden for other reasons stay hidden and clearing restores state); every section except Statistics has a Reset button that reuses each control's own change handler.
- Theme gallery + typography presets + live preview: new Dracula, Catppuccin Mocha and E-Ink Day themes (in Settings and the wizard); Typography presets (Default / Compact / Reading / Custom) set font size + density together and stay in sync; an Appearance preview card restyles live with theme and accent.
- Download stage pipeline + command transparency: job cards show stage chips (YouTube: Download → Finishing → Done; hash jobs: Download → Verify → Done; else Download → Done) with done/current/failed/paused states; the details dialog shows the exact yt-dlp command line (copyable) for YouTube jobs and an honest engine summary for HTTP/torrent/stream/FTP.
- Persistent bottom aggregate bar: fixed bar above the main area showing active/completed counts, overall percent and total speed, updated on the 1 Hz job refresh with change-only writes.
- Stale-warning sync: the YouTube download button now re-checks tools fresh before creating a job (and refuses with a clear message when yt-dlp is missing) instead of trusting the card-open status; the manager's pump-time guard is covered by a test, and install buttons already refresh status after installing.
