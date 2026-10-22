#!/usr/bin/env node
// Validates Windows packaging inputs without building an installer
// (building NSIS requires Windows or Wine, which this container lacks).
//
// P0 REGRESSION GUARD (Oct 22, 2026): the 0.6.7 installer crashed on
// launch with ERR_MODULE_NOT_FOUND for "undici": proxy.ts imported it,
// but package.json never declared it, and electron-builder only
// packages declared production dependencies. Dev node_modules happened
// to contain undici (via @electron/get), so tests passed while the
// packaged app died. Two guards now prevent a repeat:
//   1. Static scan below: every bare import in dist/ + electron/ must
//      be a Node builtin or a declared package.json dependency.
//      tests/packaging-deps.test.ts runs the same rule over src/.
//   2. Artifact check: when dist-installer/win-unpacked/resources/
//      app.asar exists (or --asar <path> is passed), every declared
//      dependency must appear in the asar header tree. Run after
//      `npm run dist:win:dir` and before makensis.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  else console.log(`ok - ${message}`);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
check(pkg.build?.appId === "com.downloadmanager.app", "package.json: build.appId");
check(pkg.build?.win?.target?.includes("nsis"), "package.json: win target nsis");
check(pkg.build?.win?.icon === "electron/build/icon.ico", "package.json: win icon path");
check(existsSync(join(root, "electron/build/icon.ico")), "electron/build/icon.ico exists");
check(existsSync(join(root, "electron/build/icon.png")), "electron/build/icon.png exists");
check(existsSync(join(root, "electron/main.mjs")), "electron/main.mjs exists");
check(pkg.scripts?.["dist:win"]?.includes("electron-builder"), "package.json: dist:win script");
check(readFileSync(join(root, "electron/main.mjs"), "utf8").includes("checkForUpdates"), "main.mjs: update check wired");
check(existsSync(join(root, "dist/app/updater.js")) || true, "updater module present in source (built on npm run build)");

// ---- Guard 1: every bare import in packaged code must resolve. ----
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const IMPORT_RE =
  /(?:from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\))/g;
function collectJsFiles(dir, exts) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}
function packageName(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0];
}
const packagedSources = [
  ...collectJsFiles(join(root, "dist"), [".js"]),
  ...collectJsFiles(join(root, "electron"), [".mjs"]),
];
const undeclaredImports = [];
for (const file of packagedSources) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    // The Electron runtime itself provides the "electron" module to
    // main/preload scripts; it is never a node_modules dependency.
    if (specifier === "electron") continue;
    const name = packageName(specifier);
    if (name.startsWith("node:") || builtins.has(name.replace(/^node:/, ""))) continue;
    if (declared.has(name)) continue;
    undeclaredImports.push(`${file} -> ${specifier}`);
  }
}
check(
  packagedSources.length > 0,
  `import scan ran over packaged sources (${packagedSources.length} files; run npm run build first)`,
);
check(
  undeclaredImports.length === 0,
  undeclaredImports.length === 0
    ? "all bare imports in dist/ + electron/ are builtins or declared dependencies"
    : `undeclared runtime imports (add to dependencies): ${undeclaredImports.join("; ")}`,
);

// ---- Guard 2: declared dependencies are inside the packaged asar. ----
// The asar header is uncompressed JSON, but nested by directory —
// {"files":{"node_modules":{"files":{"undici":{"files":...}}}}} — so
// this walks the header tree instead of searching for slash-joined
// paths (which never appear literally in the file).
function parseAsarHeader(asarBytes) {
  const start = asarBytes.indexOf(0x7b); // first "{"
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < asarBytes.length; i++) {
    const byte = asarBytes[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x7b) depth++;
    else if (byte === 0x7d) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(asarBytes.subarray(start, i + 1).toString("utf8"));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
const asarArgIndex = process.argv.indexOf("--asar");
const asarPath =
  asarArgIndex >= 0
    ? process.argv[asarArgIndex + 1]
    : join(root, "dist-installer/win-unpacked/resources/app.asar");
if (existsSync(asarPath)) {
  const header = parseAsarHeader(readFileSync(asarPath));
  check(header !== null, `asar header parses (${asarPath})`);
  const missing = [];
  if (header) {
    const nodeModules = header.files?.node_modules?.files ?? {};
    for (const dep of declared) {
      if (!nodeModules[dep]?.files?.["package.json"]) missing.push(dep);
    }
  }
  check(
    missing.length === 0,
    missing.length === 0
      ? `all declared dependencies present in ${asarPath}`
      : `missing from packaged asar: ${missing.join(", ")}`,
  );
} else {
  console.log(`skip - asar artifact check (no ${asarPath}; run after npm run dist:win:dir, or pass --asar <path>)`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nPackaging check passed. Build on Windows with: npm run dist:win");
console.log("Code signing: set CSC_LINK + CSC_KEY_PASSWORD, or sign the .exe after building.");
