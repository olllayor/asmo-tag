import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { equalSecret, validateInitData } from "../src/telegram/auth.js";
import { normalizeUpdate } from "../src/telegram/updates.js";
import { attachTextFile, type TelegramFileGateway } from "../src/telegram/files.js";
import { readConfig } from "../src/config.js";

const now = 1_790_000_000_000;
const token = "123456:synthetic-token";
function signed(values: Record<string, string>) {
  const fields = new URLSearchParams(values);
  const data = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  fields.set("hash", createHmac("sha256", key).update(data).digest("hex"));
  return fields.toString();
}
const user = JSON.stringify({ id: 101, first_name: "Synthetic" });
const bot = { id: "999", username: "AsmoTagBot" };
const message = { message_id: 10, from: { id: 101 }, chat: { id: -100, type: "supergroup" }, text: "👋 @AsmoTagBot investigate", entities: [{ type: "mention", offset: 3, length: 11 }] };

describe("Telegram identity and intake boundaries", () => {
  it("verifies signed identity including the signature field and rejects tampering", () => {
    const initData = signed({ auth_date: String(now / 1000), user, signature: "synthetic-signature", start_param: "t_synthetic" });
    expect(validateInitData(initData, token, now)).toBe("101");
    expect(() => validateInitData(initData.replace("Synthetic", "Forged"), token, now)).toThrow();
    expect(() => validateInitData(initData + "&user=" + encodeURIComponent(user), token, now)).toThrow();
    expect(() => validateInitData(initData, "wrong-token", now)).toThrow();
    expect(equalSecret("a", "longer")).toBe(false);
  });
  it("rejects stale, future, unsafe and bot identities", () => {
    for (const authDate of [now / 1000 - 3601, now / 1000 + 31]) expect(() => validateInitData(signed({ auth_date: String(authDate), user }), token, now)).toThrow();
    for (const value of [{ id: Number.MAX_SAFE_INTEGER + 1 }, { id: 101, is_bot: true }]) expect(() => validateInitData(signed({ auth_date: String(now / 1000), user: JSON.stringify(value) }), token, now)).toThrow();
  });
  it("uses Telegram UTF-16 entities and never invents an anonymous actor", () => {
    expect(normalizeUpdate({ update_id: 1, message }, bot)).toMatchObject({ mentioned: true, userId: "101", topicId: null });
    expect(normalizeUpdate({ update_id: 2, message: { ...message, sender_chat: { id: -100 } } }, bot)).toMatchObject({ userId: null });
    expect(normalizeUpdate({ update_id: 3, message: { ...message, from: { id: 102, is_bot: true } } }, bot)).toBeNull();
  });
  it("marks edits as notes, keeps reply targets explicit, and ignores other bot commands", () => {
    expect(normalizeUpdate({ update_id: 4, edited_message: { ...message, reply_to_message: { message_id: 20 } } }, bot)).toMatchObject({ edited: true, replyTo: 20 });
    expect(normalizeUpdate({ update_id: 5, message: { ...message, text: "/stop@OtherBot", entities: [{ type: "bot_command", offset: 0, length: 14 }] } }, bot)).toBeNull();
  });
  it("pauses reliable ingestion when the bot loses administrator membership", () => {
    expect(normalizeUpdate({ update_id: 6, my_chat_member: { chat: { id: -100 }, new_chat_member: { user: { id: 999, is_bot: true }, status: "member" } } }, bot)).toMatchObject({ botRemoved: true });
    expect(normalizeUpdate({ update_id: 7, message: { ...message, migrate_to_chat_id: -200 } }, bot)).toMatchObject({ kind: "migration", newChatId: "-200" });
  });
});

describe("Bounded Telegram text attachments", () => {
  const raw = { update_id: 8, message: { ...message, document: { file_id: "synthetic", file_name: "incident.txt", file_size: 10, mime_type: "text/plain" } } };
  const normalized = normalizeUpdate(raw, bot);
  if (!normalized) throw new Error("Test input missing");
  const gateway: TelegramFileGateway = { locate: async () => ({ file_path: "documents/incident.txt", file_size: 10 }), download: async () => new Response("Incident EU 422") };
  it("captures supported text with its filename", async () => {
    expect(await attachTextFile(raw, normalized, gateway)).toMatchObject({ file: { name: "incident.txt", text: "Incident EU 422" } });
  });
  it("does not download unsupported files and exposes the parse limitation", async () => {
    const forbidden = { ...raw, message: { ...raw.message, document: { ...raw.message.document, file_name: "incident.pdf" } } };
    const result = await attachTextFile(forbidden, normalized, { ...gateway, locate: async () => { throw new Error("Must not download"); } });
    expect(result).not.toHaveProperty("file");
    expect(result.kind === "message" && result.text).toContain("was not parsed");
  });
  it("rejects oversized response bodies and invalid UTF-8 despite advertised size", async () => {
    for (const bytes of [new Uint8Array(32769), new Uint8Array([0xff])]) {
      const result = await attachTextFile(raw, normalized, { ...gateway, download: async () => new Response(bytes) });
      expect(result).not.toHaveProperty("file");
      expect(result.kind === "message" && result.text).toContain("was not parsed");
    }
  });
});

describe("Explicit application configuration", () => {
  it("never switches missing live configuration into fixture mode", () => {
    expect(() => readConfig({ ASMO_DATABASE_PATH: "synthetic" })).toThrow();
    expect(() => readConfig({ ASMO_MODE: "live", ASMO_DATABASE_PATH: "synthetic" })).toThrow("Missing configuration: TELEGRAM_BOT_TOKEN");
  });
  it("keeps synthetic authentication on loopback only", () => {
    expect(readConfig({ ASMO_MODE: "fixture", ASMO_DATABASE_PATH: "synthetic" }).mode).toBe("fixture");
    expect(() => readConfig({ ASMO_MODE: "fixture", ASMO_DATABASE_PATH: "synthetic", ASMO_HOST: "0.0.0.0" })).toThrow("loopback");
  });
  it("uses separate SQLite defaults and rejects legacy-only database configuration", () => {
    expect(readConfig({ ASMO_MODE: "fixture" }).databasePath).toMatch(/work\/asmo-fixture\.sqlite$/);
    expect(() => readConfig({ ASMO_MODE: "fixture", ASMO_DATABASE_URL: "postgresql://legacy" })).toThrow("no longer supported");
    expect(() => readConfig({ ASMO_MODE: "fixture", ASMO_DATABASE_PATH: "postgresql://legacy" })).toThrow("local SQLite file path");
    expect(() => readConfig({ ASMO_MODE: "fixture", ASMO_DATABASE_PATH: "" })).toThrow("local SQLite file path");
  });

});
