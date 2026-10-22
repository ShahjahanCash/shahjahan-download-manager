# Download Manager Extension (Phase 5, Manifest V3)

## What it does

- **Download interception:** with interception enabled, `chrome.downloads.onCreated`
  pings the desktop app first. Only if the app answers does it cancel the
  browser download and forward the URL (+ cookies for that URL, as a Cookie
  header) via Native Messaging. If the app is not running, the browser
  download is left alone and a notification explains why.
- **Video overlay:** the ISOLATED content script draws a floating
  "Download this video" button in a Shadow DOM over qualifying `<video>`
  elements (≥160×90). The MAIN world injected script hooks fetch/XHR,
  scans performance entries and video elements, and parses HLS/DASH
  manifests so the overlay can offer a quality picker.
- **Quality picker:** progressive MP4/WebM sources download directly.
  HLS master playlists list variants by resolution/bandwidth; DASH MPDs
  list Representations. Picking a variant sends that variant URL to the
  desktop app.
- **Popup:** shows desktop-app connection status, interception/overlay
  toggles, and videos detected on the current tab, each with download
  buttons.
- **Context menu:** right-click a link, video, audio, or image and choose
  "Download with Download Manager".

## Install (Chrome/Edge)

1. Build the desktop app and start it once (`npm run electron`), so the
   bridge is running.
2. Open `chrome://extensions`, enable Developer mode, Load unpacked,
   select `extension/`.
3. Copy the extension id shown on its card.
4. From the project root, run:
   ```bash
   node dist/cli.js install-host --browser chrome --extension-id <id> --out /tmp/dm-host
   ```
   On Windows, double-click the generated `.reg` file to register the
   native host, then reload the extension.
5. Reload the extension and open the popup: it should say "Connected".

## Install (Firefox)

Use `extension/manifest.firefox.json` as the manifest (copy it over
`manifest.json` in a Firefox-only copy, or load it via
`about:debugging` with that file renamed). Its gecko id is
`download-manager@local`, so register with:
```bash
node dist/cli.js install-host --browser firefox --extension-id download-manager@local --out /tmp/dm-host
```
Firefox MAIN-world content scripts are less complete than Chrome's, so
video detection there relies mainly on `<video>` sources; HLS/DASH
detection via fetch hooks may be limited. Requires Firefox 128+.

## Known limits (honest, Phase 6)

- **Blob/data downloads are not intercepted:** a blob: URL is page-local
  and the desktop app cannot fetch it, so those are left to the browser.
- **HLS/DASH segment assembly works (Phase 6):** picking a variant
  downloads its segments in parallel, decrypts AES-128 segments, and
  assembles them. TS to MP4 remux and DASH video+audio mux use ffmpeg
  when it is installed; without ffmpeg you get a playable .ts file or
  separate video/audio files, and the app says so. Live streams
  (no EXT-X-ENDLIST / dynamic MPD) are not supported.
- **DRM/EME-protected streams are out of scope** and are not offered.
- **Authenticated downloads** forward cookies for the download URL only;
  auth headers are not persisted by the desktop app, so a resumed
  download after an app restart may need to be re-sent from the browser.
- The extension has been validated statically here
  (`npm run extension:check` + parser tests). It has **not** been loaded
  in a real Chrome/Edge/Firefox yet — that step needs a desktop browser,
  which this Linux container does not provide.
