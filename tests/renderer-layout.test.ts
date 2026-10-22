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
    for (const id of ["yt-url", "yt-kind-segmented", "yt-quality"]) {
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

  it("has a typography preset select and a live preview card", () => {
    expectIdOnce("typography-preset");
    expect(html).toContain('id="typography-preset"');
    expect(html).toContain('class="appearance-preview"');
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
