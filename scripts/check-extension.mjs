#!/usr/bin/env node
// Validates the Phase 5 extension without a browser: manifests parse,
// referenced files exist, and key behaviours are present as strings.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  else console.log(`ok - ${message}`);
}
function read(name) {
  return readFileSync(join(root, name), "utf8");
}
function json(name) {
  return JSON.parse(read(name));
}

for (const manifestName of ["manifest.json", "manifest.firefox.json"]) {
  const manifest = json(manifestName);
  check(manifest.manifest_version === 3, `${manifestName}: manifest_version 3`);
  check(typeof manifest.name === "string" && manifest.name.length > 0, `${manifestName}: name`);
  check(Array.isArray(manifest.permissions) && manifest.permissions.includes("downloads"), `${manifestName}: downloads permission`);
  check(Array.isArray(manifest.permissions) && manifest.permissions.includes("nativeMessaging"), `${manifestName}: nativeMessaging permission`);
  check(manifest.background, `${manifestName}: background`);
  for (const script of (manifest.content_scripts || []).flatMap((cs) => cs.js)) {
    check(existsSync(join(root, script)), `${manifestName}: content script exists: ${script}`);
  }
  for (const icon of Object.values(manifest.icons || {})) {
    check(existsSync(join(root, icon)), `${manifestName}: icon exists: ${icon}`);
  }
}

// Version drift guard (added for 1.0.2): both manifests must track the app version.
const appVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
for (const manifestName of ["manifest.json", "manifest.firefox.json"]) {
  check(json(manifestName).version === appVersion, `${manifestName}: version matches app ${appVersion}`);
}

const background = read("background.js");
check(background.includes("connectNative"), "background: connectNative");
check(background.includes("downloads.onCreated"), "background: downloads.onCreated interception");
check(background.includes("downloads.cancel"), "background: cancel browser download before forwarding");
check(background.includes("blob:"), "background: blob/data URLs skipped");
check(background.includes("stream: true"), "background: HLS/DASH flagged as stream for the app");

const content = read("content.js");
check(content.includes("Download this video"), "content: overlay button text");
check(content.includes("attachShadow"), "content: Shadow DOM overlay");
check(content.includes("MutationObserver"), "content: MutationObserver video detection");

const injected = read("injected.js");
check(injected.includes(".m3u8"), "injected: HLS detection");
check(injected.includes(".mpd"), "injected: DASH detection");
check(injected.includes("MediaSource") || injected.includes("fetch"), "injected: fetch/XHR hooks");

const popup = read("popup.html");
check(popup.includes("dm_get_status") || read("popup.js").includes("dm_get_status"), "popup: status check");
check(read("popup.js").includes("dm_list_videos"), "popup: lists videos on page");

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nExtension check passed.");
