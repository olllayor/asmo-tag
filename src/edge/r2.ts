export interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2PutOptions {
  customMetadata?: Record<string, string>;
  httpMetadata?: Record<string, string>;
  sha256?: string;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions
  ): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
  }>;
}

import { viewBuffer } from "./bytes.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", viewBuffer(bytes));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export class EdgeArtifactStore {
  constructor(private readonly r2?: R2Bucket) {}

  get configured(): boolean {
    return this.r2 !== undefined;
  }

  async putArtifact(
    key: string,
    content: string | Uint8Array,
    metadata: Record<string, string> = {}
  ): Promise<{ key: string; size: number; sha256: string }> {
    // Fail closed: without an R2 binding there is nowhere to persist, so claiming a
    // successful save would strand callers with a digest for bytes that exist nowhere.
    if (!this.r2) throw new Error("Artifact storage is not configured: missing R2 binding.");
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    // Pass the view itself: bytes.buffer can extend past the view (subarrays), which
    // would hash the wrong bytes.
    const sha256 = await sha256Hex(bytes);

    await this.r2.put(key, bytes, {
      customMetadata: { ...metadata, sha256 },
      sha256,
    });

    return { key, size: bytes.byteLength, sha256 };
  }

  async getArtifact(
    key: string
  ): Promise<{ data: Uint8Array; text: () => string; metadata: Record<string, string> } | null> {
    if (!this.r2) return null;
    const obj = await this.r2.get(key);
    if (!obj) return null;
    const buffer = await obj.arrayBuffer();
    const data = new Uint8Array(buffer);
    const metadata = obj.customMetadata ?? {};
    // putArtifact records the digest in metadata; a mismatch means the stored bytes are
    // not what was written, so fail loudly instead of running on corrupt input.
    if (metadata.sha256 && (await sha256Hex(data)).toLowerCase() !== metadata.sha256.toLowerCase()) {
      throw new Error(`Artifact ${key} failed SHA-256 validation`);
    }
    return {
      data,
      text: () => new TextDecoder().decode(data),
      metadata,
    };
  }

  async deleteArtifact(key: string): Promise<void> {
    if (!this.r2) return;
    await this.r2.delete(key);
  }
}
