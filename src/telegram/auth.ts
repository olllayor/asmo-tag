import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateInitData(initData: string, botToken: string, now = Date.now()): string {
  if (initData.length > 16384) throw new Error("Invalid Telegram authentication.");
  const fields = new URLSearchParams(initData);
  const keys = [...fields.keys()];
  if (new Set(keys).size !== keys.length) throw new Error("Invalid Telegram authentication.");
  const hash = fields.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid Telegram authentication.");
  fields.delete("hash");
  const data = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(data).digest("hex");
  if (!equalSecret(expected, hash.toLowerCase())) throw new Error("Invalid Telegram authentication.");
  const authDate = z.coerce.number().int().positive().parse(fields.get("auth_date"));
  const age = now / 1000 - authDate;
  if (age < -30 || age > 3600) throw new Error("Telegram authentication expired. Reopen the Mini App.");
  const user = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.boolean().optional() }).parse(JSON.parse(fields.get("user") ?? "null"));
  if (user.is_bot) throw new Error("Invalid Telegram authentication.");
  return String(user.id);
}
