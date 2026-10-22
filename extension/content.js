// Download Manager — ISOLATED content script.
// Draws the floating "Download this video" overlay over <video> elements
// and forwards quality choices to the background service worker, which
// sends them to the desktop app via Native Messaging.
// The overlay lives in a Shadow DOM so page CSS cannot restyle or break it.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const MIN_WIDTH = 160;
  const MIN_HEIGHT = 90;

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

  let overlayEnabled = true;
  let globalStreams = []; // {url, kind, variants} from the MAIN world script
  const overlays = new Map(); // video element -> {host, shadow, button, menu, update}

  extAsync((cb) => ext.storage.local.get(["videoOverlay"], cb))
    .then((stored) => {
      overlayEnabled = stored.videoOverlay !== false;
      if (!overlayEnabled) removeAllOverlays();
    })
    .catch(() => {});

  if (ext.storage && ext.storage.onChanged) {
    ext.storage.onChanged.addListener((changes) => {
      if (changes.videoOverlay) {
        overlayEnabled = changes.videoOverlay.newValue !== false;
        if (overlayEnabled) scan();
        else removeAllOverlays();
      }
    });
  }

  // Streams reported by the MAIN world injected script.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "dm-injected" || data.type !== "dm-stream") return;
    const existing = globalStreams.find((s) => s.url === data.url);
    if (!existing) {
      globalStreams.push({ url: data.url, kind: data.kind, variants: data.variants || null });
    } else if (data.variants) {
      existing.variants = data.variants;
    }
    scan();
  });

  function videoSources(video) {
    const urls = [];
    const push = (url) => {
      if (url && typeof url === "string" && !url.startsWith("blob:") && !urls.includes(url)) urls.push(url);
    };
    if (video.src) push(video.src);
    if (video.currentSrc) push(video.currentSrc);
    video.querySelectorAll("source").forEach((source) => {
      if (source.src) push(source.src);
    });
    return urls;
  }

  function candidatesFor(video) {
    const own = videoSources(video);
    // If the video is MSE-driven (blob: src) or has no direct source,
    // the page-level streams found by the injected script are its streams.
    if (own.length === 0 || video.src.startsWith("blob:")) {
      return globalStreams.map((s) => ({ url: s.url, kind: s.kind, variants: s.variants }));
    }
    // Otherwise merge: own sources first, then any stream not already listed.
    const merged = own.map((url) => {
      const found = globalStreams.find((s) => s.url === url);
      return { url, kind: found ? found.kind : "progressive", variants: found ? found.variants : null };
    });
    for (const stream of globalStreams) {
      if (!merged.some((m) => m.url === stream.url)) {
        // Only add page streams that are not already a different video's
        // direct source — conservative: skip extras here, they appear
        // on the MSE/blank video that owns them.
      }
    }
    return merged;
  }

  function variantLabel(variant) {
    return variant.label || variant.url.split("/").pop() || variant.url;
  }

  function showToast(message, isError) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:2147483647;background:${isError ? "#b00020" : "#1a1a1a"};color:#fff;padding:10px 14px;border-radius:6px;font:13px system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.3);`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function downloadUrl(url, filename) {
    extAsync((cb) => ext.runtime.sendMessage({ type: "dm_video_download", url, filename }, cb))
      .then((response) => {
        if (response && response.ok) showToast("Sent to Download Manager");
        else showToast(`Download Manager: ${response && response.error ? response.error : "failed"}`, true);
      })
      .catch((e) => showToast(`Download Manager: ${e.message}`, true));
  }

  function filenameFor(url, video) {
    const title = (document.title || "video").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "video";
    const ext = url.split(/[?#]/)[0].split(".").pop();
    if (ext && ["mp4", "webm", "mov", "mkv"].includes(ext.toLowerCase())) return `${title}.${ext.toLowerCase()}`;
    if (url.includes(".m3u8")) return `${title}.m3u8`;
    if (url.includes(".mpd")) return `${title}.mpd`;
    return title;
  }

  function createOverlay(video) {
    const host = document.createElement("div");
    host.className = "dm-overlay-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .dm-wrap { position: fixed; z-index: 2147483647; font-family: system-ui, sans-serif; }
      .dm-btn { background: #1a1a1a; color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-size: 13px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.35); white-space: nowrap; }
      .dm-btn:hover { background: #2e7d32; }
      .dm-menu { display: none; margin-top: 6px; background: #fff; color: #1a1a1a; border-radius: 6px; box-shadow: 0 4px 20px rgba(0,0,0,.35); max-height: 280px; overflow: auto; min-width: 260px; }
      .dm-menu.open { display: block; }
      .dm-item { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-bottom: 1px solid #eee; font-size: 13px; }
      .dm-item button { background: #2e7d32; color: #fff; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
      .dm-note { padding: 8px 10px; font-size: 12px; color: #555; }
    `;
    const wrap = document.createElement("div");
    wrap.className = "dm-wrap";
    const button = document.createElement("button");
    button.className = "dm-btn";
    button.textContent = "Download this video";
    const menu = document.createElement("div");
    menu.className = "dm-menu";
    wrap.appendChild(button);
    wrap.appendChild(menu);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.body.appendChild(host);

    const info = { host, shadow, button, menu, wrap, video, update: null };
    overlays.set(video, info);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const candidates = candidatesFor(video);
      if (candidates.length === 0) return;
      // Single progressive source: download immediately, no menu.
      if (candidates.length === 1 && !candidates[0].variants) {
        downloadUrl(candidates[0].url, filenameFor(candidates[0].url, video));
        return;
      }
      if (menu.classList.contains("open")) {
        menu.classList.remove("open");
        return;
      }
      renderMenu(info, candidates);
      menu.classList.add("open");
    });

    info.update = () => {
      const rect = video.getBoundingClientRect();
      const visible = rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      wrap.style.display = visible ? "block" : "none";
      if (!visible) return;
      wrap.style.left = `${Math.max(8, rect.left + 8)}px`;
      wrap.style.top = `${Math.max(8, rect.top + 8)}px`;
    };
    info.update();
    return info;
  }

  function renderMenu(info, candidates) {
    const { menu, video } = info;
    menu.innerHTML = "";
    let hasStreamNote = false;
    for (const candidate of candidates) {
      if (candidate.variants && candidate.variants.length) {
        for (const variant of candidate.variants) {
          const row = document.createElement("div");
          row.className = "dm-item";
          const label = document.createElement("span");
          label.textContent = `${variantLabel(variant)} (${candidate.kind.toUpperCase()})`;
          const btn = document.createElement("button");
          btn.textContent = "Download";
          btn.addEventListener("click", () => {
            menu.classList.remove("open");
            downloadUrl(variant.url, filenameFor(variant.url, video));
          });
          row.appendChild(label);
          row.appendChild(btn);
          menu.appendChild(row);
        }
        if (candidate.kind === "hls" || candidate.kind === "dash") hasStreamNote = true;
      } else {
        const row = document.createElement("div");
        row.className = "dm-item";
        const label = document.createElement("span");
        label.textContent = candidate.url.split("/").pop() || candidate.url;
        const btn = document.createElement("button");
        btn.textContent = "Download";
        btn.addEventListener("click", () => {
          menu.classList.remove("open");
          downloadUrl(candidate.url, filenameFor(candidate.url, video));
        });
        row.appendChild(label);
        row.appendChild(btn);
        menu.appendChild(row);
      }
    }
    if (hasStreamNote) {
      const note = document.createElement("div");
      note.className = "dm-note";
      note.textContent = "HLS/DASH: segments are assembled by the desktop app. TS to MP4 remux and DASH video+audio mux need ffmpeg; without it you get a .ts file or separate video/audio files.";
      menu.appendChild(note);
    }
  }

  function removeAllOverlays() {
    for (const info of overlays.values()) info.host.remove();
    overlays.clear();
  }

  function scan() {
    if (!overlayEnabled) return;
    const videos = document.querySelectorAll("video");
    const live = new Set(videos);
    for (const [video, info] of overlays.entries()) {
      if (!live.has(video) || !document.contains(video)) {
        info.host.remove();
        overlays.delete(video);
      }
    }
    videos.forEach((video) => {
      const candidates = candidatesFor(video);
      if (candidates.length === 0) {
        const existing = overlays.get(video);
        if (existing) {
          existing.host.remove();
          overlays.delete(video);
        }
        return;
      }
      let info = overlays.get(video);
      if (!info) info = createOverlay(video);
      info.update();
    });
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", () => {
    for (const info of overlays.values()) info.update();
  }, true);
  window.addEventListener("resize", () => {
    for (const info of overlays.values()) info.update();
  });
  scan();
  setInterval(scan, 3000);

  // Popup asks for the videos on this page, or for every downloadable
  // link on it (site grabber): anchors, images and media sources,
  // resolved to absolute URLs, deduped and classified by extension.
  function kindFor(url) {
    const ext = url.split(/[?#]/)[0].split(".").pop().toLowerCase();
    if (["mp4", "mkv", "webm", "mov", "avi", "flv", "mp3", "wav", "flac", "ogg"].includes(ext)) return "media";
    if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "image";
    if (["pdf", "doc", "docx", "txt", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "document";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
    return "other";
  }
  function grabLinks() {
    const seen = new Set();
    const links = [];
    const push = (raw) => {
      if (!raw || typeof raw !== "string") return;
      if (raw.startsWith("blob:") || raw.startsWith("data:") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) return;
      let absolute;
      try {
        absolute = new URL(raw, location.href).toString();
      } catch {
        return;
      }
      if (!absolute.startsWith("http://") && !absolute.startsWith("https://")) return;
      if (seen.has(absolute)) return;
      seen.add(absolute);
      if (!/\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(absolute)) return;
      let filename = absolute;
      try {
        filename = decodeURIComponent(new URL(absolute).pathname.split("/").pop()) || absolute;
      } catch {}
      links.push({ url: absolute, filename, kind: kindFor(absolute) });
    };
    document.querySelectorAll("a[href]").forEach((a) => push(a.getAttribute("href")));
    document.querySelectorAll("img[src]").forEach((img) => push(img.getAttribute("src")));
    document.querySelectorAll("video[src], audio[src]").forEach((m) => push(m.getAttribute("src")));
    document.querySelectorAll("video source[src], audio source[src]").forEach((s) => push(s.getAttribute("src")));
    return links;
  }

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "dm_grab_links") {
      sendResponse({ ok: true, links: grabLinks() });
      return false;
    }
    if (message && message.type === "dm_list_videos") {
      const videos = [];
      document.querySelectorAll("video").forEach((video) => {
        const candidates = candidatesFor(video);
        if (candidates.length) {
          videos.push({
            title: document.title || "",
            candidates: candidates.map((c) => ({
              url: c.url,
              kind: c.kind,
              variants: c.variants || null,
            })),
          });
        }
      });
      sendResponse({ ok: true, videos });
    }
    return false;
  });
})();
