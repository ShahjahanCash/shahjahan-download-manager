(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  function extAsync(fn, ...args) {
    return new Promise((resolve, reject) => {
      try {
        const result = fn(...args, (value) => {
          const err = ext.runtime && ext.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(value);
        });
        if (result && typeof result.then === "function") result.then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  const statusEl = document.getElementById("status");
  const interceptEl = document.getElementById("intercept");
  const overlayEl = document.getElementById("overlay");
  const videosEl = document.getElementById("videos");

  function setStatus(connected, error) {
    statusEl.className = `status ${connected ? "ok" : "bad"}`;
    statusEl.textContent = connected
      ? "Connected to the Download Manager desktop app."
      : `Not connected: ${error || "desktop app not running"}. Downloads will be left to the browser until it is open.`;
  }

  async function refresh() {
    try {
      const status = await extAsync((cb) => ext.runtime.sendMessage({ type: "dm_get_status" }, cb));
      setStatus(status && status.connected, status && status.error);
    } catch (e) {
      setStatus(false, e.message);
    }
    try {
      const settings = await extAsync((cb) => ext.runtime.sendMessage({ type: "dm_get_settings" }, cb));
      if (settings && settings.settings) {
        interceptEl.checked = settings.settings.interceptDownloads !== false;
        overlayEl.checked = settings.settings.videoOverlay !== false;
      }
    } catch {}
    try {
      const tabs = await extAsync((cb) => ext.tabs.query({ active: true, currentWindow: true }, cb));
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      const response = await extAsync((cb) => ext.tabs.sendMessage(tab.id, { type: "dm_list_videos" }, cb));
      if (!response || !response.videos || !response.videos.length) return;
      videosEl.innerHTML = "";
      response.videos.forEach((video, vi) => {
        const div = document.createElement("div");
        div.className = "video";
        const title = document.createElement("div");
        title.textContent = video.title || `Video ${vi + 1}`;
        div.appendChild(title);
        video.candidates.forEach((candidate) => {
          if (candidate.variants && candidate.variants.length) {
            candidate.variants.forEach((variant) => {
              const btn = document.createElement("button");
              btn.textContent = `Download ${variant.label || ""} (${candidate.kind})`;
              btn.addEventListener("click", () => {
                extAsync((cb) => ext.runtime.sendMessage({ type: "dm_video_download", url: variant.url }, cb)).catch(() => {});
              });
              div.appendChild(btn);
            });
          } else {
            const btn = document.createElement("button");
            btn.textContent = `Download (${candidate.kind})`;
            btn.addEventListener("click", () => {
              extAsync((cb) => ext.runtime.sendMessage({ type: "dm_video_download", url: candidate.url }, cb)).catch(() => {});
            });
            div.appendChild(btn);
          }
        });
        videosEl.appendChild(div);
      });
    } catch {
      // Content script may not be injected on this page (e.g. chrome://).
    }
  }

  // Site grabber: list the page's links, tick, and send the selection
  // to the desktop app one by one through the background worker.
  const grabBtn = document.getElementById("grab-btn");
  const grabListEl = document.getElementById("grab-list");
  const grabSendBtn = document.getElementById("grab-send");
  const grabStatusEl = document.getElementById("grab-status");
  let grabbed = [];
  grabBtn.addEventListener("click", async () => {
    grabStatusEl.textContent = "Collecting links…";
    try {
      const tabs = await extAsync((cb) => ext.tabs.query({ active: true, currentWindow: true }, cb));
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) throw new Error("No active tab");
      const response = await extAsync((cb) => ext.tabs.sendMessage(tab.id, { type: "dm_grab_links" }, cb));
      grabbed = (response && response.links) || [];
      grabStatusEl.textContent = grabbed.length ? `${grabbed.length} links found. Tick the ones you want.` : "No downloadable links found on this page.";
      grabListEl.innerHTML = "";
      grabbed.forEach((link) => {
        const row = document.createElement("label");
        row.className = "grab-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = true;
        box.dataset.url = link.url;
        const kind = document.createElement("span");
        kind.className = "grab-kind";
        kind.textContent = link.kind;
        const name = document.createElement("span");
        name.className = "grab-name";
        name.textContent = link.filename;
        name.title = link.url;
        row.appendChild(box);
        row.appendChild(kind);
        row.appendChild(name);
        grabListEl.appendChild(row);
      });
      grabSendBtn.style.display = grabbed.length ? "" : "none";
    } catch (e) {
      grabStatusEl.textContent = `Could not grab links: ${e.message}`;
    }
  });
  grabSendBtn.addEventListener("click", async () => {
    const selected = [...grabListEl.querySelectorAll("input[type='checkbox']:checked")].map((box) => box.dataset.url);
    if (!selected.length) {
      grabStatusEl.textContent = "Tick at least one link first.";
      return;
    }
    grabStatusEl.textContent = `Sending ${selected.length} downloads…`;
    let sent = 0;
    for (const url of selected) {
      try {
        await extAsync((cb) => ext.runtime.sendMessage({ type: "dm_download", url }, cb));
        sent++;
      } catch {}
    }
    grabStatusEl.textContent = `${sent} of ${selected.length} downloads sent to the desktop app.`;
  });

  function saveSettings() {
    extAsync((cb) => ext.runtime.sendMessage({
      type: "dm_set_settings",
      settings: { interceptDownloads: interceptEl.checked, videoOverlay: overlayEl.checked },
    }, cb)).catch(() => {});
  }

  interceptEl.addEventListener("change", saveSettings);
  overlayEl.addEventListener("change", saveSettings);
  document.addEventListener("DOMContentLoaded", refresh);
  refresh();
})();
