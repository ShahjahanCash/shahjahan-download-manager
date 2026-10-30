import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 1.0.4 Phase 4: release asar must not ship source maps, while dev
// builds keep them (tsconfig sourceMap stays true for debugging).
// This test guards the electron-builder config only; the packaged
// asar itself is checked after `npm run dist:win:dir` (see plan gate).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("packaging: source maps excluded from release asar (1.0.4 Phase 4)", () => {
  it("electron-builder files exclude *.map", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const files: string[] = pkg.build?.files ?? [];
    expect(files).toContain("!**/*.map");
  });

  it("tsconfig still emits source maps for dev builds", () => {
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions?.sourceMap).toBe(true);
  });

  it("no minify is configured for this release", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // electron-builder has no minify by default; guard against a
    // future minify flag/dependency being added silently.
    expect(JSON.stringify(pkg.build ?? {})).not.toMatch(/minif/i);
  });
});
