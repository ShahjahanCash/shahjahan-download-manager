/**
 * HTTP(S) proxy support. Node's fetch honours the global undici
 * dispatcher, so one ProxyAgent covers the engine, the probe, the
 * stream downloaders and the site grabber. yt-dlp gets --proxy
 * separately (see yt/options). SOCKS proxies are not supported by
 * undici's ProxyAgent, so only http(s):// proxies are accepted here.
 */

import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

let previousDispatcher: ReturnType<typeof getGlobalDispatcher> | null = null;

/** Validate a proxy URL. Returns the cleaned URL or null when invalid. */
export function parseProxyUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || !parsed.port) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Route all fetch() calls through the proxy (null = direct). */
export function applyProxy(proxyUrl: string | null): void {
  if (proxyUrl) {
    if (previousDispatcher === null) previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } else if (previousDispatcher !== null) {
    setGlobalDispatcher(previousDispatcher);
    previousDispatcher = null;
  }
}
