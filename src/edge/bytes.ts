// SubtleCrypto takes BufferSource, but a Uint8Array view's .buffer can extend past the
// view (Buffer pooling, subarrays), and TS7 types views as ArrayBufferLike. Copying into
// a fresh buffer is exact under both constraints. Sizes here are tiny (keys, nonces,
// digests), so the copy is negligible.
export function viewBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}
