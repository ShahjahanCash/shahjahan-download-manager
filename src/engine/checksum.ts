import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Stream a file through a hash function (no whole-file buffering). */
export async function computeHash(
  path: string,
  algorithm: "sha256" | "md5" = "sha256",
): Promise<string> {
  const hash = createHash(algorithm);
  const stream = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/** Normalise a user-supplied hash (strip separators, lowercase). */
export function normaliseHash(value: string): string {
  return value.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** Compare an expected hash against a computed one. Empty expected = skip. */
export function hashMatches(expected: string, computed: string): boolean {
  const clean = normaliseHash(expected);
  if (!clean) return true;
  return clean === normaliseHash(computed);
}
