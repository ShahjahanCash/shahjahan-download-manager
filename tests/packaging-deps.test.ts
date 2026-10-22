/**
 * Packaging regression guard (P0, Oct 22, 2026): the 0.6.7 installer
 * crashed on launch because src/engine/proxy.ts imported "undici"
 * while package.json declared no such dependency and electron-builder
 * only packages declared production dependencies — node_modules
 * happened to contain undici in dev (via @electron/get), so tests
 * passed and the packaged app died with ERR_MODULE_NOT_FOUND.
 *
 * This test fails the suite if any bare import in src/ (static or
 * dynamic) is neither a Node builtin nor a declared runtime
 * dependency. scripts/check-packaging.mjs repeats the same scan over
 * the built dist/ output and, when an app.asar exists, verifies every
 * declared dependency is actually inside the packaged artifact.
 */
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const IMPORT_RE =
  /(?:from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\))/g;

function bareImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    found.push(specifier);
  }
  return found;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0]!;
}

describe("packaging: every runtime import is declared", () => {
  it("all bare imports in src/ resolve to a builtin or a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const undeclared: string[] = [];
    for (const file of collectTsFiles(join(root, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of bareImports(source)) {
        const name = packageName(specifier);
        const bare = name.replace(/^node:/, "");
        if (name.startsWith("node:") || builtins.has(bare)) continue;
        if (declared.has(name)) continue;
        undeclared.push(`${file} -> ${specifier}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("undici is a declared runtime dependency (P0 regression)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies?.undici).toBeTruthy();
  });
});
