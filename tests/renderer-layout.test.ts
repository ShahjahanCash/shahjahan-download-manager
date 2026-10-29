/**
 * 0.7.1 simplification guard: the New Task dialog and the YouTube panel show
 * only their basic fields by default, with every other field moved into a
 * collapsed "Advanced options" section. Nothing is removed — every field
 * must still exist exactly once, and the advanced sections must start
 * collapsed. This test reads the shipped renderer HTML directly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../electron/renderer/index.html", import.meta.url),
  "utf8",
);

function sectionBetween(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function expectIdOnce(id: string): void {
  const matches = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
  expect(matches.length).toBe(1);
}

describe("new task dialog simplification", () => {
  const advanced = sectionBetween(
    '<div id="add-advanced"',
    '<p class="save-note">Save to: your Downloads folder',
  );

  it("advanced section starts collapsed with a working toggle", () => {
    expect(advanced.startsWith('<div id="add-advanced" class="advanced-section hidden">')).toBe(true);
    expect(html).toContain('id="add-advanced-toggle"');
    expect(html).toContain('aria-controls="add-advanced"');
  });

  it("keeps only URL + Category visible by default", () => {
    expectIdOnce("url");
    expectIdOnce("category");
    for (const id of ["url", "category"]) {
      expect(advanced).not.toContain(`id="${id}"`);
    }
  });

  it("moves every other new-task field into Advanced, without removing any", () => {
    for (const id of ["segments", "limit", "queue", "expected-hash", "live-stream", "mirrors"]) {
      expectIdOnce(id);
      expect(advanced).toContain(`id="${id}"`);
    }
  });
});

describe("youtube panel simplification", () => {
  const advanced = sectionBetween('<div id="yt-advanced"', '<p class="yt-tools"');

  it("advanced section starts collapsed with a working toggle", () => {
    expect(advanced.startsWith('<div id="yt-advanced" class="advanced-section hidden">')).toBe(true);
    expect(html).toContain('id="yt-advanced-toggle"');
    expect(html).toContain('aria-controls="yt-advanced"');
  });

  it("keeps only URL, Type and video quality visible by default", () => {
    for (const id of ["yt-url", "yt-kind-segmented", "yt-quality-pills", "yt-fps-pills"]) {
      expectIdOnce(id);
      expect(advanced).not.toContain(`id="${id}"`);
    }
  });

  it("moves every other youtube field into Advanced, without removing any", () => {
    for (const id of [
      "yt-container",
      "yt-audio-format",
      "yt-audio-quality",
      "yt-subs",
      "yt-playlist",
      "yt-cookies-browser",
      "yt-embed-thumb",
      "yt-embed-meta",
      "yt-sponsorblock",
      "yt-fragments",
    ]) {
      expectIdOnce(id);
      expect(advanced).toContain(`id="${id}"`);
    }
  });

  it("keeps the yt-dlp/ffmpeg status line outside Advanced", () => {
    expectIdOnce("yt-tools");
    expect(advanced).not.toContain('id="yt-tools"');
  });
});

describe("settings search + per-section reset (0.7.2)", () => {
  const settingsModal = sectionBetween(
    '<div id="settings-overlay"',
    '<div id="drop-overlay"',
  );

  it("has one search box", () => {
    expectIdOnce("settings-search");
    expect(settingsModal).toContain('id="settings-search"');
  });

  it("has one reset button per section except Statistics", () => {
    for (const key of [
      "appearance", "downloads", "automation", "queues", "categories",
      "display", "scheduler", "smart", "after", "seeding", "notifications",
    ]) {
      const matches = html.match(new RegExp(`data-reset-section="${key}"`, "g")) ?? [];
      expect(matches.length).toBe(1);
    }
  });
});

describe("details dialog command + engine rows (0.7.2)", () => {
  const dialogHtml = readFileSync(
    new URL("../electron/renderer/dialog.html", import.meta.url),
    "utf8",
  );

  it("has command and engine rows with a copy button", () => {
    for (const id of ["command", "engine", "copy-command"]) {
      const matches = dialogHtml.match(new RegExp(`id="${id}"`, "g")) ?? [];
      expect(matches.length).toBe(1);
    }
  });
});

describe("persistent bottom aggregate bar (0.7.2)", () => {
  it("has a footer bar with status, percent and speed spans", () => {
    for (const id of ["bottom-bar", "bottom-status", "bottom-percent", "bottom-speed"]) {
      const matches = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
      expect(matches.length).toBe(1);
    }
  });
});

describe("theme gallery + typography presets (0.7.2)", () => {
  it("offers the new themes in settings and in the wizard", () => {
    for (const theme of ["dracula", "mocha", "eink"]) {
      expect(html).toContain(`data-theme-value="${theme}"`);
      expect(html).toContain(`<option value="${theme}">`);
    }
  });

  it("has a typography preset select and no fake preview card (removed 0.7.6)", () => {
    expectIdOnce("typography-preset");
    expect(html).toContain('id="typography-preset"');
    expect(html).not.toContain('class="appearance-preview"');
    for (const preset of ["default", "compact", "reading", "custom"]) {
      expect(html).toContain(`<option value="${preset}">`);
    }
  });
});

describe("Liquid Glass theme", () => {
  const css = readFileSync(
    new URL("../electron/renderer/style.css", import.meta.url),
    "utf8",
  );

  it("offers Liquid Glass in settings and in the wizard", () => {
    expect(html).toContain('data-theme-value="liquid"');
    expect(html).toContain('<option value="liquid">');
  });

  it("defines a translucent liquid theme with blur and specular edges", () => {
    expect(css).toContain('[data-theme="liquid"]');
    expect(css).toContain("backdrop-filter: blur(20px) saturate(1.6)");
    expect(css).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.9)");
  });

  it("wraps the theme picker instead of overflowing the modal", () => {
    expect(css).toContain("#theme-segmented { flex-wrap: wrap;");
    expect(css).toContain("#theme-segmented button { flex-shrink: 0; }");
  });
});

describe("stepped first-run wizard (0.7.2)", () => {
  const wizard = sectionBetween(
    '<div id="wizard-overlay"',
    '<div id="settings-overlay"',
  );

  it("has four steps, nav controls and a skip action", () => {
    for (const id of [
      "wiz-step-1", "wiz-step-2", "wiz-step-3", "wiz-step-4",
      "wiz-step-label", "wiz-back", "wiz-next", "wiz-finish", "wiz-skip",
    ]) {
      expectIdOnce(id);
      expect(wizard).toContain(`id="${id}"`);
    }
    expect(wizard).toContain('id="wiz-step-1"');
    // Only step 1 starts visible; the rest start hidden.
    expect(wizard).toContain('<div class="wiz-step" id="wiz-step-1">');
    expect(wizard).toContain('<div class="wiz-step hidden" id="wiz-step-2">');
    expect(wizard).toContain('<div class="wiz-step hidden" id="wiz-step-3">');
    expect(wizard).toContain('<div class="wiz-step hidden" id="wiz-step-4">');
  });

  it("has no fake example download card in the wizard (0.8.1 regression)", () => {
    expect(wizard).not.toContain("Example video");
    expect(wizard).not.toContain("wiz-preview");
  });

  it("keeps the original wizard fields and adds tools + segments", () => {
    for (const id of [
      "wiz-folder", "wiz-folder-browse", "wiz-theme", "wiz-limit",
      "wiz-segments", "wiz-tool-ytdlp", "wiz-tool-ffmpeg",
      "wiz-install-ytdlp", "wiz-install-ffmpeg", "wiz-accent-swatches",
    ]) {
      expectIdOnce(id);
      expect(wizard).toContain(`id="${id}"`);
    }
  });
});

describe("OmniGet-style overhaul (0.7.4)", () => {
  const css074 = readFileSync(
    new URL("../electron/renderer/style.css", import.meta.url),
    "utf8",
  );
  const rendererJs = readFileSync(
    new URL("../electron/renderer/renderer.js", import.meta.url),
    "utf8",
  );

  it("offers the omni theme in settings and in the wizard", () => {
    expect(html).toContain('data-theme-value="omni"');
    expect(html).toContain('<option value="omni">');
    expect(css074).toContain('[data-theme="omni"]');
    expect(css074).toContain("--accent: #f97316");
  });

  it("has Home and Downloads views with a switch mechanism", () => {
    for (const id of ["view-home", "view-downloads", "nav-home", "nav-downloads"]) {
      expectIdOnce(id);
    }
    expect(rendererJs).toContain("function showHomeView()");
    expect(rendererJs).toContain("function showDownloadsView()");
  });

  it("has a Home paste pill, preview card and Download button", () => {
    for (const id of ["home-url", "home-paste", "home-preview", "home-download"]) {
      expectIdOnce(id);
    }
    expect(html).toContain('placeholder="Paste a link or search"');
  });

  it("has filter chips and a Downloads-view speed control", () => {
    for (const chip of ["all", "downloading", "queued", "completed", "paused", "failed"]) {
      expect(html).toContain(`data-filter-chip="${chip}"`);
    }
    expectIdOnce("category-filter");
    expectIdOnce("view-limit");
  });

  it("has a bottom mini-bar View downloads action", () => {
    expectIdOnce("bottom-view-downloads");
  });

  it("constrains the smart watchlist textarea inside the modal", () => {
    expect(html).toContain('id="set-smart-watchlist"');
    expect(css074).toContain("textarea#set-smart-watchlist");
    expect(css074).toContain("max-width: 100%");
  });
});

describe("0.7.5 home preview, YouTube routing and smoothness", () => {
  const css075 = readFileSync(
    new URL("../electron/renderer/style.css", import.meta.url),
    "utf8",
  );
  const rendererJs075 = readFileSync(
    new URL("../electron/renderer/renderer.js", import.meta.url),
    "utf8",
  );

  it("fetches preview metadata on paste and debounced typing, with a loading state", () => {
    expect(rendererJs075).toContain('homeUrlEl.addEventListener("paste"');
    expect(rendererJs075).toContain("homePreviewTimer");
    expect(rendererJs075).toContain("Loading preview…");
    expect(rendererJs075).toContain("Preview couldn't load — Download still works.");
  });

  it("routes Home YouTube links to the YouTube card, never plain HTTP, and lets the user pick quality first", () => {
    // 0.7.9: the card opens with the URL + preview metadata, but the
    // download no longer auto-starts — the user picks Video/Audio and
    // the quality in the card, then presses its Download.
    expect(rendererJs075).toContain("ytInfo = homeYtInfo");
    expect(rendererJs075).toContain("openYtCard()");
    expect(rendererJs075).not.toContain('yt-download").click()');
  });

  it("YouTube card offers video quality and audio-only choices", () => {
    const html075 = readFileSync(
      new URL("../electron/renderer/index.html", import.meta.url),
      "utf8",
    );
    for (const id of ["yt-kind-segmented", "yt-quality-pills", "yt-fps-pills", "yt-audio-format", "yt-audio-quality"]) {
      expect(html075).toContain(`id="${id}"`);
    }
  });

  it("YouTube quality and frame rate are explicit pill rows with the same values as before", () => {
    const html075 = readFileSync(
      new URL("../electron/renderer/index.html", import.meta.url),
      "utf8",
    );
    for (const value of ["best", "2160", "1440", "1080", "720", "480", "360"]) {
      expect(html075).toContain(`data-yt-quality="${value}"`);
    }
    for (const value of ["best", "60", "30"]) {
      expect(html075).toContain(`data-yt-fps="${value}"`);
    }
    expect(html075).toContain('data-yt-quality="1080" aria-pressed="true" class="active"');
    expect(html075).toContain('data-yt-fps="best" aria-pressed="true" class="active"');
    expect(rendererJs075).toContain('document.querySelector("#yt-quality-pills button.active")?.dataset.ytQuality');
    expect(rendererJs075).toContain('document.querySelector("#yt-fps-pills button.active")?.dataset.ytFps');
  });

  it("home shortcut chips and dashboard progress ring exist and are wired to real controls", () => {
    for (const id of ["home-chip-yt", "home-chip-grab", "home-chip-import", "dash-ring-fill", "dash-ring-text"]) {
      expectIdOnce(id);
    }
    expect(rendererJs075).toContain('document.getElementById("home-chip-yt")');
    expect(rendererJs075).toContain('document.getElementById("home-chip-import")');
    expect(rendererJs075).toContain('dashEls.ringFill');
    expect(rendererJs075).toContain('dashEls.ringText');
  });

  it("routes generic New Task YouTube links to the YouTube card, not plain HTTP", () => {
    // 0.7.9: same rule as Home and drag & drop — the generic form
    // must not fetch a watch page as a file. The card is where the
    // user picks Video/Audio and quality before downloading.
    const submitBody = rendererJs075.slice(
      rendererJs075.indexOf("async function submitDownload"),
      rendererJs075.indexOf("window.dm.add("),
    );
    expect(submitBody).toContain("youtube");
    expect(submitBody).toContain("openYtCard()");
  });

  it("keeps the omni migration one-time so existing installs see the new look once", () => {
    expect(rendererJs075).toContain('const OMNI_MIGRATION_KEY = "sdm-omni-migrated"');
    expect(rendererJs075).toContain('settings.theme = "omni"');
  });

  it("renders disk space on two deliberate lines instead of one wrapping string", () => {
    expectIdOnce("disk-free");
    expectIdOnce("disk-used");
    expect(rendererJs075).toContain('getElementById("disk-free")');
    expect(rendererJs075).toContain('getElementById("disk-used")');
  });

  it("fades views in instead of snapping", () => {
    expect(css075).toContain("@keyframes view-fade");
    expect(css075).toContain("#view-home:not(.hidden)");
  });
});

describe("0.7.6 preview timeout, no duplicate buttons, simple downloads, no settings preview", () => {
  const css076 = readFileSync(
    new URL("../electron/renderer/style.css", import.meta.url),
    "utf8",
  );
  const rendererJs076 = readFileSync(
    new URL("../electron/renderer/renderer.js", import.meta.url),
    "utf8",
  );

  it("caps the Home preview fetch so it cannot hang on Loading preview", () => {
    expect(rendererJs076).toContain("ytInfoForPreview");
    expect(rendererJs076).toContain("preview timed out");
    expect(rendererJs076).toContain("20000");
  });

  it("hides the top-bar trio on Home so actions appear only once per view", () => {
    expect(rendererJs076).toContain('document.body.classList.toggle("on-home-view"');
    expect(css076).toContain("body.on-home-view #yt-task");
    expect(css076).toContain("body.on-home-view #new-task");
  });

  it("puts bulk actions behind one menu and hides stats by default", () => {
    expect(html).not.toContain("action-toolbar");
    expectIdOnce("actions-menu-btn");
    expectIdOnce("actions-menu");
    expectIdOnce("graph-toggle");
    expectIdOnce("download-stats");
    expect(html).toContain('class="stats collapsed"');
    for (const id of ["resume-all", "pause-all", "clear-completed", "widget-btn", "options-btn", "sort-select"]) {
      expectIdOnce(id);
    }
    expect(rendererJs076).toContain("closeActionsMenu");
  });

  it("has no fake example card left in Settings", () => {
    expect(html).not.toContain("appearance-preview");
    expect(css076).not.toContain(".appearance-preview");
  });
});

describe("0.7.7 startup + render-path efficiency (general smoothness)", () => {
  const rendererJs077 = readFileSync(
    new URL("../electron/renderer/renderer.js", import.meta.url),
    "utf8",
  );
  const mainJs = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  );

  it("opens the window before restoring the queue, and the quit path waits for restore", () => {
    const boot = mainJs.slice(
      mainJs.indexOf("app.whenReady().then"),
      mainJs.indexOf('console.log("Shahjahan Download Manager window ready")'),
    );
    expect(boot.indexOf("createMainWindow();")).toBeGreaterThan(-1);
    expect(boot.indexOf("createMainWindow();")).toBeLessThan(boot.indexOf("manager.restoreQueue()"));
    expect(mainJs).toContain("queueRestored = manager.restoreQueue()");
    expect(mainJs).toContain("if (queueRestored) await queueRestored.catch(() => undefined);");
  });

  it("caches static render-path elements once instead of querying per refresh", () => {
    for (const [name, id] of [["bottomStatusEl", "bottom-status"], ["bottomPercentEl", "bottom-percent"], ["bottomSpeedEl", "bottom-speed"], ["statSpeedEl", "stat-speed"], ["statActiveEl", "stat-active"], ["statDoneEl", "stat-done"], ["listHeaderEl", "list-header"], ["bulkBarEl", "bulk-bar"], ["bulkCountEl", "bulk-count"], ["selectAllEl", "select-all"], ["speedGraphEl", "speed-graph"]]) {
      expect(rendererJs077).toContain(`const ${name} = document.getElementById("${id}")`);
    }
    expect(rendererJs077).toContain("const countEls = {}");
    expect(rendererJs077).toContain("if (bottomStatusEl) bottomStatusEl.textContent = status;");
    expect(rendererJs077).toContain("statSpeedEl.textContent = ");
    expect(rendererJs077).toContain("listHeaderEl.classList.toggle(");
  });
});

describe("complete redesign: transfer-desk layout", () => {
  const css = readFileSync(
    new URL("../electron/renderer/style.css", import.meta.url),
    "utf8",
  );
  const rendererJs = readFileSync(
    new URL("../electron/renderer/renderer.js", import.meta.url),
    "utf8",
  );
  // The redesign block is the LAST block in the stylesheet, so its
  // rules win at equal specificity over earlier rules.
  const redesign = css.slice(css.indexOf("Complete redesign: \"Transfer desk\""));

  it("empty Downloads view offers its own New Task action", () => {
    expectIdOnce("empty-new-task");
    expect(html).toContain('id="empty-new-task" class="download-btn"');
    expect(rendererJs).toContain(
      'document.getElementById("empty-new-task").addEventListener("click"',
    );
    expect(rendererJs).toContain('document.getElementById("new-task").click();');
  });

  it("active nav is a neutral fill with a 3px accent bar, not an accent flood", () => {
    expect(redesign).toContain(".nav-item.active { background: var(--panel);");
    expect(redesign).toContain("box-shadow: inset 3px 0 0 var(--accent);");
  });

  it("filter chips are underline tabs, not pills", () => {
    expect(redesign).toContain(".chip { background: transparent;");
    expect(redesign).toContain("border-bottom: 2px solid transparent;");
    expect(redesign).toContain("border-bottom-color: var(--accent);");
  });

  it("stats strip puts the label above the value and job progress is a full-width foot track", () => {
    expect(redesign).toContain(".toolbar .stat-label { order: -1;");
    expect(redesign).toContain(".toolbar .stats { order: 3; grid-column: 1 / -1;");
    expect(redesign).toContain(".bar { height: 10px; margin-top: 12px; }");
    expect(redesign).toContain(".job-meta-line .pct { font-size: 20px;");
  });

  it("Home is a left-aligned command panel, not a centred hero", () => {
    expect(redesign).toContain(".home-hero { background: var(--panel);");
    expect(redesign).toContain(".home-title { font-size: 30px;");
    expect(redesign).toContain("text-align: left;");
    expect(redesign).toContain(".home-actions { justify-content: flex-start;");
  });

  it("the superseded 0.8.2 CSS-only block is gone and the wizard stays fake-card-free", () => {
    expect(css).not.toContain("0.8.2 visible redesign");
    expect(html).not.toContain("Example video");
    expect(html).not.toContain("wiz-preview");
    expect(css).not.toContain("wiz-preview");
  });
});

describe("premium redesign: dashboard, settings nav, details actions", () => {
  const css = readFileSync(
    new URL("../electron/renderer/style.css", import.meta.url),
    "utf8",
  );
  const rendererJs = readFileSync(
    new URL("../electron/renderer/renderer.js", import.meta.url),
    "utf8",
  );
  const dialogHtml = readFileSync(
    new URL("../electron/renderer/dialog.html", import.meta.url),
    "utf8",
  );
  const dialogJs = readFileSync(
    new URL("../electron/renderer/dialog.js", import.meta.url),
    "utf8",
  );

  it("has a Dashboard view and nav entry, default-visible, with Home hidden", () => {
    expectIdOnce("nav-dashboard");
    expectIdOnce("view-dashboard");
    expect(html).toContain('id="view-dashboard" class="dashboard-view"');
    expect(html).toContain('id="view-home" class="home-view hidden"');
    expect(rendererJs).toContain("function showDashboardView()");
    expect(rendererJs).toContain("function renderDashboard(jobs)");
  });

  it("dashboard shows live aggregates and quick actions wired to real controls", () => {
    for (const id of [
      "dash-total", "dash-active", "dash-completed", "dash-failed",
      "dash-speed", "dash-eta", "dash-overall-fill", "dash-ring-fill", "dash-ring-text", "dash-recent",
      "dash-view-failed", "dash-new-task", "dash-yt", "dash-grab", "dash-import",
    ]) {
      expectIdOnce(id);
    }
    // Quick actions reuse the existing buttons/handlers — no parallel
    // add paths, no fake data source.
    expect(rendererJs).toContain('document.getElementById("new-task").click()');
    expect(rendererJs).toContain('document.getElementById("import-txt").click()');
    expect(rendererJs).toContain('setStatusFilter("failed")');
  });

  it("settings has a category nav and a browser-integration info section, not fake toggles", () => {
    for (const target of [
      "appearance-section", "downloads-section", "automation-section",
      "queues-section", "notifications-section", "browser-section",
      "seeding-section", "statistics-section", "shortcuts-section", "about-section",
    ]) {
      expect(html).toContain(`data-settings-target="${target}"`);
    }
    expectIdOnce("browser-section");
    const browser = sectionBetween(
      '<h3 class="settings-section" id="browser-section">',
      '<h3 class="settings-section" id="shortcuts-section">',
    );
    expect(browser).toContain("chrome://extensions");
    expect(browser).not.toContain('type="checkbox"');
    expect(browser).not.toContain("data-reset-section");
  });

  it("details dialog has real pause/resume/retry wired to the shared bridge", () => {
    for (const id of ["dlg-pause", "dlg-resume", "dlg-retry"]) {
      const matches = dialogHtml.match(new RegExp(`id="${id}"`, "g")) ?? [];
      expect(matches.length).toBe(1);
    }
    expect(dialogJs).toContain("window.dm.pause(jobId)");
    expect(dialogJs).toContain("window.dm.resume(jobId)");
  });

  it("add card has paste + an honest destination line; queues show counts and rename", () => {
    expectIdOnce("url-paste");
    expectIdOnce("add-dest");
    expect(rendererJs).toContain("navigator.clipboard.readText()");
    expect(rendererJs).toContain("data-queue-count");
    expect(rendererJs).toContain("dm.renameQueue");
  });

  it("wizard stays fake-card-free and newly hidden-toggled elements have rules", () => {
    expect(html).not.toContain("Example video");
    expect(html).not.toContain("wiz-preview");
    expect(css).toContain("#view-dashboard.hidden");
    expect(css).toContain(".dlg-actions .hidden");
  });
});
