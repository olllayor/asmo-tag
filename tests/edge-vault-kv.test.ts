import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebCryptoVault } from "../src/edge/vault.js";
import { EdgeKvCache } from "../src/edge/kv.js";
import type { KVNamespace } from "../src/edge/kv.js";
import { handleWebhookRequest } from "../src/edge/gateway.js";
import type { EdgeEnv } from "../src/edge/gateway.js";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "../src/store/d1.js";
import { createMockD1 } from "./helpers/mock-d1.js";


function createMockKV(): KVNamespace & { store: Map<string, string>; putOptions: Map<string, any> } {
  const store = new Map<string, string>();
  const putOptions = new Map<string, any>();
  return {
    store,
    putOptions,
    async get(key: string, options?: { type?: string }) {
      const val = store.get(key);
      if (val === undefined) return null;
      if (options?.type === "json") return JSON.parse(val);
      return val;
    },
    async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: any) {
      store.set(key, typeof value === "string" ? value : String(value));
      if (options) putOptions.set(key, options);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

describe("WebCryptoVault (AES-256-GCM)", () => {
  it("encrypts and decrypts credentials with authenticated binding", async () => {
    const { vault } = await WebCryptoVault.generateKey();
    const secretData = { token: "ghp_secret_12345", installationId: 98765 };
    const binding = "scope:ws_1:github";

    const encrypted = await vault.encrypt(secretData, binding);
    expect(typeof encrypted).toBe("string");

    const decrypted = await vault.decrypt<typeof secretData>(encrypted, binding);
    expect(decrypted).toEqual(secretData);
  });

  it("fails decryption if authenticated binding is tampered", async () => {
    const { vault } = await WebCryptoVault.generateKey();
    const secretData = { token: "token_abc" };
    const encrypted = await vault.encrypt(secretData, "original_binding");

    await expect(
      vault.decrypt(encrypted, "tampered_binding")
    ).rejects.toThrow("could not decrypt credential");
  });

  it("rejects decryption if nonce or tag length is invalid", async () => {
    const { vault } = await WebCryptoVault.generateKey();
    const badNonce = JSON.stringify([
      Buffer.from("short").toString("base64"),
      Buffer.alloc(16).toString("base64"),
      Buffer.from("ciphertext").toString("base64"),
    ]);
    await expect(vault.decrypt(badNonce, "binding")).rejects.toThrow("could not decrypt credential");

    const badTag = JSON.stringify([
      Buffer.alloc(12).toString("base64"),
      Buffer.from("short-tag").toString("base64"),
      Buffer.from("ciphertext").toString("base64"),
    ]);
    await expect(vault.decrypt(badTag, "binding")).rejects.toThrow("could not decrypt credential");
  });

  it("handles URL-safe base64 encoding seamlessly", async () => {
    const rawKey = randomBytes(32);
    const urlSafeKey = rawKey.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const vault = await WebCryptoVault.importKey(urlSafeKey);
    const encrypted = await vault.encrypt({ key: "val" }, "scope");
    const decrypted = await vault.decrypt(encrypted, "scope");
    expect(decrypted).toEqual({ key: "val" });
  });

  it("is cross-compatible with Node.js crypto cipher/decipher", async () => {
    const rawKey = randomBytes(32);
    const base64Key = rawKey.toString("base64");
    const vault = await WebCryptoVault.importKey(base64Key);
    const binding = "ws_test:notion";
    const payload = { accessToken: "secret_notion_key", botId: "bot_123" };

    // 1. Encrypt with Node.js crypto -> Decrypt with WebCryptoVault
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", rawKey, nonce);
    cipher.setAAD(Buffer.from(binding));
    const encryptedBuf = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const nodeSerialized = JSON.stringify([
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encryptedBuf.toString("base64"),
    ]);

    const decryptedViaWebCrypto = await vault.decrypt<typeof payload>(nodeSerialized, binding);
    expect(decryptedViaWebCrypto).toEqual(payload);

    // 2. Encrypt with WebCryptoVault -> Decrypt with Node.js crypto
    const webCryptoSerialized = await vault.encrypt(payload, binding);
    const [wNonce, wTag, wCipher] = JSON.parse(webCryptoSerialized) as [string, string, string];
    const decipher = createDecipheriv("aes-256-gcm", rawKey, Buffer.from(wNonce, "base64"));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(Buffer.from(wTag, "base64"));
    const nodeDecrypted = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(wCipher, "base64")), decipher.final()]).toString("utf8")
    );
    expect(nodeDecrypted).toEqual(payload);
  });
});

describe("EdgeKvCache and Rate Limiting", () => {
  it("enforces rate limits per key bucket", async () => {
    const kv = createMockKV();
    const cache = new EdgeKvCache(kv);

    const first = await cache.checkRateLimit("client-123", 2, 60);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    const second = await cache.checkRateLimit("client-123", 2, 60);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    const third = await cache.checkRateLimit("client-123", 2, 60);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("respects minimum expirationTtl of 60 seconds for small windows", async () => {
    const kv = createMockKV();
    const cache = new EdgeKvCache(kv);
    const result = await cache.checkRateLimit("short-window", 10, 10);
    expect(result.allowed).toBe(true);
    const opts = Array.from(kv.putOptions.values())[0];
    expect(opts?.expirationTtl).toBeGreaterThanOrEqual(60);
  });

  it("returns 429 when rate limit is exceeded on webhook endpoint", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const kv = createMockKV();
    const env: EdgeEnv = {
      DB: d1,
      KV: kv,
      TELEGRAM_BOT_TOKEN: "123:ABC",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
    };

    // Fill the chat bucket. The limiter runs after authentication and update normalization,
    // which is why this payload has to be a real update rather than a bare update_id.
    const cache = new EdgeKvCache(kv);
    for (let i = 0; i < 600; i++) {
      await cache.checkRateLimit("chat:-1001", 600, 60);
    }

    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "edge-webhook-secret-token",
      },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: -1001, type: "supergroup" }, from: { id: 1, is_bot: false }, text: "hi" } }),
    });

    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Rate limit exceeded");

    rawDb.close();
  });
});
