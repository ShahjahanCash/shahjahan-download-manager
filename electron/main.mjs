import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray, nativeImage, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { exec, execFile, spawn } from "node:child_process";
import { AppDownloadManager, parseImportUrls, isYoutubeImportUrl, jobsToCsv } from "../dist/app/manager.js";
import { BridgeServer } from "../dist/bridge/server.js";
import { writeBridgeInfo, deleteBridgeInfo } from "../dist/bridge/bridgeInfo.js";
import { checkForUpdates } from "../dist/app/updater.js";
import { fetchYoutubeInfo } from "../dist/yt/info.js";
import { findTools } from "../dist/yt/locate.js";
import { grabPageLinks } from "../dist/app/grabber.js";

const here = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes("--smoke-test");

let mainWindow = null;
let tray = null;
let bridgeServer = null;
let widgetWindow = null;
const prevJobStatus = new Map();
const dialogWindows = new Map();
const downloadsDir = join(app.getPath("downloads"), "DownloadManager");

// Settings that survive restarts, stored in the app's userData folder
// (e.g. %APPDATA%\Shahjahan Download Manager\settings.json). Only the
// two engine settings live here; appearance settings live in the
// renderer's localStorage, which both windows share.
function settingsPath() {
  return join(app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    if (!existsSync(settingsPath())) return {};
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const out = {};
    if (Number.isInteger(parsed.maxConcurrent) && parsed.maxConcurrent >= 1 && parsed.maxConcurrent <= 10) {
      out.maxConcurrent = parsed.maxConcurrent;
    }
    if (typeof parsed.downloadsDir === "string" && parsed.downloadsDir.trim()) {
      out.downloadsDir = parsed.downloadsDir.trim();
    }
    if (parsed.categoryFolders && typeof parsed.categoryFolders === "object") {
      out.categoryFolders = parsed.categoryFolders;
    }
    if (typeof parsed.proxyUrl === "string") out.proxyUrl = parsed.proxyUrl;
    if (Number.isInteger(parsed.retryAttempts) && parsed.retryAttempts >= 0 && parsed.retryAttempts <= 10) {
      out.retryAttempts = parsed.retryAttempts;
    }
    if (Number.isInteger(parsed.retryDelayBaseSec) && parsed.retryDelayBaseSec >= 1 && parsed.retryDelayBaseSec <= 300) {
      out.retryDelayBaseSec = parsed.retryDelayBaseSec;
    }
    if (typeof parsed.completionAction === "string") out.completionAction = parsed.completionAction;
    if (typeof parsed.clipboardMonitor === "boolean") out.clipboardMonitor = parsed.clipboardMonitor;
    if (typeof parsed.nativeNotifications === "boolean") out.nativeNotifications = parsed.nativeNotifications;
    if (typeof parsed.firstRunDone === "boolean") out.firstRunDone = parsed.firstRunDone;
    if (parsed.schedulerPolicy && typeof parsed.schedulerPolicy === "object") out.schedulerPolicy = parsed.schedulerPolicy;
    if (parsed.smartConfig && typeof parsed.smartConfig === "object") out.smartConfig = parsed.smartConfig;
    if (typeof parsed.autoExtract === "boolean") out.autoExtract = parsed.autoExtract;
    if (typeof parsed.defenderScan === "boolean") out.defenderScan = parsed.defenderScan;
    if (parsed.seedingPolicy && typeof parsed.seedingPolicy === "object") out.seedingPolicy = parsed.seedingPolicy;
    if (parsed.notificationPrefs && typeof parsed.notificationPrefs === "object") out.notificationPrefs = parsed.notificationPrefs;
    return out;
  } catch {
    return {};
  }
}
// Completion action + clipboard monitor live here (main owns shutdown
// and clipboard); the renderer only edits them through set-settings.
let completionAction = "none";
let clipboardMonitor = true;
let nativeNotifications = true;
let firstRunDone = false;
// 0.7.0: scheduler/smart/extract/scan/seeding + notification prefs.
// Defaults match the manager's; validation happens in set-settings.
let notificationPrefs = {
  banners: true,
  sound: false,
  quietStart: "",
  quietEnd: "",
  disabledCategories: [],
};
function applyEngineSettings(partial) {
  if (partial.maxConcurrent !== undefined) manager.setMaxConcurrent(partial.maxConcurrent);
  if (partial.downloadsDir !== undefined) {
    manager.setDownloadsDir(partial.downloadsDir);
    bridgeServer?.setDownloadsDir(partial.downloadsDir);
  }
  if (partial.categoryFolders !== undefined) manager.setCategoryFolders(partial.categoryFolders);
  if (partial.proxyUrl !== undefined) manager.setProxy(partial.proxyUrl || null);
  if (partial.retryAttempts !== undefined || partial.retryDelayBaseSec !== undefined) {
    const current = manager.getSettings();
    manager.setRetryConfig(
      partial.retryAttempts ?? current.retryAttempts,
      partial.retryDelayBaseSec ?? current.retryDelayBaseSec,
    );
  }
  if (partial.completionAction !== undefined) completionAction = partial.completionAction;
  if (partial.clipboardMonitor !== undefined) clipboardMonitor = partial.clipboardMonitor;
  if (partial.nativeNotifications !== undefined) nativeNotifications = partial.nativeNotifications;
  if (partial.firstRunDone !== undefined) firstRunDone = partial.firstRunDone;
  if (partial.schedulerPolicy !== undefined) manager.setSchedulerPolicy(partial.schedulerPolicy);
  if (partial.smartConfig !== undefined) manager.setSmartConfig(partial.smartConfig);
  if (partial.autoExtract !== undefined) manager.setAutoExtract(partial.autoExtract);
  if (partial.defenderScan !== undefined) manager.setDefenderScan(partial.defenderScan);
  if (partial.seedingPolicy !== undefined) manager.setSeedingPolicy(partial.seedingPolicy);
  if (partial.notificationPrefs !== undefined) notificationPrefs = { ...notificationPrefs, ...partial.notificationPrefs };
}
function saveSettings(partial) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ ...loadSettings(), ...partial }, null, 2));
  } catch (error) {
    console.error("Failed to save settings:", error?.message ?? error);
  }
}
function resolveTools() {
  return findTools({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"),
    devDir: here,
  });
}

const savedAtBoot = loadSettings();
if (savedAtBoot.completionAction) completionAction = savedAtBoot.completionAction;
if (savedAtBoot.clipboardMonitor !== undefined) clipboardMonitor = savedAtBoot.clipboardMonitor;
if (savedAtBoot.nativeNotifications !== undefined) nativeNotifications = savedAtBoot.nativeNotifications;

let lastProgressJobsAt = 0;
const manager = new AppDownloadManager({
  downloadsDir,
  maxConcurrent: 3,
  queuePath: join(app.getPath("userData"), "queue.json"),
  categoryFolders: savedAtBoot.categoryFolders ?? {},
  proxyUrl: savedAtBoot.proxyUrl ?? null,
  retryAttempts: savedAtBoot.retryAttempts ?? 3,
  retryDelayBaseSec: savedAtBoot.retryDelayBaseSec ?? 10,
  onQueueDrained: () => void handleCompletionAction(),
  youtubeTools: resolveTools,
  onProgress: (progress) => {
    // Progress ticks fire 4x/sec per job, but the list UI only needs
    // a 1 Hz refresh: state changes (pause/complete/fail) still push
    // immediately through onJobsChanged, so nothing arrives late.
    const now = Date.now();
    const pushJobs = now - lastProgressJobsAt >= 1000;
    if (pushJobs) lastProgressJobsAt = now;
    const jobs = pushJobs ? manager.list() : null;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("dm:progress", progress);
      if (pushJobs) window.webContents.send("dm:jobs", jobs);
    }
    if (bridgeServer) bridgeServer.broadcast("progress", progress);
    // 0.7.0 taskbar progress + tray tooltip, on the same 1 Hz
    // throttle as the list refresh — no extra per-tick work.
    if (pushJobs && mainWindow && !mainWindow.isDestroyed()) {
      const active = (jobs ?? []).filter(
        (job) => job.progress && job.progress.percent != null &&
          (job.status === "downloading" || job.status === "queued"),
      );
      if (active.length) {
        const avg = active.reduce((sum, job) => sum + (job.progress.percent ?? 0), 0) / active.length;
        mainWindow.setProgressBar(avg);
        if (tray) tray.setToolTip(`Shahjahan Download Manager — ${Math.round(avg * 100)}% (${active.length} downloading)`);
      } else {
        mainWindow.setProgressBar(-1);
        if (tray) tray.setToolTip("Shahjahan Download Manager");
      }
    }
  },
  onJobsChanged: (jobs) => {
    // Native Windows notifications (feature 10): a job flipping to
    // completed shows an OS notification; clicking it focuses the app.
    for (const job of jobs) {
      const before = prevJobStatus.get(job.id);
      if (before && before !== "completed" && job.status === "completed" && notificationsAllowedFor(job)) {
        try {
          const note = new Notification({
            title: "Download complete",
            body: job.filename,
          });
          note.on("click", () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
              mainWindow.focus();
            }
          });
          note.show();
        } catch {
          // Notifications can be blocked by OS policy; in-app toast remains.
        }
      }
      prevJobStatus.set(job.id, job.status);
    }
    for (const id of [...prevJobStatus.keys()]) {
      if (!jobs.some((job) => job.id === id)) prevJobStatus.delete(id);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("dm:jobs", jobs);
    }
    if (bridgeServer) bridgeServer.broadcast("jobs", jobs);
  },
});

async function startBridge() {
  try {
    bridgeServer = new BridgeServer(manager, { downloadsDir: manager.getSettings().downloadsDir });
    const info = await bridgeServer.start();
    await writeBridgeInfo(info);
    console.log(`Bridge running on http://127.0.0.1:${info.port}`);
  } catch (error) {
    // Bridge failure must not kill the UI; downloads still work locally.
    console.error("Bridge failed to start:", error?.message ?? error);
    bridgeServer = null;
  }
}

async function stopBridge() {
  if (bridgeServer) {
    await bridgeServer.stop().catch(() => undefined);
    bridgeServer = null;
  }
  await deleteBridgeInfo().catch(() => undefined);
}

function broadcastJobs() {
  const jobs = manager.list();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("dm:jobs", jobs);
  }
}

// Feature 3: when every job is finished, act on the user's setting.
// Shutdown/sleep always ask first (message box) — a download finishing
// while the user stepped away must never power off the PC unasked.
async function handleCompletionAction() {
  if (completionAction === "none" || !mainWindow || mainWindow.isDestroyed()) return;
  if (completionAction === "close-app") {
    app.quit();
    return;
  }
  const label = completionAction === "shutdown" ? "shut down" : completionAction === "restart" ? "restart" : "sleep";
  const answer = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "All downloads finished",
    message: `All downloads are complete. ${label === "shut down" ? "Shut down" : label === "restart" ? "Restart" : "Put"} this PC to ${label} now?`,
    buttons: [label === "shut down" ? "Shut down" : label === "restart" ? "Restart" : "Sleep", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return;
  if (process.platform === "win32") {
    if (completionAction === "shutdown") exec("shutdown /s /t 0");
    else if (completionAction === "restart") exec("shutdown /r /t 0");
    else exec("rundll32.exe powrprof.dll,SetSuspendState 0,1,0");
  } else if (completionAction === "shutdown") {
    exec("systemctl poweroff");
  } else if (completionAction === "restart") {
    exec("systemctl reboot");
  } else {
    exec("systemctl suspend");
  }
}

/** True when the local clock is inside the user's quiet hours (0.7.0).
 * Empty start/end disables quiet hours; overnight ranges wrap. */
function inQuietHours(now = new Date()) {
  const { quietStart, quietEnd } = notificationPrefs;
  if (!quietStart || !quietEnd) return false;
  const parse = (value) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = parse(quietStart);
  const end = parse(quietEnd);
  if (start === null || end === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function notificationsAllowedFor(job) {
  if (!nativeNotifications || !notificationPrefs.banners) return false;
  if (inQuietHours()) return false;
  if ((notificationPrefs.disabledCategories || []).includes(job.category)) return false;
  return true;
}

// Feature 5: clipboard monitor. Polls (cheap) and, for a fresh URL
// that is not already queued, asks the renderer to prefill New Task.
let lastClipboardText = "";
function startClipboardMonitor() {
  setInterval(() => {
    try {
      if (!clipboardMonitor || !mainWindow || mainWindow.isDestroyed()) return;
      const text = clipboard.readText().trim();
      if (!text || text === lastClipboardText) return;
      lastClipboardText = text;
      if (!/^(https?|ftp):\/\/\S+$/i.test(text)) return;
      if (manager.list().some((job) => job.url === text)) return;
      mainWindow.webContents.send("dm:clipboard-url", text);
    } catch {
      // Clipboard access can fail transiently; next tick retries.
    }
  }, 1500);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0e0e15",
    title: "Shahjahan Download Manager",
    icon: join(here, "build", "icon.png"),
    webPreferences: {
      preload: join(here, "preload.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(here, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // Closing the main window quits (tray menu can also quit). Downloads
  // are paused by the OS process exit; their journals allow resume.
  mainWindow.on("close", () => {
    if (!SMOKE) {
      // Keep behaviour simple and predictable: quit with the window.
    }
  });
}

// 0.7.0 mini floating speed monitor: a small always-on-top window
// that shows aggregate speed from the same dm:progress broadcasts the
// main window already receives — no extra polling, no extra IPC.
function createWidgetWindow() {
  widgetWindow = new BrowserWindow({
    width: 320,
    height: 96,
    minWidth: 260,
    minHeight: 80,
    title: "Download speed",
    icon: join(here, "build", "icon.png"),
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      preload: join(here, "preload.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  widgetWindow.loadFile(join(here, "renderer", "widget.html"));
  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });
}
function toggleWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
    widgetWindow = null;
  } else {
    createWidgetWindow();
  }
}

function openDetails(jobId) {
  const existing = dialogWindows.get(jobId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const job = manager.get(jobId);
  const dialog = new BrowserWindow({
    width: 640,
    height: 520,
    minWidth: 480,
    backgroundColor: "#0e0e15",
    title: job ? `Download: ${job.filename}` : "Download progress",
    icon: join(here, "build", "icon.png"),
    parent: mainWindow ?? undefined,
    modal: false,
    webPreferences: {
      preload: join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dialog.loadFile(join(here, "renderer", "dialog.html"), {
    query: { jobId },
  });
  dialog.on("closed", () => dialogWindows.delete(jobId));
  dialogWindows.set(jobId, dialog);
}

function createTray() {
  try {
    let icon = nativeImage.createEmpty();
    try {
      const fromFile = nativeImage.createFromPath(join(here, "build", "icon.png"));
      if (!fromFile.isEmpty()) icon = fromFile;
    } catch {
      // Keep the empty icon; the tray is best-effort.
    }
    tray = new Tray(icon);
    tray.setToolTip("Shahjahan Download Manager");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Show",
          click: () => {
            if (mainWindow) mainWindow.show();
            else createMainWindow();
          },
        },
        {
          label: "Pause all",
          click: async () => {
            for (const job of manager.list()) {
              if (job.status === "downloading" || job.status === "queued") await manager.pause(job.id);
            }
          },
        },
        {
          label: "Resume all",
          click: async () => {
            for (const job of manager.list()) {
              if (job.status === "paused") await manager.resume(job.id);
            }
          },
        },
        {
          label: "Speed monitor",
          click: () => toggleWidgetWindow(),
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => {
      if (mainWindow) mainWindow.show();
    });
  } catch {
    // Tray is best-effort (some Linux desktops have no tray).
    tray = null;
  }
}

ipcMain.handle("dm:add", async (_event, url, opts) => {
  const job = await manager.add(url, opts ?? {});
  return job;
});
ipcMain.handle("dm:pause", async (_event, id) => manager.pause(id));
ipcMain.handle("dm:resume", async (_event, id) => manager.resume(id));
ipcMain.handle("dm:cancel", async (_event, id) => manager.cancel(id));
ipcMain.handle("dm:list", async () => manager.list());
ipcMain.handle("dm:queues", async () => manager.listQueues());
ipcMain.handle("dm:create-queue", async (_event, name) => manager.createQueue(name));
ipcMain.handle("dm:rename-queue", async (_event, id, name) => manager.renameQueue(id, name));
ipcMain.handle("dm:delete-queue", async (_event, id) => manager.deleteQueue(id));
ipcMain.handle("dm:move-job", async (_event, jobId, queueId) => manager.moveToQueue(jobId, queueId));
ipcMain.handle("dm:set-queue-limit", async (_event, queueId, bytesPerSec) => manager.setQueueSpeedLimit(queueId, bytesPerSec));
ipcMain.handle("dm:add-torrent", async (_event, url, opts) => manager.addTorrent(url, opts ?? {}));
ipcMain.handle("dm:add-stream", async (_event, url, opts) => manager.addStream(url, opts ?? {}));
ipcMain.handle("dm:grab", async (_event, pageUrl) => grabPageLinks(pageUrl));
ipcMain.handle("dm:choose-file", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a cookies file",
    properties: ["openFile"],
    filters: [{ name: "Cookies", extensions: ["txt"] }, { name: "All files", extensions: ["*"] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("dm:get-info", async () => ({
  name: "Shahjahan Download Manager",
  version: app.getVersion(),
}));
ipcMain.handle("dm:get-settings", async () => ({ ...manager.getSettings(), completionAction, clipboardMonitor, nativeNotifications, firstRunDone, notificationPrefs }));
ipcMain.handle("dm:set-settings", async (_event, partial) => {
  const clean = {};
  if (partial && Number.isInteger(partial.maxConcurrent)) {
    clean.maxConcurrent = Math.max(1, Math.min(10, partial.maxConcurrent));
  }
  if (partial && typeof partial.downloadsDir === "string" && partial.downloadsDir.trim()) {
    clean.downloadsDir = partial.downloadsDir.trim();
  }
  if (partial && partial.categoryFolders && typeof partial.categoryFolders === "object") {
    clean.categoryFolders = partial.categoryFolders;
  }
  if (partial && typeof partial.proxyUrl === "string") clean.proxyUrl = partial.proxyUrl;
  if (partial && Number.isInteger(partial.retryAttempts)) {
    clean.retryAttempts = Math.max(0, Math.min(10, partial.retryAttempts));
  }
  if (partial && Number.isInteger(partial.retryDelayBaseSec)) {
    clean.retryDelayBaseSec = Math.max(1, Math.min(300, partial.retryDelayBaseSec));
  }
  if (partial && typeof partial.completionAction === "string") {
    clean.completionAction = ["none", "shutdown", "sleep", "restart", "close-app"].includes(partial.completionAction)
      ? partial.completionAction
      : "none";
  }
  if (partial && typeof partial.clipboardMonitor === "boolean") {
    clean.clipboardMonitor = partial.clipboardMonitor;
  }
  if (partial && typeof partial.nativeNotifications === "boolean") {
    clean.nativeNotifications = partial.nativeNotifications;
  }
  if (partial && typeof partial.firstRunDone === "boolean") {
    clean.firstRunDone = partial.firstRunDone;
  }
  if (partial && partial.schedulerPolicy && typeof partial.schedulerPolicy === "object") {
    const windows = Array.isArray(partial.schedulerPolicy.windows) ? partial.schedulerPolicy.windows : [];
    clean.schedulerPolicy = {
      enabled: partial.schedulerPolicy.enabled === true,
      windows: windows
        .filter((w) => w && typeof w.start === "string" && typeof w.end === "string")
        .map((w) => ({ start: w.start, end: w.end })),
    };
  }
  if (partial && partial.smartConfig && typeof partial.smartConfig === "object") {
    clean.smartConfig = {
      enabled: partial.smartConfig.enabled === true,
      smartLimitBytesPerSec: Math.max(0, Number(partial.smartConfig.smartLimitBytesPerSec) || 0),
      watchlist: Array.isArray(partial.smartConfig.watchlist)
        ? partial.smartConfig.watchlist.filter((w) => typeof w === "string")
        : [],
    };
  }
  if (partial && typeof partial.autoExtract === "boolean") clean.autoExtract = partial.autoExtract;
  if (partial && typeof partial.defenderScan === "boolean") clean.defenderScan = partial.defenderScan;
  if (partial && partial.seedingPolicy && typeof partial.seedingPolicy === "object") {
    clean.seedingPolicy = {
      enabled: partial.seedingPolicy.enabled === true,
      ratioLimit: Math.max(0, Number(partial.seedingPolicy.ratioLimit) || 0),
      maxMinutes: Math.max(0, Number(partial.seedingPolicy.maxMinutes) || 0),
    };
  }
  if (partial && partial.notificationPrefs && typeof partial.notificationPrefs === "object") {
    clean.notificationPrefs = {
      banners: partial.notificationPrefs.banners !== false,
      sound: partial.notificationPrefs.sound === true,
      quietStart: typeof partial.notificationPrefs.quietStart === "string" ? partial.notificationPrefs.quietStart : "",
      quietEnd: typeof partial.notificationPrefs.quietEnd === "string" ? partial.notificationPrefs.quietEnd : "",
      disabledCategories: Array.isArray(partial.notificationPrefs.disabledCategories)
        ? partial.notificationPrefs.disabledCategories.filter((c) => typeof c === "string")
        : [],
    };
  }
  applyEngineSettings(clean);
  if (Object.keys(clean).length) saveSettings(clean);
  return { ...manager.getSettings(), completionAction, clipboardMonitor, nativeNotifications, firstRunDone, notificationPrefs };
});
ipcMain.handle("dm:choose-folder", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose downloads folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("dm:open-downloads-folder", async () => {
  const dir = manager.getSettings().downloadsDir;
  const error = await shell.openPath(dir);
  return error || null;
});
ipcMain.handle("dm:open-file", async (_event, id) => {
  const job = manager.get(id);
  if (!job || !existsSync(job.destination)) return false;
  const error = await shell.openPath(job.destination);
  return !error;
});
ipcMain.handle("dm:open-job-folder", async (_event, id) => {
  const job = manager.get(id);
  if (!job) return false;
  if (existsSync(job.destination)) {
    shell.showItemInFolder(job.destination);
    return true;
  }
  const error = await shell.openPath(dirname(job.destination));
  return !error;
});
// --- YouTube (yt-dlp) -------------------------------------------------
ipcMain.handle("dm:yt-tools", async () => resolveTools());
ipcMain.handle("dm:yt-info", async (_event, url) => {
  const tools = await resolveTools();
  if (!tools.ytDlp) throw new Error("yt-dlp is not installed. Press “Download yt-dlp” in the YouTube card first.");
  return fetchYoutubeInfo(tools.ytDlp, url);
});
ipcMain.handle("dm:yt-add", async (_event, url, opts) => {
  return manager.addYoutube(url, opts ?? { options: { kind: "video" } });
});

// Download a file over HTTPS, following up to 5 redirects.
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const attempt = (current, redirectsLeft) => {
      httpsGet(current, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          res.resume();
          attempt(new URL(res.headers.location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (error) => {
          rmSync(dest, { force: true });
          reject(error);
        });
      }).on("error", reject);
    };
    attempt(url, 5);
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

ipcMain.handle("dm:yt-install-tool", async (_event, tool) => {
  if (process.platform !== "win32") {
    return { ok: false, error: "Automatic tool download is Windows-only. Install yt-dlp / ffmpeg with your system package manager." };
  }
  const binDir = join(app.getPath("userData"), "bin");
  mkdirSync(binDir, { recursive: true });
  try {
    if (tool === "ytdlp") {
      const dest = join(binDir, "yt-dlp.exe");
      await downloadFile("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", dest);
    } else if (tool === "ffmpeg") {
      const tmpDir = app.getPath("temp");
      const zip = join(tmpDir, "ffmpeg-essentials.zip");
      const extractDir = join(tmpDir, "ffmpeg-extract");
      rmSync(extractDir, { recursive: true, force: true });
      await downloadFile("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", zip);
      await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive", "-Path", zip, "-DestinationPath", extractDir, "-Force"]);
      const subdirs = readdirSync(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      let found = null;
      for (const subdir of subdirs) {
        const candidate = join(extractDir, subdir.name, "bin", "ffmpeg.exe");
        if (existsSync(candidate)) { found = candidate; break; }
      }
      if (!found) throw new Error("ffmpeg.exe was not found inside the downloaded package.");
      try {
        renameSync(found, join(binDir, "ffmpeg.exe"));
      } catch {
        writeFileSync(join(binDir, "ffmpeg.exe"), readFileSync(found));
      }
      rmSync(zip, { force: true });
      rmSync(extractDir, { recursive: true, force: true });
    } else {
      return { ok: false, error: `Unknown tool: ${tool}` };
    }
    return { ok: true, tools: await resolveTools() };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle("dm:disk-space", async () => {
  try {
    let dir = manager.getSettings().downloadsDir;
    while (dir && !existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const stats = statfsSync(dir);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
});
// 0.7.0: mini widget toggle, torrent stop-seeding, download stats.
ipcMain.handle("dm:toggle-widget", async () => {
  toggleWidgetWindow();
  return widgetWindow !== null;
});
ipcMain.handle("dm:stop-seeding", async (_event, id) => manager.stopSeeding(id));
ipcMain.handle("dm:stats", async () => manager.getStats());
ipcMain.handle("dm:open-details", async (_event, id) => {
  openDetails(id);
  return true;
});
ipcMain.handle("dm:import-urls", async () => {
  // 0.8.0: read a .txt file (one URL per line) and add every kept link.
  // YouTube links go through yt-dlp as Video/best — a plain HTTP fetch
  // of a watch page would just save the page as a file. A failed add
  // counts as failed, never crashes the handler.
  if (!mainWindow || mainWindow.isDestroyed()) return { added: 0, skipped: 0, failed: 0 };
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Import URLs from text file",
    properties: ["openFile"],
    filters: [
      { name: "Text files", extensions: ["txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (picked.canceled || !picked.filePaths[0]) return { added: 0, skipped: 0, failed: 0 };
  let text;
  try {
    text = readFileSync(picked.filePaths[0], "utf8");
  } catch {
    return { added: 0, skipped: 0, failed: 1 };
  }
  const { urls, skipped } = parseImportUrls(text);
  let added = 0;
  let failed = 0;
  for (const url of urls) {
    try {
      if (isYoutubeImportUrl(url)) {
        await manager.addYoutube(url, { options: { kind: "video", quality: "best" } });
      } else {
        await manager.add(url);
      }
      added++;
    } catch {
      failed++;
    }
  }
  return { added, skipped, failed };
});
ipcMain.handle("dm:export-csv", async () => {
  // 0.8.0: write the current job list + a stats summary as CSV.
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: "Export downloads to CSV",
    defaultPath: "shahjahan-downloads.csv",
    filters: [{ name: "CSV files", extensions: ["csv"] }],
  });
  if (picked.canceled || !picked.filePath) return false;
  try {
    writeFileSync(picked.filePath, jobsToCsv(manager.list()), "utf8");
    return true;
  } catch {
    return false;
  }
});
// 0.8.0: delete a completed job AND its file (list-only delete stays
// on dm:cancel). Queue start/stop = pause/resume that queue's jobs.
ipcMain.handle("dm:delete-with-file", async (_event, id) => manager.deleteWithFile(id));
ipcMain.handle("dm:pause-queue", async (_event, queueId) => manager.pauseQueue(queueId));
ipcMain.handle("dm:resume-queue", async (_event, queueId) => manager.resumeQueue(queueId));

async function checkUpdatesOnce() {
  // User-confirmed only: never downloads or installs automatically.
  // Set DM_UPDATE_URL to a JSON feed {version, url} to enable this.
  try {
    const result = await checkForUpdates(app.getVersion());
    if (result.available && result.url && mainWindow && !mainWindow.isDestroyed()) {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Update available",
        message: `Shahjahan Download Manager ${result.latestVersion} is available (you have ${result.currentVersion}).`,
        detail: `Click Download to open the installer in your browser.\n${result.url}`,
        buttons: ["Download", "Later"],
        defaultId: 0,
      });
      if (answer.response === 0) await shell.openExternal(result.url);
    } else if (result.error) {
      console.log("Update check failed:", result.error);
    }
  } catch (error) {
    console.log("Update check failed:", error?.message ?? error);
  }
}

// 0.7.0 Explorer context menu ("Download with Shahjahan Download
// Manager", registered by the NSIS installer for .torrent files):
// Windows launches the app with the clicked file as argv. A second
// launch forwards its argv to the running app instead of opening a
// second window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    void handleLaunchArgs(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/** Handle a file path or URL passed on the command line. */
async function handleLaunchArgs(argv) {
  const candidate = (argv ?? [])
    .slice(1)
    .find((arg) => !arg.startsWith("--") && arg !== "." && !arg.toLowerCase().endsWith(".exe"));
  if (!candidate) return;
  try {
    if (/^https?:\/\//i.test(candidate)) {
      if (candidate.toLowerCase().endsWith(".torrent")) await manager.addTorrent(candidate);
      else await manager.add(candidate);
    } else if (candidate.toLowerCase().endsWith(".torrent") && existsSync(candidate)) {
      await manager.addTorrent(candidate);
    }
  } catch (error) {
    console.error("Launch arg failed:", error?.message ?? error);
  }
}

// Queue restore runs after the window opens (0.7.7 startup): it used to
// block first paint on disk I/O. This promise lets the quit path wait
// for it, so a fast quit can never flush a half-restored queue.
let queueRestored = null;

app.whenReady().then(async () => {
  // Apply persisted engine settings before the window opens, so the
  // first download already uses the user's folder and concurrency.
  applyEngineSettings(loadSettings());
  // Window first: queue restore is disk I/O and used to block first
  // paint. Restored jobs come back paused, so nothing downloads while
  // restore runs, and restore notifies listeners (onJobsChanged) when
  // it finishes, so the list fills in on its own.
  createMainWindow();
  queueRestored = manager.restoreQueue().catch(() => undefined);
  createTray();
  startClipboardMonitor();
  await startBridge();
  // Check once at startup, not on a timer: no background polling.
  void checkUpdatesOnce();
  console.log("Shahjahan Download Manager window ready");
  if (SMOKE) {
    // Smoke test only: prove the window opens, then exit cleanly.
    setTimeout(() => app.quit(), 2500);
  }
  // 0.7.0: context-menu / second-launch file or URL (see below).
  void handleLaunchArgs(process.argv);
  // 0.7.0 background ticks (30 s): scheduler windows, seeding caps,
  // and smart-limit process detection. Cheap: one tasklist call on
  // Windows only, and only while the smart limit is enabled.
  setInterval(() => {
    try {
      manager.applySchedulerTick();
    } catch { /* scheduler must never break the UI */ }
    manager.checkSeeding().catch(() => undefined);
    const smart = manager.getSettings().smartConfig;
    if (smart.enabled && process.platform === "win32") {
      execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true }, (_error, stdout) => {
        try {
          const names = String(stdout || "")
            .split("\n")
            .map((line) => line.split(",")[0]?.replace(/"/g, "").trim())
            .filter(Boolean);
          const watchlist = smart.watchlist.map((w) => w.toLowerCase());
          const hit = names.some((name) =>
            watchlist.some((w) => name.toLowerCase() === w || name.toLowerCase().includes(w)),
          );
          manager.setSmartActive(hit);
        } catch { /* ignore parse failures */ }
      });
    } else {
      manager.setSmartActive(false);
    }
  }, 30_000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Electron does not await async before-quit handlers, so flush the
// queue explicitly: otherwise fire-and-forget saves could be lost
// when the user quits right after a queue change.
let quittingAfterFlush = false;
app.on("before-quit", (event) => {
  if (quittingAfterFlush) return;
  event.preventDefault();
  (async () => {
    // Never flush a half-restored queue: if restore is still running,
    // wait for it first (it is read-only and fast).
    if (queueRestored) await queueRestored.catch(() => undefined);
    try {
      await manager.saveQueue();
    } catch {
      // Quitting must not hang on a failed queue write.
    }
    await stopBridge();
    quittingAfterFlush = true;
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Keep the main window list fresh when a dialog or another window asks.
setInterval(broadcastJobs, 5000);
