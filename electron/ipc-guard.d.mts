// Type declarations for ./ipc-guard.mjs (see that file for the logic).
// Kept separate so vitest/TS can import the .mjs guard without TS7016.

export interface IpcWindowLike {
  webContents?: unknown;
  isDestroyed?: () => boolean;
}

export interface IpcWindowsLike {
  mainWindow?: IpcWindowLike | null;
  widgetWindow?: IpcWindowLike | null;
  dialogWindows?: Map<unknown, IpcWindowLike>;
}

export function isTrustedIpcSender(
  event: { sender?: unknown } | null | undefined,
  windows?: IpcWindowsLike | null,
): boolean;

export function assertTrustedIpcSender(
  event: { sender?: unknown } | null | undefined,
  windows?: IpcWindowsLike | null,
): void;

export function assertIpcArgs(channel: string, args?: unknown[]): void;
