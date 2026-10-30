import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  filenameFromContentDisposition,
  sanitizeDownloadFilename,
} from "../src/engine/categories.js";
import { resumeDownload } from "../src/engine/downloader.js";
import { saveJournal } from "../src/engine/journal.js";
import type { JobState } from "../src/engine/types.js";

describe("server-supplied filename sanitization (§11)", () => {
  it("drops directory traversal components", () => {
    expect(sanitizeDownloadFilename("../evil.exe")).toBe("evil.exe");
    expect(sanitizeDownloadFilename("a/b/c.txt")).toBe("c.txt");
    expect(sanitizeDownloadFilename("C:\\Users\\evil.exe")).toBe("evil.exe");
  });
  it("handles dot names, reserved stems and illegal characters", () => {
    expect(sanitizeDownloadFilename("..")).toBe("download");
    expect(sanitizeDownloadFilename("")).toBe("download");
    expect(sanitizeDownloadFilename("CON.txt")).toBe("CON_.txt");
    expect(sanitizeDownloadFilename("a<b>.txt")).toBe("a_b_.txt");
    expect(sanitizeDownloadFilename("file...")).toBe("file");
  });
  it("sanitizes Content-Disposition filenames at the source", () => {
    expect(
      filenameFromContentDisposition('attachment; filename="../evil.exe"'),
    ).toBe("evil.exe");
    expect(
      filenameFromContentDisposition('attachment; filename="report.pdf"'),
    ).toBe("report.pdf");
  });
});

// --- Resume reconciliation (§8): truncated .part must not yield a
// corrupt "completed" file. Journal claims segment 0 done, but the
// .part file only holds its first 64 KiB; resume must re-download
// the missing bytes and produce the exact payload.
const PAYLOAD = Buffer.alloc(256 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

let baseUrl = "";
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": String(PAYLOAD.length),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
      });
      res.end();
      return;
    }
    const range = req.headers["range"];
    const match = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), PAYLOAD.length - 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${PAYLOAD.length}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
      });
      res.end(PAYLOAD.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Length": String(PAYLOAD.length) });
    res.end(PAYLOAD);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("resume .part reconciliation (§8)", () => {
  it("re-downloads bytes the journal claims but the .part file lacks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdm-safety-"));
    try {
      const destination = join(dir, "file.bin");
      const partPath = `${destination}.part`;
      // .part holds only the first 64 KiB, although the journal below
      // claims the whole first 128 KiB segment is downloaded.
      await writeFile(partPath, PAYLOAD.subarray(0, 64 * 1024));
      const job: JobState = {
        version: 1,
        id: "safety-test",
        url: `${baseUrl}/file`,
        finalUrl: `${baseUrl}/file`,
        destination,
        partPath,
        filename: "file.bin",
        category: "General",
        totalBytes: PAYLOAD.length,
        rangeSupported: true,
        etag: null,
        lastModified: null,
        segments: [
          { start: 0, end: 128 * 1024 - 1, downloaded: 128 * 1024, done: true },
          { start: 128 * 1024, end: PAYLOAD.length - 1, downloaded: 0, done: false },
        ],
        downloadedBytes: 128 * 1024,
        status: "paused",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
      };
      await saveJournal(job);
      const session = await resumeDownload(partPath);
      await session.done;
      const out = await readFile(destination);
      expect(out.equals(PAYLOAD)).toBe(true);
      expect(
        createHash("sha256").update(out).digest("hex"),
      ).toBe(createHash("sha256").update(PAYLOAD).digest("hex"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
