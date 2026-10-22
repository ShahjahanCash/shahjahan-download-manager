import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BridgeInfo {
  version: 1;
  port: number;
  token: string;
  host: string;
}

/**
 * Discovery file shared by the Electron app (writer) and the Native
 * Messaging host (reader). It lives under the user's home directory,
 * not in the project, so a browser-launched host finds the running app
 * regardless of where the app was installed from.
 * The token is a bearer secret for loopback only: it stops arbitrary
 * web pages from driving the bridge, it is not a defence against other
 * local processes (which can already read the file).
 */
export function bridgeInfoPath(): string {
  if (process.env["DM_BRIDGE_INFO_PATH"]) {
    return process.env["DM_BRIDGE_INFO_PATH"]!;
  }
  return join(homedir(), ".download-manager", "bridge.json");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function writeBridgeInfo(info: BridgeInfo): Promise<void> {
  const path = bridgeInfoPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export async function readBridgeInfo(): Promise<BridgeInfo | null> {
  try {
    const raw = await readFile(bridgeInfoPath(), "utf8");
    const parsed = JSON.parse(raw) as BridgeInfo;
    if (
      parsed.version !== 1 ||
      typeof parsed.port !== "number" ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 16
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function deleteBridgeInfo(): Promise<void> {
  await unlink(bridgeInfoPath()).catch(() => undefined);
}
