import { BRIDGE_HOST_NAME } from "./protocol.js";

export interface HostManifestOptions {
  /** Absolute path to the host executable/script, e.g. node + dist/bridge/cli. */
  hostPath: string;
  /** Browser extension id, required by Chrome/Edge; Firefox uses allowed_extensions. */
  extensionId?: string;
  description?: string;
}

/** Chrome / Edge manifest (registered via registry on Windows). */
export function chromeHostManifest(options: HostManifestOptions): Record<string, unknown> {
  if (!options.extensionId) {
    throw new Error("Chrome/Edge native messaging requires an extension id");
  }
  return {
    name: BRIDGE_HOST_NAME,
    description:
      options.description ?? "Download Manager native messaging host",
    path: options.hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
}

/** Firefox manifest (registered via registry on Windows, or a JSON file). */
export function firefoxHostManifest(options: HostManifestOptions): Record<string, unknown> {
  return {
    name: BRIDGE_HOST_NAME,
    description:
      options.description ?? "Download Manager native messaging host",
    path: options.hostPath,
    type: "stdio",
    ...(options.extensionId
      ? { allowed_extensions: [options.extensionId] }
      : {}),
  };
}

/** Windows .reg content for Chrome. Edge uses MicrosoftEdge instead of Google/Chrome. */
export function windowsRegFile(
  browser: "chrome" | "edge" | "firefox",
  manifestPath: string,
): string {
  const key =
    browser === "chrome"
      ? "HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.downloadmanager.bridge"
      : browser === "edge"
        ? "HKEY_CURRENT_USER\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.downloadmanager.bridge"
        : "HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\com.downloadmanager.bridge";
  const escaped = manifestPath.replace(/\\/g, "\\\\");
  return [
    "Windows Registry Editor Version 5.00",
    "",
    `[${key}]`,
    `@="${escaped}"`,
    "",
  ].join("\r\n");
}
