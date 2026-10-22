const jobsEl = document.getElementById("jobs");
const emptyEl = document.getElementById("empty");
const urlEl = document.getElementById("url");
const segmentsEl = document.getElementById("segments");
const limitEl = document.getElementById("limit");
const categoryEl = document.getElementById("category");
const errorEl = document.getElementById("form-error");
const searchEl = document.getElementById("search");
const listTitleEl = document.getElementById("list-title");
const listCountEl = document.getElementById("list-count");
/* ---- Settings: appearance + display live in localStorage (both
   windows share this origin, so the details dialog matches); the
   engine settings (folder, max concurrent) live in main and are
   fetched/saved over IPC. Old single toggle (dm-theme) migrates in. */
const SETTINGS_KEY = "sdm-settings";
const DEFAULT_SETTINGS = {
  // Figma style is the default now: dark theme, purple-to-teal gradient.
  theme: "dark", accent: "figma", density: "comfortable",
  fontSize: "default",
  defaultSegments: 0, defaultLimit: 0,
  showChunks: true, showPath: false, completionToast: true,
  reduceEffects: false,
};
let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  if (saved && typeof saved === "object") settings = { ...DEFAULT_SETTINGS, ...saved };
  else if (localStorage.getItem("dm-theme")) {
    settings.theme = localStorage.getItem("dm-theme") === "dark" ? "dark" : "light";
  }
} catch { /* corrupted settings: fall back to defaults */ }
/* ---- 0.7.4 overhaul migration: existing installs see the new look
   once; every other preference is preserved. The marker lives in its
   own localStorage key so Reset-to-defaults never re-triggers it. */
const OMNI_MIGRATION_KEY = "sdm-omni-migrated";
try {
  if (!localStorage.getItem(OMNI_MIGRATION_KEY)) {
    settings.theme = "omni";
    saveSettings();
    localStorage.setItem(OMNI_MIGRATION_KEY, "1");
  }
} catch { /* storage unavailable: the in-memory theme above still applies for this run */ }
let engineSettings = { downloadsDir: "", maxConcurrent: 3 };

function resolvedTheme() {
  if (settings.theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return settings.theme;
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function applySettings() {
  document.documentElement.dataset.theme = resolvedTheme();
  document.documentElement.dataset.accent = settings.accent;
  document.documentElement.dataset.density = settings.density;
  document.documentElement.dataset.fontSize = settings.fontSize || "default";
  document.documentElement.dataset.reduceEffects = settings.reduceEffects ? "true" : "false";
  document.body.classList.toggle("hide-chunks", !settings.showChunks);
  document.body.classList.toggle("hide-path", !settings.showPath);
  // B7 fix: the New Task form fields used to be reset here on EVERY
  // settings change, so toggling theme/accent wiped a segments or
  // speed-limit choice the user had just made in an open form.
  // Form defaults are applied once at startup (applyFormDefaults)
  // and when the defaults themselves change, never on theme changes.
  const foot = document.getElementById("foot-note");
  if (foot) foot.innerHTML = `Max concurrent: ${engineSettings.maxConcurrent}<br />Segments download in parallel and resume from where they stopped.`;
  // Segmented + swatch active states in the modal.
  document.querySelectorAll("#theme-segmented button").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeValue === settings.theme));
  document.querySelectorAll("#fontsize-segmented button").forEach((b) =>
    b.classList.toggle("active", b.dataset.fontsizeValue === (settings.fontSize || "default")));
  document.querySelectorAll("#density-segmented button").forEach((b) =>
    b.classList.toggle("active", b.dataset.densityValue === settings.density));
  document.querySelectorAll("#accent-swatches button").forEach((b) =>
    b.classList.toggle("active", b.dataset.accentValue === settings.accent));
  syncTypographyPreset();
}

/* ---- Typography presets (0.7.2): font size + density in one pick. ---- */
function typographyPresetValue() {
  if (settings.fontSize === "small" && settings.density === "compact") return "compact";
  if (settings.fontSize === "large" && settings.density === "comfortable") return "reading";
  if ((settings.fontSize || "default") === "default" && settings.density === "comfortable") return "default";
  return "custom";
}
function syncTypographyPreset() {
  const el = document.getElementById("typography-preset");
  if (el) el.value = typographyPresetValue();
}
document.getElementById("typography-preset").addEventListener("change", (event) => {
  const combo = {
    default: ["default", "comfortable"],
    compact: ["small", "compact"],
    reading: ["large", "comfortable"],
  }[event.target.value];
  if (!combo) return;
  document.querySelector(`#fontsize-segmented button[data-fontsize-value="${combo[0]}"]`)?.click();
  document.querySelector(`#density-segmented button[data-density-value="${combo[1]}"]`)?.click();
});
function applyFormDefaults() {
  segmentsEl.value = String(settings.defaultSegments);
  limitEl.value = settings.defaultLimit ? String(settings.defaultLimit) : "";
}
function syncSettingsForm() {
  document.getElementById("set-segments").value = String(settings.defaultSegments);
  document.getElementById("set-limit").value = settings.defaultLimit ? String(settings.defaultLimit) : "";
  const viewLimit = document.getElementById("view-limit");
  if (viewLimit) viewLimit.value = settings.defaultLimit ? String(settings.defaultLimit) : "";
  document.getElementById("set-concurrent").value = String(engineSettings.maxConcurrent);
  document.getElementById("set-folder").value = engineSettings.downloadsDir;
  document.getElementById("set-chunks").checked = settings.showChunks;
  document.getElementById("set-path").checked = settings.showPath;
  document.getElementById("set-toast").checked = settings.completionToast;
  document.getElementById("set-effects").checked = settings.reduceEffects;
  document.getElementById("set-complete-action").value = engineSettings.completionAction || "none";
  document.getElementById("set-clipboard").checked = engineSettings.clipboardMonitor !== false;
  document.getElementById("set-proxy").value = engineSettings.proxyUrl || "";
  document.getElementById("set-retry").value = String(engineSettings.retryAttempts ?? 3);
  document.getElementById("set-retry-delay").value = String(engineSettings.retryDelayBaseSec ?? 10);
  const folders = engineSettings.categoryFolders || {};
  for (const cat of ["Video", "Audio", "Documents", "Compressed", "Programs", "General"]) {
    const input = document.getElementById(`cat-folder-${cat}`);
    if (input) input.value = folders[cat] || "";
  }
  document.getElementById("set-native-notif").checked = engineSettings.nativeNotifications !== false;
  // 0.7.0 settings (engine-side, via dm:get-settings).
  const sched = engineSettings.schedulerPolicy || { enabled: false, windows: [] };
  document.getElementById("set-sched-enabled").checked = sched.enabled === true;
  renderSchedWindows(sched.windows || []);
  const smart = engineSettings.smartConfig || { enabled: false, smartLimitBytesPerSec: 0, watchlist: [] };
  document.getElementById("set-smart-enabled").checked = smart.enabled === true;
  document.getElementById("set-smart-limit").value = smart.smartLimitBytesPerSec ? String(smart.smartLimitBytesPerSec) : "";
  document.getElementById("set-smart-watchlist").value = (smart.watchlist || []).join("\n");
  document.getElementById("set-extract").checked = engineSettings.autoExtract === true;
  document.getElementById("set-scan").checked = engineSettings.defenderScan === true;
  const seeding = engineSettings.seedingPolicy || { enabled: false, ratioLimit: 0, maxMinutes: 0 };
  document.getElementById("set-seed-enabled").checked = seeding.enabled === true;
  document.getElementById("set-seed-ratio").value = seeding.ratioLimit ? String(seeding.ratioLimit) : "";
  document.getElementById("set-seed-minutes").value = seeding.maxMinutes ? String(seeding.maxMinutes) : "";
  const prefs = engineSettings.notificationPrefs || {};
  document.getElementById("set-notif-banners").checked = prefs.banners !== false;
  document.getElementById("set-notif-sound").checked = prefs.sound === true;
  document.getElementById("set-quiet-start").value = prefs.quietStart || "";
  document.getElementById("set-quiet-end").value = prefs.quietEnd || "";
  renderNotifCategories(prefs.disabledCategories || []);
  renderQueueLimits();
  refreshStats();
}

/* ---- Settings search + per-section reset (0.7.2, OmniGet-style) ----
 * Search filters rows by their visible text and hides section headers
 * whose rows are all filtered out. Reset reuses each control's own
 * change/click handler (set value, fire the event), so saving and
 * engine sync stay exactly the same as a manual change. The downloads
 * folder is intentionally left out of Downloads reset: it is a
 * location, not a preference. */
function fireSettingsChange(el) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function setSettingsInput(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  fireSettingsChange(el);
}
function setSettingsCheck(id, checked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = checked;
  fireSettingsChange(el);
}
const SETTINGS_SECTION_RESETS = {
  appearance: () => {
    document.querySelector('#theme-segmented button[data-theme-value="dark"]')?.click();
    document.querySelector('#fontsize-segmented button[data-fontsize-value="default"]')?.click();
    document.querySelector('#density-segmented button[data-density-value="comfortable"]')?.click();
    document.querySelector('#accent-swatches button[data-accent-value="figma"]')?.click();
  },
  downloads: () => {
    setSettingsInput("set-segments", "0");
    setSettingsInput("set-limit", "");
    setSettingsInput("set-concurrent", "3");
  },
  automation: () => {
    setSettingsInput("set-complete-action", "none");
    setSettingsCheck("set-clipboard", true);
    setSettingsInput("set-proxy", "");
    setSettingsInput("set-retry", "3");
    setSettingsInput("set-retry-delay", "10");
  },
  queues: () => {
    document.querySelectorAll("input[data-queue-limit]").forEach((el) => {
      el.value = "";
      fireSettingsChange(el);
    });
  },
  categories: () => {
    for (const cat of ["Video", "Audio", "Documents", "Compressed", "Programs", "General"]) {
      const el = document.getElementById(`cat-folder-${cat}`);
      if (el) {
        el.value = "";
        fireSettingsChange(el);
      }
    }
  },
  display: () => {
    setSettingsCheck("set-chunks", true);
    setSettingsCheck("set-path", false);
    setSettingsCheck("set-toast", true);
    setSettingsCheck("set-effects", false);
    setSettingsCheck("set-native-notif", true);
  },
  scheduler: () => {
    // Disabling is the reset; saved windows stay but are inactive.
    setSettingsCheck("set-sched-enabled", false);
  },
  smart: () => {
    setSettingsCheck("set-smart-enabled", false);
    setSettingsInput("set-smart-limit", "");
    setSettingsInput("set-smart-watchlist", "");
  },
  after: () => {
    setSettingsCheck("set-extract", false);
    setSettingsCheck("set-scan", false);
  },
  seeding: () => {
    setSettingsCheck("set-seed-enabled", false);
    setSettingsInput("set-seed-ratio", "");
    setSettingsInput("set-seed-minutes", "");
  },
  notifications: () => {
    setSettingsCheck("set-notif-banners", true);
    setSettingsCheck("set-notif-sound", false);
    setSettingsInput("set-quiet-start", "");
    setSettingsInput("set-quiet-end", "");
  },
};
document.querySelectorAll(".section-reset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const reset = SETTINGS_SECTION_RESETS[btn.dataset.resetSection];
    if (reset) reset();
  });
});
document.getElementById("settings-search").addEventListener("input", () => {
  const query = (document.getElementById("settings-search").value || "").trim().toLowerCase();
  const modal = document.querySelector("#settings-overlay .settings-modal");
  if (!modal) return;
  // Search uses its own marker class, never the generic "hidden": rows
  // hidden for other reasons (a toggle being off) must stay hidden, and
  // clearing the search must restore exactly the pre-search state.
  for (const row of modal.querySelectorAll(".setting-row")) {
    const match = !query || row.textContent.toLowerCase().includes(query);
    row.classList.toggle("search-hidden", !match);
  }
  // Hide a section header only when it owns rows and all are hidden;
  // its intro hint paragraph follows the header's visibility.
  const headers = [...modal.querySelectorAll(".settings-section")];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const next = headers[i + 1] || null;
    let node = header.nextElementSibling;
    let hasRows = false;
    let anyVisible = false;
    const hints = [];
    while (node && node !== next) {
      if (node.classList && node.classList.contains("setting-row")) {
        hasRows = true;
        if (!node.classList.contains("hidden") && !node.classList.contains("search-hidden")) anyVisible = true;
      }
      if (node.tagName === "P" && node.classList.contains("setting-hint")) hints.push(node);
      if (node.querySelectorAll) {
        for (const r of node.querySelectorAll(".setting-row")) {
          hasRows = true;
          if (!r.classList.contains("hidden") && !r.classList.contains("search-hidden")) anyVisible = true;
        }
      }
      node = node.nextElementSibling;
    }
    const hide = hasRows && !anyVisible;
    header.classList.toggle("search-hidden", hide);
    for (const hint of hints) hint.classList.toggle("search-hidden", hide);
  }
});

function renderSchedWindows(windows) {
  const wrap = document.getElementById("sched-windows");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!windows.length) {
    wrap.innerHTML = `<p class="setting-hint">No windows yet — add one above, or leave scheduling off to download any time.</p>`;
    return;
  }
  windows.forEach((window, index) => {
    const row = document.createElement("div");
    row.className = "sched-window-row";
    row.innerHTML = `<span class="mono">${escapeHtml(window.start)} – ${escapeHtml(window.end)}</span>
      <button class="secondary-btn small-btn" data-sched-remove="${index}">Remove</button>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("[data-sched-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const current = engineSettings.schedulerPolicy || { enabled: false, windows: [] };
      const windows = [...(current.windows || [])];
      windows.splice(Number(btn.dataset.schedRemove), 1);
      engineSettings = await window.dm.setSettings({ schedulerPolicy: { enabled: current.enabled, windows } });
      syncSettingsForm();
    });
  });
}

function renderNotifCategories(disabled) {
  const wrap = document.getElementById("notif-categories");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const cat of ["Video", "Audio", "Documents", "Compressed", "Programs", "General"]) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" data-notif-cat="${cat}" ${disabled.includes(cat) ? "checked" : ""} /> ${cat}`;
    wrap.appendChild(label);
  }
  wrap.querySelectorAll("[data-notif-cat]").forEach((box) => {
    box.addEventListener("change", async () => {
      const boxes = [...wrap.querySelectorAll("[data-notif-cat]:checked")].map((b) => b.dataset.notifCat);
      const prefs = engineSettings.notificationPrefs || {};
      engineSettings = await window.dm.setSettings({ notificationPrefs: { ...prefs, disabledCategories: boxes } });
    });
  });
}
function renderQueueLimits() {
  const wrap = document.getElementById("queue-limits");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const queue of queueList) {
    const row = document.createElement("div");
    row.className = "setting-row folder-row";
    row.innerHTML = `<div><div class="setting-label">${escapeHtml(queue.name)}</div></div>
      <div class="folder-controls">
        <input class="setting-input" type="number" min="0" placeholder="0 = no cap" data-queue-limit="${escapeHtml(queue.id)}" value="${queue.speedLimitBytesPerSec || ""}" />
      </div>`;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll("input[data-queue-limit]").forEach((input) => {
    input.addEventListener("change", async () => {
      await window.dm.setQueueLimit(input.dataset.queueLimit, Number(input.value) || 0);
      await refreshQueues();
      renderQueueLimits();
    });
  });
}
// Category folder rows are built once (inputs + per-row Browse).
(function buildCatFolders() {
  const wrap = document.getElementById("cat-folders");
  if (!wrap) return;
  for (const cat of ["Video", "Audio", "Documents", "Compressed", "Programs", "General"]) {
    const row = document.createElement("div");
    row.className = "setting-row folder-row";
    row.innerHTML = `<div><div class="setting-label">${cat}</div></div>
      <div class="folder-controls">
        <input id="cat-folder-${cat}" class="setting-input folder-input" type="text" spellcheck="false" />
        <button class="secondary-btn small-btn" data-cat-browse="${cat}">Browse…</button>
      </div>`;
    wrap.appendChild(row);
  }
  wrap.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-cat-browse]");
    if (!btn) return;
    const folder = await window.dm.chooseFolder();
    if (!folder) return;
    document.getElementById(`cat-folder-${btn.dataset.catBrowse}`).value = folder;
    const folders = { ...(engineSettings.categoryFolders || {}) };
    folders[btn.dataset.catBrowse] = folder;
    await pushEngineSettings({ categoryFolders: folders });
  });
  wrap.addEventListener("change", (event) => {
    const input = event.target.closest("input[id^='cat-folder-']");
    if (!input) return;
    const cat = input.id.replace("cat-folder-", "");
    const folders = { ...(engineSettings.categoryFolders || {}) };
    const value = input.value.trim();
    if (value) folders[cat] = value;
    else delete folders[cat];
    void pushEngineSettings({ categoryFolders: folders });
  });
})();
document.getElementById("set-complete-action").addEventListener("change", (event) => {
  void pushEngineSettings({ completionAction: event.target.value });
});
document.getElementById("set-clipboard").addEventListener("change", (event) => {
  void pushEngineSettings({ clipboardMonitor: event.target.checked });
});
document.getElementById("set-proxy").addEventListener("change", (event) => {
  void pushEngineSettings({ proxyUrl: event.target.value.trim() });
});
document.getElementById("set-retry").addEventListener("change", (event) => {
  void pushEngineSettings({ retryAttempts: Number(event.target.value) || 0 });
});
document.getElementById("set-retry-delay").addEventListener("change", (event) => {
  void pushEngineSettings({ retryDelayBaseSec: Number(event.target.value) || 10 });
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});

// Settings modal open / close / live changes.
const settingsOverlay = document.getElementById("settings-overlay");
function openSettings() {
  syncSettingsForm();
  applySettings();
  settingsOverlay.classList.remove("hidden");
}
function closeSettings() {
  settingsOverlay.classList.add("hidden");
}
document.getElementById("settings-btn").addEventListener("click", openSettings);
document.getElementById("settings-close").addEventListener("click", closeSettings);
document.getElementById("settings-done").addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (event) => {
  if (event.target === settingsOverlay) closeSettings();
});
document.getElementById("theme-segmented").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-theme-value]");
  if (!btn) return;
  settings.theme = btn.dataset.themeValue;
  saveSettings();
  applySettings();
});
document.getElementById("density-segmented").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-density-value]");
  if (!btn) return;
  settings.density = btn.dataset.densityValue;
  saveSettings();
  applySettings();
});
document.getElementById("accent-swatches").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-accent-value]");
  if (!btn) return;
  settings.accent = btn.dataset.accentValue;
  saveSettings();
  applySettings();
});
document.getElementById("set-segments").addEventListener("change", (event) => {
  const n = Number(event.target.value);
  settings.defaultSegments = Number.isNaN(n) ? 8 : n;
  saveSettings();
  applySettings();
  applyFormDefaults();
});
document.getElementById("set-limit").addEventListener("change", (event) => {
  settings.defaultLimit = Math.max(0, Number(event.target.value) || 0);
  saveSettings();
  applySettings();
  applyFormDefaults();
  const viewLimit = document.getElementById("view-limit");
  if (viewLimit) viewLimit.value = event.target.value;
});
document.getElementById("set-chunks").addEventListener("change", (event) => {
  settings.showChunks = event.target.checked;
  saveSettings();
  applySettings();
});
document.getElementById("set-path").addEventListener("change", (event) => {
  settings.showPath = event.target.checked;
  saveSettings();
  applySettings();
});
document.getElementById("set-toast").addEventListener("change", (event) => {
  settings.completionToast = event.target.checked;
  saveSettings();
});
document.getElementById("set-effects").addEventListener("change", (event) => {
  settings.reduceEffects = event.target.checked;
  saveSettings();
  applySettings();
});
document.getElementById("set-native-notif").addEventListener("change", (event) => {
  void pushEngineSettings({ nativeNotifications: event.target.checked });
});
async function pushEngineSettings(partial) {
  try {
    engineSettings = await window.dm.setSettings(partial);
    applySettings();
    refreshDisk();
  } catch { /* main keeps the old values; form re-syncs on next open */ }
}
document.getElementById("set-concurrent").addEventListener("change", (event) => {
  void pushEngineSettings({ maxConcurrent: Number(event.target.value) || 3 });
});
document.getElementById("set-folder").addEventListener("change", (event) => {
  const value = event.target.value.trim();
  if (value) void pushEngineSettings({ downloadsDir: value });
});
document.getElementById("set-folder-browse").addEventListener("click", async () => {
  const folder = await window.dm.chooseFolder();
  if (folder) {
    document.getElementById("set-folder").value = folder;
    await pushEngineSettings({ downloadsDir: folder });
  }
});
document.getElementById("set-folder-open").addEventListener("click", () => {
  void window.dm.openDownloadsFolder();
});
document.getElementById("settings-reset").addEventListener("click", async () => {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  await pushEngineSettings({ maxConcurrent: 3 });
  syncSettingsForm();
  applySettings();
  applyFormDefaults();
});
applySettings();
applyFormDefaults();

// Completion toast: shown when a job flips to completed.
const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 5000);
}
toastEl.addEventListener("click", () => {
  toastEl.classList.add("hidden");
  clearTimeout(toastTimer);
});

// Filters (0.7.4): Downloads-view chips for status, a category select,
// and the sidebar queue list. One filter is active at a time, exactly
// like the old sidebar list.
let filterKind = "status";
let filterValue = "all";
let searchQuery = "";
let gridView = false;
let currentView = "home";

const viewHomeEl = document.getElementById("view-home");
const viewDownloadsEl = document.getElementById("view-downloads");
function syncViewNav() {
  document.getElementById("nav-home")?.classList.toggle("active", currentView === "home");
  document.getElementById("nav-downloads")?.classList.toggle("active", currentView === "downloads");
}
function showHomeView() {
  currentView = "home";
  viewHomeEl.classList.remove("hidden");
  viewDownloadsEl.classList.add("hidden");
  syncViewNav();
}
function showDownloadsView() {
  currentView = "downloads";
  viewHomeEl.classList.add("hidden");
  viewDownloadsEl.classList.remove("hidden");
  syncViewNav();
  refresh();
}
document.getElementById("nav-home").addEventListener("click", showHomeView);
document.getElementById("nav-downloads").addEventListener("click", showDownloadsView);
document.getElementById("bottom-view-downloads").addEventListener("click", showDownloadsView);
document.getElementById("nav-about").addEventListener("click", () => {
  openSettings();
  document.getElementById("about-section")?.scrollIntoView({ block: "start" });
});
document.getElementById("sidebar-collapse").addEventListener("click", (event) => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  event.target.textContent = collapsed ? "▶" : "◀ Collapse sidebar";
});

const FILTER_TITLES = { all: "All Downloads", downloading: "Active", queued: "Queued", completed: "Completed", paused: "Paused", failed: "Failed" };
function syncFilterControls() {
  document.querySelectorAll("#filter-chips .chip").forEach((chip) => {
    chip.classList.toggle("active", filterKind === "status" && chip.dataset.filterChip === filterValue);
  });
  const cat = document.getElementById("category-filter");
  if (cat) cat.value = filterKind === "category" ? filterValue : "all";
  if (filterKind !== "queue") {
    document.querySelectorAll("#queue-nav .nav-item").forEach((b) => b.classList.remove("active"));
  }
}
function setStatusFilter(value) {
  filterKind = "status";
  filterValue = value;
  syncFilterControls();
  refresh();
}
function setCategoryFilter(value) {
  if (value === "all") {
    setStatusFilter("all");
    return;
  }
  filterKind = "category";
  filterValue = value;
  syncFilterControls();
  refresh();
}
function filterTitle() {
  if (filterKind === "queue") {
    const queue = queueList.find((q) => q.id === filterValue);
    return queue ? queue.name : "All Downloads";
  }
  if (filterKind === "category") return filterValue;
  return FILTER_TITLES[filterValue] || "All Downloads";
}
document.getElementById("filter-chips").addEventListener("click", (event) => {
  const chip = event.target.closest("button[data-filter-chip]");
  if (!chip) return;
  setStatusFilter(chip.dataset.filterChip);
});
document.getElementById("category-filter").addEventListener("change", (event) => {
  setCategoryFilter(event.target.value);
});
document.getElementById("view-limit").addEventListener("change", (event) => {
  // Mirror of the Settings default limit: reuse its own handler so
  // saving and form defaults stay exactly the same as a manual change.
  setSettingsInput("set-limit", event.target.value);
});

/* ---- Home view (0.7.4, OmniGet-style) ----
 * Centered paste pill + preview card. Preview metadata is
 * best-effort only: YouTube titles come from the existing yt-dlp
 * info path, everything else from the URL itself — Download never
 * waits on preview, and creating the job reuses submitDownload, the
 * exact New Task path with its validation. */
const homeUrlEl = document.getElementById("home-url");
const homePreviewEl = document.getElementById("home-preview");
const homeStatusEl = document.getElementById("home-status");
let homePreviewUrl = "";
function homeMetaFor(url) {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return { title: decodeURIComponent(tail) || parsed.hostname, meta: parsed.hostname, thumb: "" };
  } catch {
    return { title: url, meta: "", thumb: "" };
  }
}
async function refreshHomePreview(withNetwork = false) {
  const url = homeUrlEl.value.trim();
  homePreviewUrl = url;
  if (!url) {
    homePreviewEl.classList.add("hidden");
    homeStatusEl.textContent = "";
    return;
  }
  let info = homeMetaFor(url);
  // Network metadata only on paste/blur, never per keystroke: typing
  // a YouTube URL must not spawn a yt-dlp info fetch on every letter.
  if (withNetwork && /youtube\.com\/watch|youtu\.be\//i.test(url)) {
    try {
      const yt = await window.dm.ytInfo(url);
      if (homePreviewUrl === url && yt) {
        info = {
          title: yt.title || info.title,
          meta: [yt.uploader, yt.durationSeconds != null ? formatEta(yt.durationSeconds) : "", yt.isPlaylist ? "Playlist" : ""].filter(Boolean).join(" · ") || info.meta,
          thumb: yt.thumbnail || "",
        };
      }
    } catch { /* best-effort: fall back to the URL-derived preview */ }
  }
  if (homePreviewUrl !== url) return;
  document.getElementById("home-title").textContent = info.title;
  document.getElementById("home-meta").textContent = info.meta;
  const thumb = document.getElementById("home-thumb");
  if (info.thumb) thumb.src = info.thumb;
  else thumb.removeAttribute("src");
  homePreviewEl.classList.remove("hidden");
}
homeUrlEl.addEventListener("input", () => { void refreshHomePreview(false); });
homeUrlEl.addEventListener("change", () => { void refreshHomePreview(true); });
homeUrlEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("home-download").click();
  }
});
document.getElementById("home-paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      homeUrlEl.value = text.trim();
      await refreshHomePreview(true);
    }
  } catch { /* clipboard read needs permission: fall back to typing */ }
  homeUrlEl.focus();
});
document.getElementById("home-download").addEventListener("click", async () => {
  const url = homeUrlEl.value.trim();
  if (!url) {
    homeStatusEl.textContent = "Paste a link first.";
    homeUrlEl.focus();
    return;
  }
  homeStatusEl.textContent = "";
  urlEl.value = url;
  await submitDownload();
  if (errorEl.textContent) {
    // submitDownload reports into the (currently hidden) New Task
    // form: surface it here instead of leaving the user guessing.
    homeStatusEl.textContent = errorEl.textContent;
    return;
  }
  homeUrlEl.value = "";
  homePreviewEl.classList.add("hidden");
  showDownloadsView();
  showToast("Download added");
});
document.getElementById("home-new-task").addEventListener("click", () => {
  showDownloadsView();
  document.getElementById("new-task").click();
});
document.getElementById("home-yt").addEventListener("click", openYtCard);
document.getElementById("home-grab").addEventListener("click", () => {
  showDownloadsView();
  document.getElementById("grab-task").click();
});
searchEl.addEventListener("input", () => {
  searchQuery = searchEl.value.trim().toLowerCase();
  refresh();
});
document.getElementById("view-toggle").addEventListener("click", () => {
  gridView = !gridView;
  jobsEl.classList.toggle("grid", gridView);
  refresh();
});
const addCard = document.getElementById("add-card");
// 0.7.1 simplification: "Advanced options" sections are collapsed by default
// and reset to collapsed every time their card is opened. The inputs keep
// their IDs, so submit handlers read advanced values exactly as before.
function wireAdvancedToggle(buttonId, sectionId) {
  const btn = document.getElementById(buttonId);
  const section = document.getElementById(sectionId);
  const sync = () => {
    const expanded = !section.classList.contains("hidden");
    btn.textContent = expanded ? "Advanced options ▾" : "Advanced options ▸";
    btn.setAttribute("aria-expanded", String(expanded));
  };
  btn.addEventListener("click", () => {
    section.classList.toggle("hidden");
    sync();
  });
  return () => {
    section.classList.add("hidden");
    sync();
  };
}
const collapseAddAdvanced = wireAdvancedToggle("add-advanced-toggle", "add-advanced");
document.getElementById("new-task").addEventListener("click", () => {
  showDownloadsView();
  collapseAddAdvanced();
  addCard.classList.remove("hidden");
  urlEl.focus();
});
document.getElementById("add-close").addEventListener("click", () => addCard.classList.add("hidden"));
document.getElementById("add-later").addEventListener("click", () => {
  urlEl.value = "";
  errorEl.textContent = "";
  addCard.classList.add("hidden");
});

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
// Speed graph (feature 13): thin polyline of aggregate download speed.
const speedSamples = [];
function drawSpeedGraph() {
  const canvas = document.getElementById("speed-graph");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (speedSamples.length < 2) return;
  const max = Math.max(...speedSamples, 1);
  ctx.beginPath();
  speedSamples.forEach((value, i) => {
    const x = (i / (speedSamples.length - 1)) * w;
    const y = h - (value / max) * (h - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
// Behance file tiles: blue MP4, gray TXT, yellow ZIP, red/pink MP3, purple EXE.
const TILE = {
  Video: { icon: "▶", ext: "MP4" },
  Audio: { icon: "♪", ext: "MP3" },
  Documents: { icon: "▤", ext: "DOC" },
  Compressed: { icon: "▭", ext: "ZIP" },
  Programs: { icon: "▣", ext: "EXE" },
  General: { icon: "▦", ext: "FILE" },
};

let allJobs = [];
// Card elements kept by job id so progress updates move the bar in
// place (CSS transition) instead of rebuilding the whole list every
// 250 ms — that rebuild was the flicker/jank in the old UI.
const cards = new Map();

function filteredJobs() {
  const visible = allJobs.filter((job) => {
    if (filterKind === "status") {
      if (filterValue === "downloading" && job.status !== "downloading" && job.status !== "queued" && job.status !== "retrying") return false;
      if (filterValue !== "all" && filterValue !== "downloading" && job.status !== filterValue) return false;
    } else if (filterKind === "queue") {
      if (filterValue !== "all" && (job.queueId || "main") !== filterValue) return false;
    } else if (filterValue !== "all" && job.category !== filterValue) {
      return false;
    }
    if (searchQuery) {
      const hay = `${job.filename} ${job.url} ${job.destination} ${job.category}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });
  // 0.7.0 sorting (toolbar select); date-desc is the old behaviour.
  const sizeOf = (job) => job.progress?.totalBytes ?? 0;
  const byName = (a, b) => a.filename.localeCompare(b.filename);
  if (sortMode === "date-asc") visible.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  else if (sortMode === "name") visible.sort(byName);
  else if (sortMode === "size-desc") visible.sort((a, b) => sizeOf(b) - sizeOf(a));
  else if (sortMode === "status") visible.sort((a, b) => a.status.localeCompare(b.status) || b.createdAt.localeCompare(a.createdAt));
  else visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return visible;
}

/* ---- Multiple queues: sidebar nav + New Task picker ---- */
let queueList = [{ id: "main", name: "Main Queue", maxConcurrent: 3 }];
async function refreshQueues() {
  try {
    queueList = await window.dm.queues();
  } catch { /* keep the last known list */ }
  const nav = document.getElementById("queue-nav");
  nav.innerHTML = "";
  for (const queue of queueList) {
    const btn = document.createElement("button");
    btn.className = "nav-item" + (filterKind === "queue" && filterValue === queue.id ? " active" : "");
    btn.dataset.kind = "queue";
    btn.dataset.value = queue.id;
    btn.innerHTML = `<span class="nav-icon">▤</span> ${escapeHtml(queue.name)}${queue.speedLimitBytesPerSec ? ` <span class="queue-limit">${formatBytes(queue.speedLimitBytesPerSec)}/s</span>` : ""}`;
    if (queue.id !== "main") {
      const del = document.createElement("span");
      del.className = "queue-del";
      del.textContent = "✕";
      del.title = "Delete queue (only when empty)";
      del.addEventListener("click", async (event) => {
        event.stopPropagation();
        await window.dm.deleteQueue(queue.id);
        if (filterKind === "queue" && filterValue === queue.id) {
          filterKind = "status";
          filterValue = "all";
        }
        await refreshQueues();
        refresh();
      });
      btn.appendChild(del);
    }
    btn.addEventListener("click", () => {
      document.querySelectorAll("#filter-chips .chip").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll("#queue-nav .nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      filterKind = "queue";
      filterValue = queue.id;
      showDownloadsView();
      refresh();
    });
    nav.appendChild(btn);
  }
  const picker = document.getElementById("queue");
  if (picker) {
    const current = picker.value;
    picker.innerHTML = queueList.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}</option>`).join("");
    if (queueList.some((q) => q.id === current)) picker.value = current;
  }
}
document.getElementById("queue-create").addEventListener("click", async () => {
  const input = document.getElementById("queue-name");
  const name = input.value.trim();
  if (!name) return;
  await window.dm.createQueue(name);
  input.value = "";
  await refreshQueues();
});
refreshQueues();

function actionsFor(job) {
  const parts = [];
  if (job.status === "downloading" || job.status === "queued") {
    parts.push(`<button class="icon-btn" data-action="pause" data-id="${job.id}" title="Pause">⏸</button>`);
  }
  if (job.status === "paused") {
    parts.push(`<button class="icon-btn" data-action="resume" data-id="${job.id}" title="Resume">▶</button>`);
  }
  // 0.7.0: a finished torrent still seeding gets an explicit stop.
  if (job.seeding) {
    parts.push(`<button class="icon-btn" data-action="stop-seeding" data-id="${job.id}" title="Stop seeding">⏹</button>`);
  }
  parts.push(`<button class="icon-btn" data-action="details" data-id="${job.id}" title="Details">ℹ</button>`);
  parts.push(`<button class="icon-btn danger" data-action="cancel" data-id="${job.id}" title="Cancel / remove">✕</button>`);
  return parts.join("");
}

function createCard(job) {
  const tile = TILE[job.category] || TILE.General;
  const card = document.createElement("article");
  card.className = "job-card";
  card.dataset.jobId = job.id;
  // OmniGet-style card (0.7.4): tile + main column (title row, meta
  // line, progress, stage chips). updateCard still finds every field
  // by the same class names as before.
  card.innerHTML = `
    <div class="job-select"><input type="checkbox" data-select="${job.id}" title="Select for bulk actions" /></div>
    <div class="tile ${escapeHtml(job.category)}"><span class="tile-icon">${tile.icon}</span><span class="tile-ext">${tile.ext}</span></div>
    <div class="job-main">
      <div class="job-top">
        <div class="job-name"></div>
        <div class="job-status"><span class="pill"></span></div>
        <div class="job-actions"></div>
      </div>
      <div class="job-meta-line">
        <span class="pct"></span>
        <span class="sizes"></span>
        <span class="speed"></span>
        <span class="eta"></span>
        <span class="job-date"></span>
      </div>
      <div class="job-path"></div>
      <div class="bar"><div></div></div>
      <div class="chunk-bar"></div>
      <div class="stage-chips"></div>
      <div class="job-error"></div>
    </div>`;
  card.querySelector(".job-name").textContent = job.filename;
  card.querySelector(".job-name").title = job.destination;
  card.querySelector(".job-path").textContent = job.destination;
  card.querySelector(".job-actions").innerHTML = actionsFor(job);
  // Low-end optimization: cache every element updateCard touches, so a
  // progress refresh never pays for a dozen querySelector calls again.
  card._el = {
    select: card.querySelector("[data-select]"),
    pill: card.querySelector(".pill"),
    bar: card.querySelector(".bar"),
    barFill: card.querySelector(".bar > div"),
    pct: card.querySelector(".pct"),
    sizes: card.querySelector(".sizes"),
    speed: card.querySelector(".speed"),
    eta: card.querySelector(".eta"),
    date: card.querySelector(".job-date"),
    error: card.querySelector(".job-error"),
    stages: card.querySelector(".stage-chips"),
    chunkBar: card.querySelector(".chunk-bar"),
    actions: card.querySelector(".job-actions"),
  };
  card._last = {};
  card._chunkEls = [];
  card._lastBuckets = "";
  card._lastChunkAt = 0;
  return card;
}

// Write text only when it actually changed: identical textContent
// assignments still cost layout work when done 4x/sec per job.
function setText(el, key, value, cache) {
  if (cache[key] !== value) {
    cache[key] = value;
    el.textContent = value;
  }
}

/* ---- Download stage pipeline (0.7.2, OmniGet-style) ----
 * Pure derivation from job state — no new data needed. YouTube jobs
 * show Download → Finishing → Done (100% while still downloading
 * means yt-dlp is merging/embedding). Jobs with an expected hash
 * show Download → Verify → Done; everything else Download → Done.
 * States: done (✓), current, upcoming, failed (✕), paused. */
function stageChipsHtml(job) {
  const status = job.status;
  const pct = job.progress && job.progress.percent != null ? job.progress.percent : 0;
  let stages;
  if (job.isYoutube) stages = ["Download", "Finishing", "Done"];
  else if (job.expectedHash) stages = ["Download", "Verify", "Done"];
  else stages = ["Download", "Done"];
  // Index of the stage in progress, or stages.length when all done.
  let current = -1;
  let failedAt = -1;
  if (status === "completed") {
    if (job.checksumStatus === "mismatch") {
      // File arrived but failed verification: Done is not reached.
      failedAt = stages.indexOf("Verify");
      current = failedAt >= 0 ? failedAt : stages.length;
    } else if (job.expectedHash && job.checksumStatus !== "pass") {
      current = 1; // verification still pending
    } else {
      current = stages.length;
    }
  } else if (status === "failed") {
    failedAt = job.isYoutube && pct >= 1 ? 1 : 0;
  } else if (status === "queued") {
    current = -1;
  } else {
    // downloading, paused, retrying
    current = job.isYoutube && pct >= 1 ? 1 : 0;
  }
  const stateFor = (i) => {
    if (i === failedAt) return "failed";
    if (current === stages.length || i < current) return "done";
    if (i === current) return status === "paused" ? "paused" : "current";
    return "upcoming";
  };
  const mark = (state) => (state === "done" ? "✓ " : state === "failed" ? "✕ " : "");
  return stages.map((label, i) => {
    const state = stateFor(i);
    return `<span class="stage-chip ${state}">${mark(state)}${label}</span>`;
  }).join(`<span class="stage-sep">→</span>`);
}

function updateCard(card, job) {
  const el = card._el;
  const last = card._last;
  const p = job.progress;
  const pct = p && p.percent != null ? p.percent * 100 : 0;
  // Clearer pill labels than raw status keys (0.7.0 UI polish).
  const pillLabel = {
    downloading: "Downloading", queued: "Queued", paused: "Paused",
    completed: job.seeding ? "Seeding" : "Completed",
    failed: "Failed", retrying: "Retrying",
  }[job.status] ?? job.status;
  setText(el.pill, "pill", pillLabel, last);
  if (last.pillClass !== job.status) {
    last.pillClass = job.status;
    el.pill.className = `pill ${job.status}`;
  }
  if (last.barClass !== job.status) {
    last.barClass = job.status;
    el.bar.className = `bar ${job.status}`;
  }
  const width = `${Math.min(100, pct)}%`;
  if (last.width !== width) {
    last.width = width;
    el.barFill.style.width = width;
  }
  setText(el.pct, "pct", p && p.percent != null ? `${pct.toFixed(1)}%` : "0.0%", last);
  setText(el.sizes, "sizes", p
    ? `${formatBytes(p.downloadedBytes)} / ${p.totalBytes != null ? formatBytes(p.totalBytes) : "?"}`
    : "Waiting…", last);
  setText(el.speed, "speed", p ? `${formatBytes(Math.round(p.speedBytesPerSec))}/s` : "—", last);
  setText(el.eta, "eta", p ? `${formatEta(p.etaSeconds)} left` : "--:--", last);
  setText(el.date, "date", formatDate(job.createdAt), last);
  // 0.7.0 post-download results ride on the status line; the pill
  // class still keys off status so colours never lie about state.
  const statusBits = [job.error ?? job.warning ?? ""];
  if (job.extractStatus) statusBits.push(`Extract: ${job.extractStatus}`);
  if (job.scanStatus) statusBits.push(`Defender: ${job.scanStatus}`);
  setText(el.error, "error", statusBits.filter(Boolean).join(" · "), last);
  // Stage chips: change-only write, like every other card field.
  if (el.stages) {
    const chips = stageChipsHtml(job);
    if (last.stages !== chips) {
      last.stages = chips;
      el.stages.innerHTML = chips;
    }
  }
  const chunkBar = el.chunkBar;
  if (p && p.segments.length > 1) {
    // B6 fix: stream jobs report one "segment" per media segment —
    // hundreds for a long video — so bucket them into at most 32 bars
    // instead of creating a DOM node per segment on every tick.
    const MAX_CHUNKS = 32;
    const segs = p.segments;
    let buckets;
    if (segs.length <= MAX_CHUNKS) {
      buckets = segs.map((segment) => {
        const length = segment.end - segment.start + 1;
        return Math.min(100, Math.round((segment.downloaded / length) * 100));
      });
    } else {
      buckets = [];
      const per = segs.length / MAX_CHUNKS;
      for (let b = 0; b < MAX_CHUNKS; b++) {
        let done = 0;
        let length = 0;
        for (let i = Math.floor(b * per); i < Math.floor((b + 1) * per); i++) {
          const segment = segs[i];
          const segLen = segment.end - segment.start + 1;
          length += segLen;
          done += Math.min(segment.downloaded, segLen);
        }
        buckets.push(length ? Math.min(100, Math.round((done / length) * 100)) : 0);
      }
    }
    if (chunkBar.childElementCount !== buckets.length) {
      chunkBar.innerHTML = buckets.map(() => `<div class="chunk"><div></div></div>`).join("");
      card._chunkEls = [...chunkBar.children].map((chunkEl) => chunkEl.firstElementChild);
      card._lastChunkAt = 0;
      card._lastBuckets = "";
    }
    // Chunk fills move constantly; repaint them at most twice a second.
    const bucketsKey = buckets.join(",");
    const now = Date.now();
    if (card._lastBuckets !== bucketsKey && now - card._lastChunkAt >= 500) {
      card._lastBuckets = bucketsKey;
      card._lastChunkAt = now;
      card._chunkEls.forEach((fill, i) => {
        fill.style.width = `${buckets[i]}%`;
      });
    }
  } else {
    if (chunkBar.childElementCount !== 0) chunkBar.innerHTML = "";
    card._lastBuckets = "";
  }
  if (card.dataset.actionsKey !== `${job.status}:${job.seeding ? 1 : 0}`) {
    card.dataset.actionsKey = `${job.status}:${job.seeding ? 1 : 0}`;
    el.actions.innerHTML = actionsFor(job);
  }
  // Multi-select checkbox is not a progress field: sync it cheaply
  // without touching the change-only-write caches above.
  if (el.select) el.select.checked = selectedIds.has(job.id);
}

/* ---- Persistent bottom aggregate bar (0.7.2, OmniGet-style) ----
 * Always visible, updated with the 1 Hz job refresh (never on the
 * 4x/sec progress ticks). Change-only writes, like the job cards. */
let lastBottomText = "";
function updateBottomBar(jobs, totalSpeed) {
  const active = jobs.filter((job) => job.status === "downloading" || job.status === "retrying");
  const completed = jobs.filter((job) => job.status === "completed").length;
  let status;
  let percent = "";
  if (!active.length) {
    status = completed ? `No active downloads · ${completed} completed` : "No active downloads";
  } else {
    let down = 0;
    let total = 0;
    let known = false;
    for (const job of active) {
      const p = job.progress;
      if (!p) continue;
      down += p.downloadedBytes;
      if (p.totalBytes != null) {
        total += p.totalBytes;
        known = true;
      }
    }
    if (known && total > 0) percent = `${Math.min(100, Math.round((down / total) * 100))}% overall`;
    status = `${active.length} downloading · ${completed} completed`;
  }
  const speed = `${formatBytes(Math.round(totalSpeed))}/s`;
  const text = `${status}|${percent}|${speed}`;
  if (text === lastBottomText) return;
  lastBottomText = text;
  const statusEl = document.getElementById("bottom-status");
  const percentEl = document.getElementById("bottom-percent");
  const speedEl = document.getElementById("bottom-speed");
  if (statusEl) statusEl.textContent = status;
  if (percentEl) percentEl.textContent = percent;
  if (speedEl) speedEl.textContent = speed;
}

const previousStatus = new Map();
let lastGraphAt = 0;
let sortMode = "date-desc";
const selectedIds = new Set();
function renderJobs(jobs) {
  for (const job of jobs) {
    const before = previousStatus.get(job.id);
    if (before && before !== "completed" && job.status === "completed") {
      if (settings.completionToast) showToast(`✓ ${job.filename} finished downloading`);
      // 0.7.0 completion sound: in-app chime, gated by the
      // notification prefs (sound on, category not muted, not in
      // quiet hours). Main still owns the OS banner separately.
      playCompletionSound(job);
    }
    previousStatus.set(job.id, job.status);
  }
  for (const id of [...previousStatus.keys()]) {
    if (!jobs.some((job) => job.id === id)) previousStatus.delete(id);
  }
  allJobs = jobs;
  // Low-end optimization: while the window is hidden/minimized, keep
  // the data fresh but skip every DOM write; the next visible render
  // refreshes all cards from allJobs.
  if (document.hidden) return;
  const visible = filteredJobs();

  const counts = { all: jobs.length, downloading: 0, queued: 0, paused: 0, completed: 0, failed: 0 };
  let totalSpeed = 0;
  let retrying = 0;
  for (const job of jobs) {
    if (counts[job.status] !== undefined) counts[job.status]++;
    if (job.status === "retrying") retrying++;
    if (job.status === "downloading" && job.progress) totalSpeed += job.progress.speedBytesPerSec || 0;
  }
  for (const [key, value] of Object.entries(counts)) {
    const el = document.getElementById(`count-${key}`);
    if (el) el.textContent = String(value);
  }
  document.getElementById("stat-speed").textContent = `${formatBytes(Math.round(totalSpeed))}/s`;
  document.getElementById("stat-active").textContent = String(counts.downloading + counts.queued + retrying);
  // Speed graph (feature 13): last 60 aggregate samples; repaint the
  // canvas at most twice a second instead of on every refresh.
  speedSamples.push(totalSpeed);
  if (speedSamples.length > 60) speedSamples.shift();
  const now = Date.now();
  if (now - lastGraphAt >= 500) {
    lastGraphAt = now;
    drawSpeedGraph();
  }
  document.getElementById("stat-done").textContent = String(counts.completed);
  updateBottomBar(jobs, totalSpeed);

  listTitleEl.textContent = filterTitle();
  listCountEl.textContent = visible.length ? `${visible.length} shown` : "";

  emptyEl.style.display = visible.length ? "none" : "block";
  jobsEl.style.display = visible.length ? "" : "none";
  document.getElementById("list-header").classList.toggle("hidden", !visible.length || gridView);
  // 0.7.0 empty states: a filtered view says what is empty, and the
  // button always offers a way forward.
  if (!visible.length) {
    const title = document.getElementById("empty-title");
    const text = document.getElementById("empty-text");
    if (allJobs.length === 0) {
      title.textContent = "No downloads yet";
      text.innerHTML = "Press <strong>＋ New Task</strong> above, paste a URL, and press Download.<br />Paused downloads resume — nothing is lost if you close the app.";
    } else {
      title.textContent = "Nothing matches this view";
      text.innerHTML = "Try another filter, or add a new download below.";
    }
  }
  updateBulkBar(visible);

  const visibleIds = new Set(visible.map((job) => job.id));
  for (const [id, card] of [...cards.entries()]) {
    if (!visibleIds.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  for (const job of visible) {
    let card = cards.get(job.id);
    if (!card) {
      card = createCard(job);
      cards.set(job.id, card);
      jobsEl.appendChild(card);
    }
    updateCard(card, job);
  }
}

function refresh() {
  renderJobs(allJobs);
}

jobsEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === "pause") await window.dm.pause(id);
  if (action === "resume") await window.dm.resume(id);
  if (action === "cancel") await window.dm.cancel(id);
  if (action === "details") await window.dm.openDetails(id);
  if (action === "stop-seeding") await window.dm.stopSeeding(id);
  window.dm.list().then(renderJobs);
});

// Row checkboxes feed the multi-select set; the click handler above
// ignores them (they are not buttons).
jobsEl.addEventListener("change", (event) => {
  const box = event.target.closest("[data-select]");
  if (!box) return;
  if (box.checked) selectedIds.add(box.dataset.select);
  else selectedIds.delete(box.dataset.select);
  updateBulkBar(filteredJobs());
});

async function submitDownload() {
  const url = urlEl.value.trim();
  errorEl.textContent = "";
  if (!url) {
    errorEl.textContent = "Enter a URL first.";
    urlEl.focus();
    return;
  }
  try {
    const queueId = document.getElementById("queue").value || "main";
    const expectedHash = document.getElementById("expected-hash").value.trim();
    if (url.startsWith("magnet:") || /^https?:\/\/\S+\.torrent(?:[?#]|$)/i.test(url)) {
      await window.dm.addTorrent(url, { queueId });
    } else if (document.getElementById("live-stream").checked) {
      await window.dm.addStream(url, { live: true, queueId });
    } else {
      const seg = Number(segmentsEl.value);
      const mirrors = document.getElementById("mirrors").value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      await window.dm.add(url, {
        segments: Number.isNaN(seg) ? 8 : seg,
        speedLimitBytesPerSec: Number(limitEl.value) || 0,
        ...(categoryEl.value ? { category: categoryEl.value } : {}),
        queueId,
        ...(expectedHash ? { expectedHash } : {}),
        ...(mirrors.length ? { mirrorUrls: mirrors } : {}),
      });
    }
    urlEl.value = "";
    document.getElementById("expected-hash").value = "";
    document.getElementById("mirrors").value = "";
    document.getElementById("live-stream").checked = false;
    addCard.classList.add("hidden");
    window.dm.list().then(renderJobs);
  } catch (error) {
    errorEl.textContent = error?.message ?? String(error);
  }
}
// Clipboard monitor (feature 5) + drag & drop (feature 7): a copied
// or dropped link prefills New Task instead of auto-downloading.
window.dm.onClipboardUrl((url) => {
  showDownloadsView();
  urlEl.value = url;
  addCard.classList.remove("hidden");
  showToast("Link copied — press Download to start it");
  urlEl.focus();
});
const dropOverlay = document.getElementById("drop-overlay");
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  dropOverlay.classList.remove("hidden");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add("hidden");
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
  const data = event.dataTransfer;
  const text = (data.getData("text/uri-list") || data.getData("text/plain") || "").trim().split(/\r?\n/)[0];
  const match = /(https?|ftp):\/\/\S+/i.exec(text);
  if (!match) return;
  const url = match[0];
  showDownloadsView();
  if (/youtube\.com\/watch|youtu\.be\//i.test(url)) {
    ytUrlEl.value = url;
    openYtCard();
  } else {
    urlEl.value = url;
    addCard.classList.remove("hidden");
    urlEl.focus();
  }
});
document.getElementById("add").addEventListener("click", submitDownload);
urlEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitDownload();
});

/* ---- Figma toolbar actions ---- */
document.getElementById("options-btn").addEventListener("click", openSettings);
document.getElementById("resume-all").addEventListener("click", async () => {
  for (const job of allJobs.filter((j) => j.status === "paused")) await window.dm.resume(job.id);
  window.dm.list().then(renderJobs);
});
document.getElementById("pause-all").addEventListener("click", async () => {
  for (const job of allJobs.filter((j) => j.status === "downloading" || j.status === "queued")) await window.dm.pause(job.id);
  window.dm.list().then(renderJobs);
});
document.getElementById("clear-completed").addEventListener("click", async () => {
  for (const job of allJobs.filter((j) => j.status === "completed")) await window.dm.cancel(job.id);
  window.dm.list().then(renderJobs);
});

/* ---- Figma row context menu (right-click) ---- */
const ctxMenu = document.getElementById("ctx-menu");
let ctxJobId = null;
function hideCtx() {
  ctxMenu.classList.add("hidden");
  ctxJobId = null;
}
jobsEl.addEventListener("contextmenu", (event) => {
  const card = event.target.closest(".job-card");
  if (!card) return;
  event.preventDefault();
  const job = allJobs.find((candidate) => candidate.id === card.dataset.jobId);
  if (!job) return;
  ctxJobId = job.id;
  const canOpen = job.status === "completed";
  const toggle = job.status === "paused"
    ? `<button data-ctx="resume">▶ Resume Download</button>`
    : `<button data-ctx="pause" ${job.status === "downloading" || job.status === "queued" ? "" : "disabled"}>⏸ Pause Download</button>`;
  const queueButtons = queueList.map((q) =>
    `<button data-ctx="move:${q.id}" ${(job.queueId || "main") === q.id ? "disabled" : ""}>▤ Move to ${escapeHtml(q.name)}</button>`).join("");
  ctxMenu.innerHTML = `
    <button data-ctx="open" ${canOpen ? "" : "disabled"}>↗ Open</button>
    <button data-ctx="folder">▤ Open Folder</button>
    <hr class="ctx-sep" />
    ${toggle}
    <button data-ctx="details">ℹ Properties</button>
    <hr class="ctx-sep" />
    ${queueButtons}
    <hr class="ctx-sep" />
    <button data-ctx="delete" class="danger">🗑 Delete</button>`;
  ctxMenu.classList.remove("hidden");
  const width = 230;
  const height = 260;
  ctxMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 10))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 10))}px`;
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#ctx-menu")) hideCtx();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideCtx();
});
ctxMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-ctx]");
  if (!button || !ctxJobId) return;
  const action = button.dataset.ctx;
  const id = ctxJobId;
  hideCtx();
  if (action.startsWith("move:")) {
    await window.dm.moveJob(id, action.slice("move:".length));
    await refreshQueues();
    window.dm.list().then(renderJobs);
    return;
  }
  if (action === "open") await window.dm.openFile(id);
  if (action === "folder") await window.dm.openJobFolder(id);
  if (action === "pause") await window.dm.pause(id);
  if (action === "resume") await window.dm.resume(id);
  if (action === "delete") await window.dm.cancel(id);
  if (action === "details") await window.dm.openDetails(id);
  window.dm.list().then(renderJobs);
});

/* ---- Figma Disk Space card (sidebar) ---- */
async function refreshDisk() {
  try {
    const disk = await window.dm.diskSpace();
    if (!disk || !disk.totalBytes) throw new Error("no disk info");
    const used = Math.round(100 * (1 - disk.freeBytes / disk.totalBytes));
    document.getElementById("disk-bar-fill").style.width = `${used}%`;
    document.getElementById("disk-text").textContent =
      `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} · ${used}% used`;
  } catch {
    document.getElementById("disk-text").textContent = "Disk space unavailable";
  }
}
refreshDisk();
setInterval(refreshDisk, 60000);

/* ---- YouTube downloader card ---- */
const ytCard = document.getElementById("yt-card");
const ytUrlEl = document.getElementById("yt-url");
const ytStatusEl = document.getElementById("yt-status");
const ytInfoEl = document.getElementById("yt-info");
let ytInfo = null;
let ytKind = "video";

function setYtStatus(text, isError) {
  ytStatusEl.textContent = text;
  ytStatusEl.style.color = isError ? "var(--red)" : "";
}
/* Returns the fresh tool state (or null when it cannot be checked).
 * Callers that act on tools must use this fresh result, never a
 * status line rendered earlier — that is exactly how stale warnings
 * (OmniGet's stuck "yt-dlp is missing" banner) happen. */
async function refreshYtTools() {
  try {
    const tools = await window.dm.ytTools();
    const ytOk = tools && tools.ytDlp;
    const ffOk = tools && tools.ffmpeg;
    document.getElementById("yt-tools").textContent =
      `yt-dlp: ${ytOk ? "✓ found" : "✕ missing"} · ffmpeg: ${ffOk ? "✓ found" : "✕ missing (merging, embedding and SponsorBlock need it)"}`;
    document.getElementById("yt-install-ytdlp").classList.toggle("hidden", !!ytOk);
    document.getElementById("yt-install-ffmpeg").classList.toggle("hidden", !!ffOk);
    return tools;
  } catch {
    document.getElementById("yt-tools").textContent = "Tool status unavailable.";
    return null;
  }
}
function openYtCard() {
  showDownloadsView();
  collapseYtAdvanced();
  ytCard.classList.remove("hidden");
  refreshYtTools();
  ytUrlEl.focus();
}
const collapseYtAdvanced = wireAdvancedToggle("yt-advanced-toggle", "yt-advanced");
document.getElementById("yt-task").addEventListener("click", openYtCard);
document.getElementById("yt-close").addEventListener("click", () => ytCard.classList.add("hidden"));
document.getElementById("yt-cancel").addEventListener("click", () => {
  ytUrlEl.value = "";
  setYtStatus("");
  ytCard.classList.add("hidden");
});
document.getElementById("yt-kind-segmented").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-yt-kind]");
  if (!btn) return;
  ytKind = btn.dataset.ytKind;
  document.querySelectorAll("#yt-kind-segmented button").forEach((b) =>
    b.classList.toggle("active", b === btn));
  const isVideo = ytKind === "video";
  document.getElementById("yt-video-quality-field").classList.toggle("hidden", !isVideo);
  document.getElementById("yt-container-field").classList.toggle("hidden", !isVideo);
  document.getElementById("yt-audio-format-field").classList.toggle("hidden", isVideo);
  document.getElementById("yt-audio-quality-field").classList.toggle("hidden", isVideo);
});
document.getElementById("yt-fetch").addEventListener("click", async () => {
  const url = ytUrlEl.value.trim();
  if (!url) {
    setYtStatus("Paste a YouTube URL first.", true);
    ytUrlEl.focus();
    return;
  }
  setYtStatus("Fetching info…");
  ytInfoEl.classList.add("hidden");
  try {
    ytInfo = await window.dm.ytInfo(url);
    document.getElementById("yt-thumb").src = ytInfo.thumbnail || "";
    document.getElementById("yt-title").textContent = ytInfo.title;
    const parts = [];
    if (ytInfo.uploader) parts.push(ytInfo.uploader);
    if (ytInfo.durationSeconds != null) parts.push(formatEta(ytInfo.durationSeconds));
    if (ytInfo.isPlaylist) parts.push(`Playlist · ${ytInfo.playlistCount ?? "?"} videos`);
    if (ytInfo.heights.length) parts.push(`Up to ${ytInfo.heights[0]}p`);
    document.getElementById("yt-meta").textContent = parts.join(" · ");
    ytInfoEl.classList.remove("hidden");
    setYtStatus("");
  } catch (error) {
    ytInfo = null;
    setYtStatus(error?.message ?? String(error), true);
  }
});
async function installYtTool(tool, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Downloading…";
  try {
    const result = await window.dm.ytInstallTool(tool);
    if (result.ok) {
      setYtStatus(`${tool === "ytdlp" ? "yt-dlp" : "ffmpeg"} installed.`);
      await refreshYtTools();
    } else {
      setYtStatus(result.error || "Install failed.", true);
    }
  } catch (error) {
    setYtStatus(error?.message ?? String(error), true);
  }
  button.disabled = false;
  button.textContent = original;
}
document.getElementById("yt-install-ytdlp").addEventListener("click", (event) => installYtTool("ytdlp", event.target));
document.getElementById("yt-install-ffmpeg").addEventListener("click", (event) => installYtTool("ffmpeg", event.target));
document.getElementById("yt-download").addEventListener("click", async () => {
  const url = ytUrlEl.value.trim();
  if (!url) {
    setYtStatus("Paste a YouTube URL first.", true);
    ytUrlEl.focus();
    return;
  }
  // Fresh tool check at start time: never create a job on a stale
  // "found" line from when the card was opened. The manager re-checks
  // too, but failing fast here avoids a doomed job + a wrong toast.
  const freshTools = await refreshYtTools();
  if (!freshTools || !freshTools.ytDlp) {
    setYtStatus("yt-dlp is missing — press “Download yt-dlp” above, then try again.", true);
    return;
  }
  const playlistStart = Number(document.getElementById("yt-pl-start").value) || undefined;
  const playlistEnd = Number(document.getElementById("yt-pl-end").value) || undefined;
  const options = {
    kind: ytKind,
    quality: document.getElementById("yt-quality").value,
    container: document.getElementById("yt-container").value,
    audioFormat: document.getElementById("yt-audio-format").value,
    audioQuality: document.getElementById("yt-audio-quality").value,
    subtitles: document.getElementById("yt-subs").checked
      ? [document.getElementById("yt-sub-lang").value]
      : [],
    autoSubtitles: document.getElementById("yt-auto-subs").checked,
    embedSubtitles: document.getElementById("yt-embed-subs").checked,
    playlist: document.getElementById("yt-playlist").checked,
    ...(playlistStart ? { playlistStart } : {}),
    ...(playlistEnd ? { playlistEnd } : {}),
    embedThumbnail: document.getElementById("yt-embed-thumb").checked,
    embedMetadata: document.getElementById("yt-embed-meta").checked,
    sponsorBlock: document.getElementById("yt-sponsorblock").checked,
    concurrentFragments: Number(document.getElementById("yt-fragments").value) || 1,
    cookiesFromBrowser: document.getElementById("yt-cookies-browser").value,
    ...(ytCookiesFile ? { cookiesFile: ytCookiesFile } : {}),
  };
  try {
    await window.dm.ytAdd(url, {
      options,
      queueId: document.getElementById("queue").value || "main",
      ...(ytInfo ? { title: ytInfo.title, videoId: ytInfo.id } : {}),
    });
    ytCard.classList.add("hidden");
    showToast("YouTube download added");
    window.dm.list().then(renderJobs);
  } catch (error) {
    setYtStatus(error?.message ?? String(error), true);
  }
});

/* ---- Site grabber (feature 6) ---- */
const grabCard = document.getElementById("grab-card");
const grabUrlEl = document.getElementById("grab-url");
const grabStatusEl = document.getElementById("grab-status");
const grabListEl = document.getElementById("grab-list");
let grabbedLinks = [];
function renderGrabList() {
  const filter = document.getElementById("grab-filter").value;
  const visible = filter === "all" ? grabbedLinks : grabbedLinks.filter((l) => l.kind === filter);
  document.getElementById("grab-count").textContent = `${visible.length} links`;
  grabListEl.innerHTML = visible.map((link, i) => {
    const index = grabbedLinks.indexOf(link);
    return `<label class="grab-row"><input type="checkbox" data-grab-index="${index}" checked />
      <span class="grab-kind">${escapeHtml(link.kind)}</span>
      <span class="grab-name" title="${escapeHtml(link.url)}">${escapeHtml(link.filename)}</span></label>`;
  }).join("") || `<p class="save-note">No links of this type on the page.</p>`;
  void i;
}
document.getElementById("grab-task").addEventListener("click", () => {
  showDownloadsView();
  grabCard.classList.remove("hidden");
  grabUrlEl.focus();
});
document.getElementById("grab-close").addEventListener("click", () => grabCard.classList.add("hidden"));
document.getElementById("grab-cancel").addEventListener("click", () => {
  grabUrlEl.value = "";
  grabStatusEl.textContent = "";
  grabListEl.innerHTML = "";
  grabbedLinks = [];
  grabCard.classList.add("hidden");
});
document.getElementById("grab-fetch").addEventListener("click", async () => {
  const pageUrl = grabUrlEl.value.trim();
  if (!pageUrl) {
    grabStatusEl.textContent = "Paste a page URL first.";
    grabUrlEl.focus();
    return;
  }
  grabStatusEl.textContent = "Fetching page…";
  try {
    grabbedLinks = await window.dm.grab(pageUrl);
    document.getElementById("grab-tools").classList.remove("hidden");
    grabStatusEl.textContent = grabbedLinks.length
      ? `Found ${grabbedLinks.length} downloadable links. Tick the ones you want.`
      : "No downloadable links found on that page.";
    renderGrabList();
  } catch (error) {
    grabStatusEl.textContent = error?.message ?? String(error);
  }
});
document.getElementById("grab-filter").addEventListener("change", renderGrabList);
document.getElementById("grab-all").addEventListener("click", () => {
  grabListEl.querySelectorAll("input[type='checkbox']").forEach((box) => { box.checked = true; });
});
document.getElementById("grab-none").addEventListener("click", () => {
  grabListEl.querySelectorAll("input[type='checkbox']").forEach((box) => { box.checked = false; });
});
document.getElementById("grab-download").addEventListener("click", async () => {
  const selected = [...grabListEl.querySelectorAll("input[type='checkbox']:checked")]
    .map((box) => grabbedLinks[Number(box.dataset.grabIndex)])
    .filter(Boolean);
  if (!selected.length) {
    grabStatusEl.textContent = "Tick at least one link first.";
    return;
  }
  grabStatusEl.textContent = `Adding ${selected.length} downloads…`;
  for (const link of selected) {
    try {
      await window.dm.add(link.url, {});
    } catch (error) {
      grabStatusEl.textContent = `Failed for ${link.filename}: ${error?.message ?? String(error)}`;
    }
  }
  grabCard.classList.add("hidden");
  showToast(`${selected.length} downloads added`);
  window.dm.list().then(renderJobs);
});

/* ---- YouTube cookies (feature 14) ---- */
let ytCookiesFile = null;
document.getElementById("yt-cookies-file-btn").addEventListener("click", async () => {
  const file = await window.dm.chooseFile();
  if (file) {
    ytCookiesFile = file;
    document.getElementById("yt-cookies-file-label").textContent = file;
  }
});
document.getElementById("yt-cookies-file-clear").addEventListener("click", () => {
  ytCookiesFile = null;
  document.getElementById("yt-cookies-file-label").textContent = "none";
});

window.dm.onJobs(renderJobs);
window.dm.getSettings().then((got) => {
  if (got) engineSettings = got;
  applySettings();
}).catch(() => undefined);
window.dm.getInfo().then((info) => {
  if (info) document.getElementById("about-version").textContent = `v${info.version}`;
}).catch(() => undefined);
window.dm.list().then(renderJobs);

/* ---- 0.7.0 interactions: multi-select, shortcuts, new settings ---- */
function updateBulkBar(visible) {
  // Drop selections for jobs that no longer exist.
  const live = new Set(allJobs.map((job) => job.id));
  for (const id of [...selectedIds]) if (!live.has(id)) selectedIds.delete(id);
  const bar = document.getElementById("bulk-bar");
  const count = document.getElementById("bulk-count");
  if (!bar || !count) return;
  bar.classList.toggle("hidden", selectedIds.size === 0);
  count.textContent = selectedIds.size ? `${selectedIds.size} selected` : "";
  const selectAll = document.getElementById("select-all");
  if (selectAll) {
    selectAll.checked = visible.length > 0 && visible.every((job) => selectedIds.has(job.id));
  }
}
document.getElementById("select-all").addEventListener("change", (event) => {
  const visible = filteredJobs();
  if (event.target.checked) visible.forEach((job) => selectedIds.add(job.id));
  else visible.forEach((job) => selectedIds.delete(job.id));
  renderJobs(allJobs);
});
async function bulkAction(action) {
  const ids = [...selectedIds];
  for (const id of ids) {
    if (action === "pause") await window.dm.pause(id);
    if (action === "resume") await window.dm.resume(id);
    if (action === "delete") await window.dm.cancel(id);
  }
  if (action === "delete") selectedIds.clear();
  window.dm.list().then(renderJobs);
}
document.getElementById("bulk-pause").addEventListener("click", () => bulkAction("pause"));
document.getElementById("bulk-resume").addEventListener("click", () => bulkAction("resume"));
document.getElementById("bulk-delete").addEventListener("click", () => {
  if (selectedIds.size && window.confirm(`Delete ${selectedIds.size} selected download(s)?`)) bulkAction("delete");
});
document.getElementById("bulk-clear").addEventListener("click", () => {
  selectedIds.clear();
  renderJobs(allJobs);
});
document.getElementById("sort-select").addEventListener("change", (event) => {
  sortMode = event.target.value;
  renderJobs(allJobs);
});
document.getElementById("widget-btn").addEventListener("click", () => window.dm.toggleWidget());
document.getElementById("empty-add").addEventListener("click", () => {
  showDownloadsView();
  addCard.classList.remove("hidden");
  urlEl.focus();
});

// Keyboard shortcuts (see the list in Settings). Typing in a field
// disables Space/Del so they keep their normal meaning there.
document.addEventListener("keydown", async (event) => {
  if (event.ctrlKey && (event.key === "n" || event.key === "N")) {
    event.preventDefault();
    showDownloadsView();
    addCard.classList.remove("hidden");
    urlEl.focus();
    return;
  }
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  if (typing) return;
  if (event.key === " " && selectedIds.size) {
    event.preventDefault();
    const selected = allJobs.filter((job) => selectedIds.has(job.id));
    const anyActive = selected.some((job) => job.status === "downloading" || job.status === "queued");
    for (const job of selected) {
      if (anyActive && (job.status === "downloading" || job.status === "queued")) await window.dm.pause(job.id);
      else if (!anyActive && job.status === "paused") await window.dm.resume(job.id);
    }
    window.dm.list().then(renderJobs);
  }
  if ((event.key === "Delete" || event.key === "Del") && selectedIds.size) {
    event.preventDefault();
    if (window.confirm(`Delete ${selectedIds.size} selected download(s)?`)) bulkAction("delete");
  }
});

// 0.7.0 completion sound + quiet hours (renderer side of prefs).
let audioCtx = null;
function inQuietHours(now = new Date()) {
  const prefs = engineSettings.notificationPrefs || {};
  const parse = (value) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = parse(prefs.quietStart);
  const end = parse(prefs.quietEnd);
  if (start === null || end === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
function playCompletionSound(job) {
  const prefs = engineSettings.notificationPrefs || {};
  if (prefs.sound !== true) return;
  if ((prefs.disabledCategories || []).includes(job.category)) return;
  if (inQuietHours()) return;
  try {
    audioCtx = audioCtx ?? new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const now = audioCtx.currentTime;
    for (const [offset, freq] of [[0, 880], [0.15, 1320]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.15);
    }
  } catch { /* no audio device: stay silent */ }
}

// 0.7.0 settings listeners (engine-side settings go through IPC).
document.getElementById("fontsize-segmented").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-fontsize-value]");
  if (!btn) return;
  settings.fontSize = btn.dataset.fontsizeValue;
  saveSettings();
  applySettings();
});
async function saveEngine(partial) {
  engineSettings = await window.dm.setSettings(partial);
}
document.getElementById("set-sched-enabled").addEventListener("change", async (event) => {
  const current = engineSettings.schedulerPolicy || { enabled: false, windows: [] };
  await saveEngine({ schedulerPolicy: { enabled: event.target.checked, windows: current.windows || [] } });
});
document.getElementById("sched-add").addEventListener("click", async () => {
  const start = document.getElementById("sched-start").value;
  const end = document.getElementById("sched-end").value;
  if (!start || !end) return;
  const current = engineSettings.schedulerPolicy || { enabled: false, windows: [] };
  const windows = [...(current.windows || []), { start, end }];
  await saveEngine({ schedulerPolicy: { enabled: current.enabled, windows } });
  syncSettingsForm();
});
document.getElementById("set-smart-enabled").addEventListener("change", async (event) => {
  const current = engineSettings.smartConfig || {};
  await saveEngine({ smartConfig: { ...current, enabled: event.target.checked } });
});
document.getElementById("set-smart-limit").addEventListener("change", async (event) => {
  const current = engineSettings.smartConfig || {};
  await saveEngine({ smartConfig: { ...current, smartLimitBytesPerSec: Number(event.target.value) || 0 } });
});
document.getElementById("set-smart-watchlist").addEventListener("change", async (event) => {
  const current = engineSettings.smartConfig || {};
  const watchlist = event.target.value.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean);
  await saveEngine({ smartConfig: { ...current, watchlist } });
});
document.getElementById("set-extract").addEventListener("change", (event) => saveEngine({ autoExtract: event.target.checked }));
document.getElementById("set-scan").addEventListener("change", (event) => saveEngine({ defenderScan: event.target.checked }));
document.getElementById("set-seed-enabled").addEventListener("change", async (event) => {
  const current = engineSettings.seedingPolicy || {};
  await saveEngine({ seedingPolicy: { ...current, enabled: event.target.checked } });
});
document.getElementById("set-seed-ratio").addEventListener("change", async (event) => {
  const current = engineSettings.seedingPolicy || {};
  await saveEngine({ seedingPolicy: { ...current, ratioLimit: Number(event.target.value) || 0 } });
});
document.getElementById("set-seed-minutes").addEventListener("change", async (event) => {
  const current = engineSettings.seedingPolicy || {};
  await saveEngine({ seedingPolicy: { ...current, maxMinutes: Number(event.target.value) || 0 } });
});
document.getElementById("set-notif-banners").addEventListener("change", async (event) => {
  const prefs = engineSettings.notificationPrefs || {};
  await saveEngine({ notificationPrefs: { ...prefs, banners: event.target.checked } });
});
document.getElementById("set-notif-sound").addEventListener("change", async (event) => {
  const prefs = engineSettings.notificationPrefs || {};
  await saveEngine({ notificationPrefs: { ...prefs, sound: event.target.checked } });
});
document.getElementById("set-quiet-start").addEventListener("change", async (event) => {
  const prefs = engineSettings.notificationPrefs || {};
  await saveEngine({ notificationPrefs: { ...prefs, quietStart: event.target.value } });
});
document.getElementById("set-quiet-end").addEventListener("change", async (event) => {
  const prefs = engineSettings.notificationPrefs || {};
  await saveEngine({ notificationPrefs: { ...prefs, quietEnd: event.target.value } });
});
async function refreshStats() {
  try {
    const stats = await window.dm.stats();
    if (!stats) return;
    document.getElementById("stat-total").textContent = formatBytes(stats.totalBytes);
    document.getElementById("stat-month").textContent = formatBytes(stats.monthBytes);
    document.getElementById("stat-avg").textContent = stats.averageSpeedBytesPerSec != null
      ? `${formatBytes(Math.round(stats.averageSpeedBytesPerSec))}/s` : "–";
    document.getElementById("stat-jobs").textContent = String(stats.totalJobs);
  } catch { /* stats are informational only */ }
}
document.getElementById("stats-refresh").addEventListener("click", refreshStats);

// 0.7.0 first-run wizard, stepped in 0.7.2 (OmniGet-style): shown until
// Finish or Skip is pressed once. Theme/accent apply live so step 1
// previews the real app; tool status is re-checked fresh every time
// step 3 opens, so the wizard never shows a stale warning.
const wizardOverlay = document.getElementById("wizard-overlay");
const WIZARD_STEP_NAMES = ["Look", "Downloads", "Tools", "Ready"];
let wizardStep = 1;
function showWizardStep(step) {
  wizardStep = Math.max(1, Math.min(4, step));
  for (let n = 1; n <= 4; n++) {
    document.getElementById(`wiz-step-${n}`).classList.toggle("hidden", n !== wizardStep);
  }
  document.getElementById("wiz-step-label").textContent =
    `Step ${wizardStep} of 4 · ${WIZARD_STEP_NAMES[wizardStep - 1]}`;
  document.getElementById("wiz-back").disabled = wizardStep === 1;
  document.getElementById("wiz-next").classList.toggle("hidden", wizardStep === 4);
  document.getElementById("wiz-finish").classList.toggle("hidden", wizardStep !== 4);
  if (wizardStep === 3) void refreshWizardTools();
}
async function refreshWizardTools() {
  const ytdlpEl = document.getElementById("wiz-tool-ytdlp");
  const ffmpegEl = document.getElementById("wiz-tool-ffmpeg");
  ytdlpEl.textContent = "Checking…";
  ffmpegEl.textContent = "Checking…";
  try {
    const tools = await window.dm.ytTools();
    const ytOk = !!(tools && tools.ytDlp);
    const ffOk = !!(tools && tools.ffmpeg);
    ytdlpEl.textContent = ytOk ? "✓ found" : "✕ missing — YouTube downloads need it";
    ffmpegEl.textContent = ffOk ? "✓ found" : "✕ missing — merging and subtitles need it";
    document.getElementById("wiz-install-ytdlp").classList.toggle("hidden", ytOk);
    document.getElementById("wiz-install-ffmpeg").classList.toggle("hidden", ffOk);
  } catch {
    ytdlpEl.textContent = "Status unavailable.";
    ffmpegEl.textContent = "Status unavailable.";
  }
}
window.dm.getSettings().then((got) => {
  if (!got) return;
  if (got.firstRunDone === true) return;
  document.getElementById("wiz-folder").value = got.downloadsDir || "";
  document.getElementById("wiz-limit").value = "";
  document.getElementById("wiz-theme").value = settings.theme || "dark";
  document.getElementById("wiz-segments").value = String(settings.defaultSegments ?? 0);
  document.querySelectorAll("#wiz-accent-swatches button").forEach((b) =>
    b.classList.toggle("active", b.dataset.wizAccentValue === settings.accent));
  showWizardStep(1);
  wizardOverlay.classList.remove("hidden");
}).catch(() => undefined);
document.getElementById("wiz-folder-browse").addEventListener("click", async () => {
  const folder = await window.dm.chooseFolder();
  if (folder) document.getElementById("wiz-folder").value = folder;
});
document.getElementById("wiz-theme").addEventListener("change", (event) => {
  settings.theme = event.target.value;
  saveSettings();
  applySettings();
});
document.getElementById("wiz-accent-swatches").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-wiz-accent-value]");
  if (!btn) return;
  settings.accent = btn.dataset.wizAccentValue;
  saveSettings();
  applySettings();
  document.querySelectorAll("#wiz-accent-swatches button").forEach((b) =>
    b.classList.toggle("active", b === btn));
});
document.getElementById("wiz-install-ytdlp").addEventListener("click", async () => {
  await window.dm.ytInstallTool("yt-dlp").catch(() => undefined);
  await refreshWizardTools();
});
document.getElementById("wiz-install-ffmpeg").addEventListener("click", async () => {
  await window.dm.ytInstallTool("ffmpeg").catch(() => undefined);
  await refreshWizardTools();
});
document.getElementById("wiz-back").addEventListener("click", () => showWizardStep(wizardStep - 1));
document.getElementById("wiz-next").addEventListener("click", () => showWizardStep(wizardStep + 1));
document.getElementById("wiz-skip").addEventListener("click", async () => {
  await window.dm.setSettings({ firstRunDone: true }).catch(() => undefined);
  wizardOverlay.classList.add("hidden");
});
document.getElementById("wiz-finish").addEventListener("click", async () => {
  const folder = document.getElementById("wiz-folder").value.trim();
  const theme = document.getElementById("wiz-theme").value;
  const limit = Number(document.getElementById("wiz-limit").value) || 0;
  const seg = Number(document.getElementById("wiz-segments").value);
  if (folder) await window.dm.setSettings({ downloadsDir: folder });
  settings.theme = theme;
  settings.defaultLimit = limit;
  settings.defaultSegments = Number.isNaN(seg) ? 0 : seg;
  saveSettings();
  applySettings();
  applyFormDefaults();
  await window.dm.setSettings({ firstRunDone: true });
  wizardOverlay.classList.add("hidden");
  window.dm.getSettings().then((got) => { if (got) engineSettings = got; }).catch(() => undefined);
});
