// Request shaping shared by the store and the Responses adapter. Both must agree on these
// numbers: a value the store writes and the adapter then re-cuts is rewritten on every turn,
// and every rewrite invalidates the cached prefix.

// Schema caps instructions and steers at 16,000 characters, which encodes to at most 48,000
// bytes. The bound sits above that so it never fires for input the command layer accepted,
// which keeps the prompt stable for real conversations.
export const maxTextBytes = 64_000;
export const maxToolResultBytes = 30_000;
export const toolResultMarker = "\n[Tool result truncated to fit context budget]";
export const textMarker = "\n[History text truncated to fit context budget]";

// Byte-accurate cut: slices count UTF-16 units, so a character slice can overshoot a byte
// budget by up to 3x on multibyte text. Back up to the previous UTF-8 character boundary
// before decoding so we never emit replacement characters.
export function cut(value: string, bytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= bytes) return value;
  let end = Math.max(0, bytes);
  while (end > 0 && ((buf[end] ?? 0) & 0xC0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// The marker counts against the budget so the caller's limit is the final size and a second
// pass over the same value is a no-op.
export function bound(value: string, bytes: number, marker: string): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  return `${cut(value, bytes - Buffer.byteLength(marker))}${marker}`;
}
