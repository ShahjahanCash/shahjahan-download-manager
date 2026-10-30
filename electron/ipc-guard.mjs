// IPC guard — Phase 1 of the 1.0.4 upgrade (see UPGRADE-PLAN-1.0.4.md).
//
// Why this file exists on its own: electron/main.mjs imports Electron and
// calls app.getPath() at module load, so it cannot be imported in a plain
// Node/vitest run. This module has no Electron import, so its two checks
// are unit-testable (tests/ipc-guard.test.ts) while main.mjs stays the
// only place that wires them into ipcMain.
//
// Sender rule: an invoke is trusted only if event.sender is the webContents
// of a window this app itself created — the main window, the widget window,
// or one of the open details dialogs. Anything else (a foreign WebContents,
// a destroyed sender, a missing sender) is rejected before the handler runs.
//
// Argument rule: only the clearly-typed, high-risk arguments are validated
// here. Handlers that already sanitise their input (dm:set-settings) keep
// their own logic untouched; this guard does not re-validate them.

function isLiveWindow(win) {
  return !!win && typeof win.isDestroyed === "function" ? !win.isDestroyed() : !!win;
}

export function isTrustedIpcSender(event, windows) {
  const sender = event?.sender;
  if (!sender) return false;
  if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) return false;
  const { mainWindow, widgetWindow, dialogWindows } = windows ?? {};
  if (isLiveWindow(mainWindow) && sender === mainWindow.webContents) return true;
  if (isLiveWindow(widgetWindow) && sender === widgetWindow.webContents) return true;
  if (dialogWindows && typeof dialogWindows.values === "function") {
    for (const win of dialogWindows.values()) {
      if (isLiveWindow(win) && sender === win.webContents) return true;
    }
  }
  return false;
}

export function assertTrustedIpcSender(event, windows) {
  if (!isTrustedIpcSender(event, windows)) {
    throw new Error("Untrusted IPC sender");
  }
}

function requireId(value, channel) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid argument for ${channel}: id must be a non-empty string`);
  }
}

function requireUrl(value, channel) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid argument for ${channel}: url must be a non-empty string`);
  }
}

const ID_CHANNELS = new Set([
  "dm:pause",
  "dm:resume",
  "dm:cancel",
  "dm:stop-seeding",
  "dm:delete-with-file",
  "dm:open-file",
  "dm:open-job-folder",
  "dm:open-details",
  "dm:delete-queue",
  "dm:pause-queue",
  "dm:resume-queue",
  "dm:create-queue",
]);

const URL_CHANNELS = new Set([
  "dm:add",
  "dm:add-torrent",
  "dm:add-stream",
  "dm:yt-info",
  "dm:yt-add",
  "dm:grab",
]);

export function assertIpcArgs(channel, args) {
  const list = args ?? [];
  if (ID_CHANNELS.has(channel)) {
    requireId(list[0], channel);
    return;
  }
  if (URL_CHANNELS.has(channel)) {
    requireUrl(list[0], channel);
    // opts, when present, must be an object (manager handlers use opts ?? {}).
    if (list[1] !== undefined && list[1] !== null && typeof list[1] !== "object") {
      throw new Error(`Invalid argument for ${channel}: opts must be an object`);
    }
    return;
  }
  if (channel === "dm:rename-queue" || channel === "dm:move-job") {
    requireId(list[0], channel);
    requireId(list[1], channel);
    return;
  }
  if (channel === "dm:set-queue-limit") {
    requireId(list[0], channel);
    if (typeof list[1] !== "number" || !Number.isFinite(list[1]) || list[1] < 0) {
      throw new Error(`Invalid argument for ${channel}: bytesPerSec must be a finite number >= 0`);
    }
    return;
  }
  if (channel === "dm:yt-install-tool") {
    // Enum ("ytdlp" / "ffmpeg") is intentionally NOT enforced here: the
    // existing handler returns { ok: false } for unknown tools, and this
    // guard must not change that into a thrown error.
    if (typeof list[0] !== "string") {
      throw new Error(`Invalid argument for ${channel}: tool must be a string`);
    }
    return;
  }
  // All other channels (dm:list, dm:queues, dm:get-info, dm:get-settings,
  // dm:choose-file, dm:choose-folder, dm:open-downloads-folder, dm:yt-tools,
  // dm:disk-space, dm:toggle-widget, dm:stats, dm:import-urls, dm:export-csv,
  // dm:set-settings) take no typed high-risk argument, or sanitise their
  // own input in the handler. No check here, by design.
}
