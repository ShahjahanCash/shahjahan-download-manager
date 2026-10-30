import { describe, expect, it } from "vitest";
import {
  assertIpcArgs,
  assertTrustedIpcSender,
  isTrustedIpcSender,
} from "../electron/ipc-guard.mjs";

// Fake WebContents-like objects: only webContents identity + isDestroyed
// matter to the guard, so plain objects are enough here.
function fakeWindow(webContents: object) {
  return { webContents, isDestroyed: () => false };
}
describe("IPC sender validation (1.0.4 Phase 1)", () => {
  it("accepts the main window, the widget window, and a dialog window", () => {
    const main = fakeWindow({ id: "main" });
    const widget = fakeWindow({ id: "widget" });
    const dialog = fakeWindow({ id: "dialog" });
    const windows = {
      mainWindow: main,
      widgetWindow: widget,
      dialogWindows: new Map([["job-1", dialog]]),
    };
    expect(isTrustedIpcSender({ sender: main.webContents }, windows)).toBe(true);
    expect(isTrustedIpcSender({ sender: widget.webContents }, windows)).toBe(true);
    expect(isTrustedIpcSender({ sender: dialog.webContents }, windows)).toBe(true);
  });

  it("rejects a foreign sender, a missing sender, and a destroyed sender", () => {
    const main = fakeWindow({ id: "main" });
    const windows = { mainWindow: main, widgetWindow: null, dialogWindows: new Map() };
    const foreign = { sender: { isDestroyed: () => false } };
    expect(isTrustedIpcSender(foreign, windows)).toBe(false);
    expect(isTrustedIpcSender({}, windows)).toBe(false);
    expect(isTrustedIpcSender(null, windows)).toBe(false);
    expect(() => assertTrustedIpcSender(foreign, windows)).toThrow("Untrusted IPC sender");
    const destroyed = { sender: { isDestroyed: () => true } };
    expect(isTrustedIpcSender(destroyed, windows)).toBe(false);
  });

  it("rejects a sender from a destroyed dialog window", () => {
    const dialog = { webContents: { id: "d" }, isDestroyed: () => true };
    const windows = { mainWindow: null, widgetWindow: null, dialogWindows: new Map([["j", dialog]]) };
    expect(isTrustedIpcSender({ sender: dialog.webContents }, windows)).toBe(false);
  });
});

describe("IPC argument validation (1.0.4 Phase 1)", () => {
  it("requires a non-empty string id for id channels", () => {
    expect(() => assertIpcArgs("dm:pause", ["job-1"])).not.toThrow();
    expect(() => assertIpcArgs("dm:pause", [""])).toThrow();
    expect(() => assertIpcArgs("dm:pause", [123])).toThrow();
    expect(() => assertIpcArgs("dm:delete-with-file", [])).toThrow();
  });

  it("requires a non-empty string url for url channels", () => {
    expect(() => assertIpcArgs("dm:add", ["https://example.com/f.zip"])).not.toThrow();
    expect(() => assertIpcArgs("dm:add", [""])).toThrow();
    expect(() => assertIpcArgs("dm:yt-info", [null])).toThrow();
    expect(() => assertIpcArgs("dm:add", ["https://example.com/f.zip", "not-an-object"])).toThrow();
  });

  it("requires two ids for rename/move and a finite limit for set-queue-limit", () => {
    expect(() => assertIpcArgs("dm:rename-queue", ["q1", "New"])).not.toThrow();
    expect(() => assertIpcArgs("dm:move-job", ["job-1"])).toThrow();
    expect(() => assertIpcArgs("dm:set-queue-limit", ["q1", 1024])).not.toThrow();
    expect(() => assertIpcArgs("dm:set-queue-limit", ["q1", -1])).toThrow();
    expect(() => assertIpcArgs("dm:set-queue-limit", ["q1", Number.NaN])).toThrow();
    expect(() => assertIpcArgs("dm:set-queue-limit", ["q1", "fast"])).toThrow();
  });

  it("only checks the tool type for dm:yt-install-tool, not the enum", () => {
    expect(() => assertIpcArgs("dm:yt-install-tool", ["ytdlp"])).not.toThrow();
    expect(() => assertIpcArgs("dm:yt-install-tool", ["unknown-tool"])).not.toThrow();
    expect(() => assertIpcArgs("dm:yt-install-tool", [42])).toThrow();
  });

  it("leaves no-arg and self-sanitising channels alone", () => {
    expect(() => assertIpcArgs("dm:list", [])).not.toThrow();
    expect(() => assertIpcArgs("dm:set-settings", [{ maxConcurrent: 3 }])).not.toThrow();
    expect(() => assertIpcArgs("dm:set-settings", [null])).not.toThrow();
  });
});
