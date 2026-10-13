import { z } from "zod";
import { viewBuffer } from "./bytes.js";

const vaultTupleSchema = z.tuple([z.string(), z.string(), z.string()]);

function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(base64, "base64");
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return copy;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

export class WebCryptoVault {
  constructor(private readonly cryptoKey: CryptoKey) {}

  static async importKey(base64Key: string): Promise<WebCryptoVault> {
    const rawKey = base64ToUint8Array(base64Key);
    if (rawKey.byteLength !== 32) {
      throw new Error("Vault key must be exactly 32 bytes (256-bit)");
    }
    // Copy into an exact buffer: the view's .buffer can extend past the view (Buffer
    // pooling, subarrays), and SubtleCrypto would then import the wrong bytes.
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      viewBuffer(rawKey),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return new WebCryptoVault(cryptoKey);
  }

  static async generateKey(): Promise<{ base64Key: string; vault: WebCryptoVault }> {
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    const base64Key = uint8ArrayToBase64(rawKey);
    const vault = await WebCryptoVault.importKey(base64Key);
    return { base64Key, vault };
  }

  async encrypt(value: unknown, binding: string): Promise<string> {
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);

    const encoder = new TextEncoder();
    const encodedData = encoder.encode(JSON.stringify(value));
    const aad = encoder.encode(binding);

    // SubtleCrypto AES-GCM appends 16-byte authentication tag to the ciphertext
    const encryptedBuffer = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad,
        tagLength: 128,
      },
      this.cryptoKey,
      encodedData
    );

    const fullCiphertext = new Uint8Array(encryptedBuffer);
    const ciphertextBytes = fullCiphertext.subarray(0, fullCiphertext.length - 16);
    const tagBytes = fullCiphertext.subarray(fullCiphertext.length - 16);

    const nonceB64 = uint8ArrayToBase64(nonce);
    const tagB64 = uint8ArrayToBase64(tagBytes);
    const cipherB64 = uint8ArrayToBase64(ciphertextBytes);

    return JSON.stringify([nonceB64, tagB64, cipherB64]);
  }

  async decrypt<T>(serialized: string, binding: string): Promise<T> {
    try {
      const [nonceB64, tagB64, cipherB64] = vaultTupleSchema.parse(JSON.parse(serialized));
      const nonce = base64ToUint8Array(nonceB64);
      const tag = base64ToUint8Array(tagB64);
      const ciphertext = base64ToUint8Array(cipherB64);

      // Recombine ciphertext and 16-byte tag for SubtleCrypto decrypt
      const combined = concatUint8Arrays(ciphertext, tag);
      const encoder = new TextEncoder();
      const aad = encoder.encode(binding);

      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: viewBuffer(nonce),
          additionalData: viewBuffer(aad),
          tagLength: 128,
        },
        this.cryptoKey,
        viewBuffer(combined)
      );

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decryptedBuffer)) as T;
    } catch {
      throw new Error("Connector vault could not decrypt credential");
    }
  }
}
