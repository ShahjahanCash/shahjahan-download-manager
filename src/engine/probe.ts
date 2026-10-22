import {
  filenameFromContentDisposition,
  filenameFromUrl,
} from "./categories.js";
import type { ProbeResult } from "./types.js";

function parseTotal(headers: Headers): number | null {
  const length = headers.get("content-length");
  if (length) {
    const value = Number(length);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  const range = headers.get("content-range");
  if (range) {
    const total = /\/(\d+|\*)$/.exec(range)?.[1];
    if (total && total !== "*") {
      const value = Number(total);
      if (Number.isSafeInteger(value)) return value;
    }
  }
  return null;
}

/**
 * Discover size, Range support and filename without downloading the body.
 * Strategy: HEAD first (cheap), then a 0-byte Range GET as a fallback,
 * because some servers omit Content-Length on HEAD or reject HEAD entirely.
 * A server is only trusted as range-capable when it answers 206.
 */
export async function probe(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ProbeResult> {
  let response: Response | null = null;
  try {
    response = await fetch(url, {
      method: "HEAD",
      headers,
      redirect: "follow",
      ...(signal ? { signal } : {}),
    });
    if (response.ok) {
      let total = parseTotal(response.headers);
      const range = response.headers.get("accept-ranges");
      // B2 fix: Accept-Ranges alone is NOT proof — some servers
      // advertise it but answer Range GETs with 200 (ignoring the
      // range), which used to fail the whole download after retries.
      // Verify with a 0-byte Range GET before claiming support; if
      // verification fails or is not 206, fall back to one stream.
      let rangeSupported = false;
      if (range === "bytes") {
        try {
          const verify = await fetch(response.url, {
            headers: { ...headers, Range: "bytes=0-0" },
            redirect: "follow",
            ...(signal ? { signal } : {}),
          });
          try {
            rangeSupported = verify.status === 206;
            if (total === null) total = parseTotal(verify.headers);
          } finally {
            await verify.body?.cancel().catch(() => undefined);
          }
        } catch {
          rangeSupported = false;
        }
      }
      return {
        finalUrl: response.url,
        totalBytes: total,
        rangeSupported,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentType: response.headers.get("content-type"),
        filename:
          filenameFromContentDisposition(
            response.headers.get("content-disposition"),
          ) ?? filenameFromUrl(response.url),
      };
    }
  } catch {
    // Fall through to the Range probe.
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }

  const rangeResponse = await fetch(url, {
    headers: { ...headers, Range: "bytes=0-0" },
    redirect: "follow",
    ...(signal ? { signal } : {}),
  });
  try {
    if (!rangeResponse.ok && rangeResponse.status !== 206) {
      throw new Error(
        `Probe failed: HTTP ${rangeResponse.status} for ${url}`,
      );
    }
    return {
      finalUrl: rangeResponse.url,
      totalBytes: parseTotal(rangeResponse.headers),
      rangeSupported: rangeResponse.status === 206,
      etag: rangeResponse.headers.get("etag"),
      lastModified: rangeResponse.headers.get("last-modified"),
      contentType: rangeResponse.headers.get("content-type"),
      filename:
        filenameFromContentDisposition(
          rangeResponse.headers.get("content-disposition"),
        ) ?? filenameFromUrl(rangeResponse.url),
    };
  } finally {
    await rangeResponse.body?.cancel().catch(() => undefined);
  }
}
