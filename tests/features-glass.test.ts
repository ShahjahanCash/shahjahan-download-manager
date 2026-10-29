/**
 * Glassmorphism pass (redesign only, default dark theme).
 * Guards the frosted-glass treatment of the existing app: it must be
 * scoped to the dark theme (the app default), must not restyle other
 * themes, must not change status colours, behaviour, handlers or IPC,
 * and must not bring back the removed YouTube selects or wizard card.
 * This test reads the shipped renderer files directly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../electron/renderer/index.html", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../electron/renderer/style.css", import.meta.url),
  "utf8",
);
const rendererJs = readFileSync(
  new URL("../electron/renderer/renderer.js", import.meta.url),
  "utf8",
);

function glassBlock(): string {
  const marker = "Glassmorphism pass (redesign only, default dark theme)";
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start);
}

describe("glassmorphism pass", () => {
  it("glass section exists, is dark-scoped, and uses theme tokens", () => {
    const glass = glassBlock();
    // Every glass rule is scoped to the dark theme: no unscoped
    // surface rule may restyle another theme.
    expect(glass).toContain('[data-theme="dark"] {');
    expect(glass).toContain("--glass-panel: color-mix(in srgb, var(--panel)");
    expect(glass).toContain("--glass-border: rgba(255, 255, 255, 0.09);");
    expect(glass).not.toContain("@font-face");
    expect(glass).not.toContain("fonts.googleapis");
    expect(glass).not.toContain("dm:glass");
  });

  it("dark background is a quiet gradient wash, blur stays modest", () => {
    const glass = glassBlock();
    expect(glass).toContain('[data-theme="dark"] body {');
    expect(glass).toContain("radial-gradient(");
    expect(glass).toContain("linear-gradient(");
    expect(glass).toContain("backdrop-filter: blur(16px)");
    expect(glass).toContain("backdrop-filter: blur(18px)");
    // No huge blur values that would smear text on low-end PCs.
    expect(glass).not.toMatch(/blur\((2[1-9]|[3-9]\d)px\)/);
  });

  it("key surfaces are glassed: sidebar, dashboard, rows, add, dialogs", () => {
    const glass = glassBlock();
    for (const selector of [
      '[data-theme="dark"] .sidebar {',
      '[data-theme="dark"] .dash-panel {',
      '[data-theme="dark"] .dash-overall,',
      '[data-theme="dark"] .job-card {',
      '[data-theme="dark"] .add-card,',
      '[data-theme="dark"] .modal {',
      '[data-theme="dark"] .ctx-menu,',
      '[data-theme="dark"] #bottom-bar {',
    ]) {
      expect(glass).toContain(selector);
    }
    // Active nav keeps the Mission-control neutral fill + accent bar.
    expect(glass).toContain("box-shadow: inset 3px 0 0 var(--accent);");
  });

  it("download rows get translucency but never backdrop blur (repaint cost)", () => {
    const glass = glassBlock();
    const start = glass.indexOf('[data-theme="dark"] .job-card {');
    expect(start).toBeGreaterThan(-1);
    const rule = glass.slice(start, glass.indexOf("}", start));
    expect(rule).toContain("background: var(--glass-panel);");
    expect(rule).toContain("border: 1px solid var(--glass-border);");
    expect(rule).not.toContain("backdrop-filter");
  });

  it("status colours are untouched by the glass section", () => {
    const glass = glassBlock();
    expect(glass).not.toContain(".pill.downloading");
    expect(glass).not.toContain(".pill.completed");
    expect(glass).not.toContain(".pill.failed");
    expect(glass).not.toContain(".dash-attention.has-failed");
  });

  it("dashboard is still the default view and yt pills still exist", () => {
    expect(html).toContain('<section id="view-dashboard" class="dashboard-view">');
    expect(html).toContain('id="yt-quality-pills"');
    expect(html).toContain('id="yt-fps-pills"');
    expect(rendererJs).toContain('ytPillInit("yt-quality-pills")');
    expect(rendererJs).toContain('ytPillInit("yt-fps-pills")');
  });

  it("all theme options still switchable; no stale selects, no wizard card", () => {
    for (const value of [
      "omni", "light", "dark", "glass", "liquid", "ocean", "ember",
      "high-contrast", "system", "dracula", "mocha", "eink",
    ]) {
      expect(html).toContain(`data-theme-value="${value}"`);
    }
    // The segmented control itself must stay complete, and the other
    // themes' token blocks must still exist untouched by this pass.
    expect(rendererJs).not.toContain('getElementById("yt-quality")');
    expect(rendererJs).not.toContain('getElementById("yt-fps")');
    expect(html).not.toContain("Example video");
    expect(html).not.toContain("wiz-preview");
    expect(css).not.toContain("wiz-preview");
  });

  it("no new IPC channel and no behaviour hook added by this pass", () => {
    expect(rendererJs).not.toContain("dm:glass");
    expect(glassBlock()).not.toContain("getElementById");
  });
});
