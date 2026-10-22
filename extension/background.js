// Download Manager — Manifest V3 background service worker.
// Chrome/Edge first, Firefox second: `ext` picks browser.* when present,
// and extAsync handles both callback-style (chrome) and promise-style
// (Firefox browser.*) APIs.
const ext = typeof browser !== "undefined" ? browser : chrome;
const HOST_NAME = "com.downloadmanager.bridge";
const HOST_TIMEOUT_MS = 15000;

function extAsync(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      const result = fn(...args, (value) => {
        const err = ext.runtime && ext.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(value);
      });
      if (result && typeof result.then === "function") {
        result.then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function getSettings() {
  try {
    const stored = await extAsync((cb) => ext.storage.local.get(["interceptDownloads", "videoOverlay"], cb));
    return {
      interceptDownloads: stored.interceptDownloads !== false,
      videoOverlay: stored.videoOverlay !== false,
    };
  } catch {
    return { interceptDownloads: true, videoOverlay: true };
  }
}

// One-shot Native Messaging call: open a port, post, wait for the first
// response, disconnect. Service workers go idle, so a long-lived port
// is unreliable — per-request ports are the robust pattern here.
function sendToHost(message) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { port && port.disconnect(); } catch {}
        reject(new Error("Native host timed out"));
      }
    }, HOST_TIMEOUT_MS);
    try {
      port = ext.runtime.connectNative(HOST_NAME);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    port.onMessage.addListener((response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
      resolve(response);
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = ext.runtime && ext.runtime.lastError;
      reject(new Error(err ? err.message : "Native host disconnected"));
    });
    port.postMessage(message);
  });
}

async function hostStatus() {
  try {
    const response = await sendToHost({ type: "ping" });
    return { connected: response && response.ok === true, error: response && response.ok ? null : "Host replied with an error" };
  } catch (e) {
    return { connected: false, error: e && e.message ? e.message : String(e) };
  }
}

async function forwardDownload({ url, filename, referrer }) {
  const headers = {};
  // Forward cookies for the download URL so authenticated downloads work.
  // Cookies permission + host permissions are required for this call.
  try {
    const cookies = await extAsync((cb) => ext.cookies.getAll({ url }, cb));
    if (cookies && cookies.length) {
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch {
    // No cookies: the download proceeds unauthenticated.
  }
  if (referrer) headers.Referer = referrer;
  // Only the URL path's extension counts: a query string mentioning
  // .m3u8/.mpd (e.g. ?format=mpd) must not route to the stream assembler.
  let isStream = false;
  try {
    const pathname = new URL(url).pathname;
    isStream = pathname.endsWith(".m3u8") || pathname.endsWith(".mpd");
  } catch {
    isStream = url.includes(".m3u8") || url.includes(".mpd");
  }
  const response = await sendToHost({
    type: "add_download",
    url,
    ...(filename ? { filename } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(isStream ? { stream: true } : {}),
  });
  if (!response || response.ok !== true) {
    throw new Error(response && response.error ? response.error : "Desktop app did not accept the download");
  }
  return response;
}

function notify(title, message) {
  try {
    ext.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title,
      message,
    });
  } catch {}
}

// --- Download interception -------------------------------------------------
// Ping first: if the desktop app/host is absent, do NOT cancel the browser
// download — let it proceed normally and tell the user instead. Cancelling
// first and then failing would lose the download entirely.
ext.downloads.onCreated.addListener(async (item) => {
  try {
    const settings = await getSettings();
    if (!settings.interceptDownloads) return;
    if (!item || !item.url) return;
    if (item.url.startsWith("blob:") || item.url.startsWith("data:") || item.url.startsWith("chrome:") || item.url.startsWith("about:")) {
      // Blob/data URLs are page-local: the desktop app cannot fetch them.
      return;
    }
    if (item.state === "complete") return;
    const status = await hostStatus();
    if (!status.connected) {
      notify("Download Manager not connected", "Open the Download Manager desktop app, then try the download again. The browser download was left alone.");
      return;
    }
    const filename = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
    await extAsync((cb) => ext.downloads.cancel(item.id, cb));
    await forwardDownload({ url: item.url, filename, referrer: item.referrer || undefined });
  } catch (e) {
    // Interception failed after cancel: the user still needs the file.
    // There is no way to un-cancel a browser download, so surface it loudly.
    notify("Download Manager", `Could not forward download: ${e && e.message ? e.message : String(e)}`);
  }
});

// --- Context menus ----------------------------------------------------------
function setupContextMenus() {
  try {
    ext.contextMenus.removeAll(() => {
      const contexts = ["link", "video", "audio", "image"];
      ext.contextMenus.create({
        id: "dm-download",
        title: "Download with Download Manager",
        contexts,
      });
    });
  } catch {}
}

ext.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});
ext.runtime.onStartup.addListener(() => {
  setupContextMenus();
});

ext.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "dm-download") return;
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  try {
    await forwardDownload({ url });
  } catch (e) {
    notify("Download Manager", `Could not forward download: ${e && e.message ? e.message : String(e)}`);
  }
});

// --- Messages from content scripts and popup --------------------------------
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || typeof message.type !== "string") {
        sendResponse({ ok: false, error: "Unknown message" });
        return;
      }
      if (message.type === "dm_get_status") {
        const status = await hostStatus();
        sendResponse({ ok: true, ...status });
        return;
      }
      if (message.type === "dm_get_settings") {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      if (message.type === "dm_set_settings") {
        await extAsync((cb) => ext.storage.local.set(message.settings || {}, cb));
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      if (message.type === "dm_list") {
        const response = await sendToHost({ type: "list" });
        sendResponse(response);
        return;
      }
      if (message.type === "dm_video_download" || message.type === "dm_download") {
        const response = await forwardDownload({
          url: message.url,
          filename: message.filename,
          referrer: sender && sender.tab ? sender.tab.url : undefined,
        });
        sendResponse({ ok: true, response });
        return;
      }
      if (message.type === "dm_pause" || message.type === "dm_resume" || message.type === "dm_cancel") {
        const action = message.type.replace("dm_", "");
        const response = await sendToHost({ type: action, id: message.id });
        sendResponse(response);
        return;
      }
      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true;
});
