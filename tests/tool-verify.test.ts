import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseSha256Sums,
  parseSingleSha256,
  sha256File,
  verifyFileSha256,
} from "../electron/tool-verify.mjs";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdm-tool-verify-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tool checksum verification (1.0.4 Phase 2)", () => {
  it("hashes a file and accepts a matching expected hash", async () => {
    const file = join(dir, "sample.bin");
    await writeFile(file, "hello tool\n");
    const expected = createHash("sha256").update("hello tool\n").digest("hex");
    expect(await sha256File(file)).toBe(expected);
    await expect(verifyFileSha256(file, expected, "sample.bin")).resolves.toBeUndefined();
  });

  it("rejects a mismatched hash and a missing expected hash", async () => {
    const file = join(dir, "sample2.bin");
    await writeFile(file, "different content");
    const wrong = "0".repeat(64);
    await expect(verifyFileSha256(file, wrong, "sample2.bin")).rejects.toThrow("Checksum mismatch");
    await expect(verifyFileSha256(file, null, "sample2.bin")).rejects.toThrow("No official SHA-256");
    await expect(verifyFileSha256(file, "not-a-hash", "sample2.bin")).rejects.toThrow("No official SHA-256");
  });

  it("parses GNU-style SHA2-256SUMS entries, with or without the * marker", () => {
    const hash = "a".repeat(64);
    const text = [
      `${"b".repeat(64)}  other-file.exe`,
      `${hash} *yt-dlp.exe`,
      `${"c".repeat(64)}  yt-dlp.exe.sha256`,
    ].join("\n");
    expect(parseSha256Sums(text, "yt-dlp.exe")).toBe(hash);
    expect(parseSha256Sums(text, "missing.exe")).toBeNull();
    // A same-named entry in a subdirectory must not shadow the real one:
    expect(parseSha256Sums(`${hash}  sub/yt-dlp.exe\n`, "yt-dlp.exe")).toBe(hash);
  });

  it("parses a single-hash gyan .sha256 file", () => {
    const hash = "d".repeat(64);
    expect(parseSingleSha256(`${hash}\n`)).toBe(hash);
    expect(parseSingleSha256(`  ${hash}  ffmpeg-release-essentials.zip\n`)).toBe(hash);
    expect(parseSingleSha256("no hash here")).toBeNull();
  });
});
