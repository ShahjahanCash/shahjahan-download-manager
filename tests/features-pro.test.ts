/**
 * Download Manager Pro redesign (Figma Community patterns, app data only).
 * Guards the table layout, status filters, category sidebar, Pro actions
 * row, and the split Size / Downloaded columns. Every control here must
 * reuse an existing handler — nothing in this file may pass with a dead
 * button. This test reads the shipped renderer files directly.
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

function headerSection(): string {
  const start = html.indexOf('<div class="list-header"');
  const end = html.indexOf("</div>", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function proBlock(): string {
  const marker = "Download Manager Pro (Figma Community patterns";
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start);
}

describe("download manager pro table", () => {
  it("header has the reference columns in order, select-all preserved", () => {
    const header = headerSection();
    for (const label of ["Filename", "Size", "Downloaded", "Speed", "Time Left", "Status"]) {
      expect(header).toContain(`>${label}<`);
    }
    expect(header).toContain('id="select-all"');
    const order = ["Filename", "Size", "Downloaded", "Speed", "Time Left", "Status"]
      .map((label) => header.indexOf(`>${label}<`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("status filters follow the reference order and labels", () => {
    for (const value of ["all", "downloading", "paused", "completed", "failed", "queued"]) {
      expect(html).toContain(`data-filter-chip="${value}"`);
    }
    const chips = html.slice(html.indexOf('id="filter-chips"'), html.indexOf('id="category-filter"'));
    const labels = ["All", "Downloading", "Paused", "Completed", "Error", "Queued"];
    const positions = labels.map((label) => chips.indexOf(`>${label}<`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(rendererJs).toContain('downloading: "Downloading"');
  });

  it("sidebar category list uses the real categories and the shared filter state", () => {
    expect(html).toContain('id="cat-nav"');
    for (const value of ["all", "Video", "Audio", "Documents", "Compressed", "Programs", "General"]) {
      expect(html).toContain(`data-cat-filter="${value}"`);
    }
    // No invented "Archive" category: it maps to the existing Compressed.
    expect(html).not.toContain('data-cat-filter="Archive"');
    expect(rendererJs).toContain('document.getElementById("cat-nav")');
    expect(rendererJs).toContain("setCategoryFilter(btn.dataset.catFilter)");
    expect(rendererJs).toContain('#cat-nav [data-cat-filter]');
  });

  it("pro actions reuse existing controls only", () => {
    for (const id of ["pro-add-url", "pro-resume-all", "pro-pause-all", "pro-open-folder"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(">＋ Add URL<");
    expect(html).toContain(">⏸ Stop All<");
    expect(html).toContain(">📂 Open Folder<");
    expect(rendererJs).toContain('document.getElementById("pro-add-url")');
    expect(rendererJs).toContain('document.getElementById("new-task").click();');
    expect(rendererJs).toContain('document.getElementById("resume-all").click();');
    expect(rendererJs).toContain('document.getElementById("pause-all").click();');
    expect(rendererJs).toContain("window.dm.openDownloadsFolder();");
    expect(rendererJs).not.toContain("dm:pro-");
  });

  it("home entry pattern labels the paste field without dropping the old placeholder", () => {
    expect(html).toContain("Paste video link here");
    expect(html).toContain('placeholder="Paste a link or search"');
    expect(html).toContain('id="home-paste"');
  });

  it("cards split size and downloaded into separate table cells", () => {
    expect(rendererJs).toContain('<span class="downloaded"></span>');
    expect(rendererJs).toContain('downloaded: card.querySelector(".downloaded")');
    expect(rendererJs).toContain('setText(el.downloaded, "downloaded"');
    expect(rendererJs).toContain('setText(el.sizes, "sizes"');
  });

  it("list mode lays cards out as table rows; grid mode keeps stacked cards", () => {
    const pro = proBlock();
    expect(pro).toContain("#view-downloads:not(.grid-view) .job-card {");
    expect(pro).toContain("display: grid;");
    expect(pro).toContain("28px 52px minmax(0, 1fr) 100px 120px 100px 100px 100px auto");
    expect(pro).toContain("#view-downloads:not(.grid-view) .list-header {");
    expect(pro).toContain("display: contents;");
    expect(rendererJs).toContain('viewDownloadsEl.classList.toggle("grid-view", gridView)');
    expect(pro).toContain("@media (max-width: 900px)");
    expect(pro).toContain(".sidebar #cat-nav { display: none; }");
  });

  it("pro styling uses theme tokens only, tabular figures, row hover highlight", () => {
    const pro = proBlock();
    expect(pro).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(pro).toContain("var(--panel-2)");
    expect(pro).toContain("var(--border)");
    expect(pro).toContain("font-variant-numeric: tabular-nums;");
    expect(pro).toContain(".disk-card .disk-text { font-variant-numeric: tabular-nums; }");
    expect(pro).toContain(".detail .row { border-bottom: 1px solid var(--border);");
  });

  it("no stale youtube select references and the wizard stays fake-card-free", () => {
    expect(rendererJs).not.toContain('getElementById("yt-quality")');
    expect(rendererJs).not.toContain('getElementById("yt-fps")');
    expect(html).not.toContain("Example video");
    expect(html).not.toContain("wiz-preview");
    expect(css).not.toContain("wiz-preview");
  });
});
