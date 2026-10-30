// Type declarations for ./tool-verify.mjs (see that file for the logic).
export function sha256File(path: string): Promise<string>;
export function parseSha256Sums(text: string, filename: string): string | null;
export function parseSingleSha256(text: string): string | null;
export function verifyFileSha256(path: string, expected: string | null | undefined, label: string): Promise<void>;
