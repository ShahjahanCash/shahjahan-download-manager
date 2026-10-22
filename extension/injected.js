// Download Manager — MAIN world script.
// Runs in the page's own JavaScript world so it can see what the page
// sees: fetch/XHR responses, MediaSource-driven players, and video
// elements. It never modifies page behaviour: original functions are
// preserved, responses are cloned before reading, and every hook is
// wrapped in try/catch so a failure here cannot break the page.
// Findings are posted to the ISOLATED content script via window.postMessage.
(function () {
  if (typeof window === "undefined") return;
  const parsers = window.DMParsers || globalThis.DMParsers;
  if (!parsers) return;

  const seen = new Set();

  function post(url, kind, variants) {
    if (!url || typeof url !== "string") return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    const key = `${kind}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      window.postMessage(
        { source: "dm-injected", type: "dm-stream", url, kind, variants: variants || null },
        "*",
      );
    } catch {}
  }

  function maybeParseManifest(url, text) {
    try {
      if (url.includes(".m3u8")) {
        const variants = parsers.parseM3U8Master(text, url);
        post(url, "hls", variants.length ? variants : null);
      } else if (url.includes(".mpd")) {
        const variants = parsers.parseMpdVariants(text, url);
        post(url, "dash", variants.length ? variants : null);
      }
    } catch {}
  }

  function isMediaUrl(url) {
    return (
      url.includes(".m3u8") ||
      url.includes(".mpd") ||
      parsers.isStreamUrl(url) === "progressive"
    );
  }

  // --- fetch hook -----------------------------------------------------------
  try {
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      const promise = originalFetch.apply(this, args);
      if (url && isMediaUrl(url)) {
        promise
          .then((response) => {
            try {
              const clone = response.clone();
              clone.text().then((text) => maybeParseManifest(url, text)).catch(() => {});
              if (parsers.isStreamUrl(url) === "progressive") post(url, "progressive", null);
            } catch {}
            return response;
          })
          .catch(() => {});
      }
      return promise;
    };
  } catch {}

  // --- XHR hook -------------------------------------------------------------
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dmUrl = typeof url === "string" ? url : "";
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = xhr.__dmUrl || "";
      if (url && isMediaUrl(url)) {
        xhr.addEventListener("load", () => {
          try {
            if (typeof xhr.responseText === "string" && xhr.responseText) {
              maybeParseManifest(url, xhr.responseText);
            }
            if (parsers.isStreamUrl(url) === "progressive") post(url, "progressive", null);
          } catch {}
        });
      }
      return originalSend.apply(this, arguments);
    };
  } catch {}

  // --- Performance entries + video elements --------------------------------
  function scanPerformance() {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (const entry of entries) {
        if (entry && entry.name && isMediaUrl(entry.name)) {
          const kind = entry.name.includes(".m3u8") ? "hls" : entry.name.includes(".mpd") ? "dash" : "progressive";
          post(entry.name, kind, null);
        }
      }
    } catch {}
  }

  function scanVideos() {
    try {
      const videos = document.querySelectorAll("video");
      videos.forEach((video) => {
        const sources = [];
        if (video.src) sources.push(video.src);
        if (video.currentSrc) sources.push(video.currentSrc);
        video.querySelectorAll("source").forEach((source) => {
          if (source.src) sources.push(source.src);
        });
        sources.forEach((src) => {
          const kind = src.includes(".m3u8") ? "hls" : src.includes(".mpd") ? "dash" : parsers.isStreamUrl(src) === "progressive" ? "progressive" : null;
          if (kind) post(src, kind, null);
        });
      });
    } catch {}
  }

  scanPerformance();
  scanVideos();
  setInterval(() => {
    scanPerformance();
    scanVideos();
  }, 3000);

  try {
    const observer = new MutationObserver(() => scanVideos());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();
