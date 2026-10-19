import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Api, GrammyError } from "grammy";
import type { InlineKeyboardButton, InputRichMessage } from "grammy/types";
import { AbortController as TelegramAbortController } from "abort-controller";
import { z } from "zod";
import type { Delivery, Messenger, Scope, Store } from "../core.js";

const richTextLimit = 32768;
const truncationNotice = "\n\nFull saved result is available in the task inspector.";

function plainRichMessage(text: string): InputRichMessage {
  return { blocks: [{ type: "paragraph", text }], skip_entity_detection: true };
}

// Count Unicode characters for rich messages, and never split a UTF-16 surrogate pair.
function deliveryContent(delivery: Delivery) {
  if (delivery.format === "markdown") {
    const characters = Array.from(delivery.text);
    const truncated = characters.length > richTextLimit;
    const text = truncated ? characters.slice(0, richTextLimit - truncationNotice.length).join("") + truncationNotice : delivery.text;
    // Rich Markdown accepts HTML actions and media. Keep those model outputs literal.
    const literal = text.includes("<") || text.includes("![");
    return { text, truncated, rich: literal || truncated ? plainRichMessage(text) : { markdown: text } satisfies InputRichMessage };
  }
  const truncated = delivery.text.length > 4000;
  let text = delivery.text;
  if (truncated) {
    const end = /[\uD800-\uDBFF]/u.test(text[3799] ?? "") ? 3799 : 3800;
    text = text.slice(0, end) + truncationNotice;
  }
  return { text, truncated, rich: undefined };
}

function richFormattingRejected(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400 && /(?:can't parse|cannot parse|failed to parse|invalid rich message|too many blocks|too many columns|nesting.*(?:limit|deep)|message is too long|message text is too long)/i.test(error.description);
}

export function telegramReplyMarkup(delivery: Delivery, miniAppLink?: string) {
  const rows: InlineKeyboardButton[][] = delivery.buttons.map(button => [{ text: button.text, callback_data: button.data }]);
  if (miniAppLink && (delivery.purpose === "settings" || deliveryContent(delivery).truncated)) {
    rows.push([{ text: delivery.purpose === "settings" ? "Configure" : "Open full answer", url: `${miniAppLink}?startapp=${encodeURIComponent(`c_${delivery.taskId ?? delivery.scopeId}`)}` }]);
  }
  return { inline_keyboard: rows };
}

export function createTelegramMessenger(token: string, miniAppLink?: string): Messenger {
  const api = new Api(token, { timeoutSeconds: 30 });
  return {
    simulated: false,
    async send(delivery, signal) {
      signal.throwIfAborted();
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const { text, rich } = deliveryContent(delivery);
      const reply_markup = telegramReplyMarkup(delivery, miniAppLink);
      try {
        if (delivery.messageId !== null) {
          try {
            try { await api.editMessageText(delivery.chatId, delivery.messageId, rich ?? text, { reply_markup }, controller.signal); }
            catch (error) {
              if (!rich?.markdown || !richFormattingRejected(error)) throw error;
              signal.throwIfAborted();
              await api.editMessageText(delivery.chatId, delivery.messageId, plainRichMessage(text), { reply_markup }, controller.signal);
            }
          } catch (error) {
            if (!(error instanceof GrammyError && error.error_code === 400 && error.description.includes("message is not modified"))) throw error;
          }
          return { messageId: delivery.messageId };
        }
        const options = {
          reply_markup, ...(delivery.topicId !== null ? { message_thread_id: delivery.topicId } : {}),
          ...(delivery.replyTo !== undefined ? { reply_parameters: { message_id: delivery.replyTo, allow_sending_without_reply: true } } : {}),
        };
        if (rich) {
          try {
            const result = await api.sendRichMessage(delivery.chatId, rich, options, controller.signal);
            return { messageId: result.message_id };
          } catch (error) {
            if (!rich.markdown || !richFormattingRejected(error)) throw error;
            signal.throwIfAborted();
            const result = await api.sendRichMessage(delivery.chatId, plainRichMessage(text), options, controller.signal);
            return { messageId: result.message_id };
          }
        }
        const result = await api.sendMessage(delivery.chatId, text, options, controller.signal);
        return { messageId: result.message_id };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

export function createFixtureMessenger(directory: string): Messenger {
  return {
    simulated: true,
    async send(delivery) {
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${delivery.id}.json`);
      try {
        return z.object({ messageId: z.number().int() }).parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const messageId = delivery.messageId ?? Number.parseInt(delivery.id.replace(/[^a-f0-9]/gi, "").slice(0, 10), 16) % 1000000000;
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ ...delivery, messageId, simulated: true }), { flag: "wx" });
      await rename(temp, path);
      return { messageId };
    },
  };
}

// Membership observations are cached briefly so floods, webhook redelivery, and Mini App
// polling cannot drain the bot's Telegram API budget. Callers share in-flight checks, and a
// Telegram outage falls back to the last-known role instead of failing every request.
const memberTtlMs = 5_000;
const memberStaleLimitMs = 300_000;
const botTtlMs = 60_000;
const maxMemberEntries = 5_000;
const maxConcurrentChecks = 4;

type MemberEntry = { role?: "manager" | "member" | null; at: number; generation: number; promise?: Promise<"manager" | "member" | null> };

export class TelegramAuthority {
  private readonly api: Api;
  private readonly members = new Map<string, MemberEntry>();
  private readonly bots = new Map<string, { at: number; promise: Promise<void> }>();
  private active = 0;
  private readonly queued: (() => void)[] = [];
  private generation = 0;

  constructor(token: string, private readonly botId: string, private readonly store: Store, api: Api = new Api(token, { timeoutSeconds: 20 })) { this.api = api; }

  // A pushed membership update is itself a fresh observation. Without this the cached role
  // survives a demotion and refresh writes it back over the row the update just cleared.
  observe(scopeId: string, userId: string, role: "manager" | "member" | null): void {
    const key = `${scopeId}:${userId}`;
    const generation = ++this.generation;
    const existing = this.members.get(key);
    if (existing) {
      existing.role = role;
      existing.at = Date.now();
      existing.generation = generation;
      return;
    }
    if (this.members.size >= maxMemberEntries) {
      for (const [k, candidate] of this.members) {
        if (candidate.promise === undefined) {
          this.members.delete(k);
          break;
        }
      }
    }
    if (this.members.size >= maxMemberEntries) {
      for (const [k] of this.members) {
        this.members.delete(k);
        break;
      }
    }
    this.members.set(key, { role, at: Date.now(), generation });
  }

  invalidateBot(chatId: string): void { this.bots.delete(chatId); }

  // True when the last successful observation can still authorize intake. The webhook checks
  // this so a swallowed refresh failure cannot extend the stale window with the outage.
  recent(scope: Scope, userId: string): boolean {
    if (scope.kind === "dm") return scope.ownerId === userId;
    if (scope.kind !== "group") return false;
    const last = this.members.get(`${scope.id}:${userId}`);
    return last?.role != null && Date.now() - last.at <= memberStaleLimitMs;
  }

  async refresh(scope: Scope, userId: string): Promise<void> {
    if (scope.kind === "dm") {
      if (scope.ownerId !== userId) throw new Error("Access denied.");
      return;
    }
    if (scope.kind !== "group") throw new Error("Access denied.");
    await this.botAdmin(scope.chatId);
    const key = `${scope.id}:${userId}`;
    const initialEntry = this.members.get(key);
    const initialGen = initialEntry?.generation ?? 0;
    let role: "manager" | "member" | null;
    try {
      role = await this.memberRole(scope, userId);
    } catch (error) {
      const last = this.members.get(key);
      if (last?.role == null || Date.now() - last.at > memberStaleLimitMs) throw error;
      console.error("Membership refresh failed. Continuing with the last-known role.");
      role = last.role;
    }
    const currentEntry = this.members.get(key);
    // A generation bump means a newer observation landed while this check ran. Its role,
    // including an explicit null demotion, replaces the in-flight result; an undefined role
    // belongs to a reset check whose outcome was never observed, so keep the fresh result.
    if (currentEntry && currentEntry.generation !== initialGen && currentEntry.role !== undefined) {
      role = currentEntry.role;
    }
    await this.store.membership(scope.id, userId, role);
    if (role === null) throw new Error("Access denied.");
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.queued.length >= maxMemberEntries) throw new Error("Membership check capacity reached.");
    while (this.active >= maxConcurrentChecks) await new Promise<void>(resolve => this.queued.push(resolve));
    this.active++;
    try { return await work(); } finally { this.active--; this.queued.shift()?.(); }
  }

  private botAdmin(chatId: string): Promise<void> {
    const cached = this.bots.get(chatId);
    if (cached && Date.now() - cached.at < botTtlMs) return cached.promise;
    if (!cached && this.bots.size >= maxMemberEntries) {
      for (const [k] of this.bots) {
        this.bots.delete(k);
        break;
      }
    }
    if (!cached && this.bots.size >= maxMemberEntries) {
      throw new Error("Bot check capacity reached.");
    }
    const entry = { at: Date.now(), promise: this.limited(async () => {
      const bot = await this.api.getChatMember(chatId, Number(this.botId));
      if (bot.status !== "administrator" && bot.status !== "creator") throw new Error("Asmo needs administrator membership for reliable member checks.");
    }) };
    this.bots.set(chatId, entry);
    // A failed check is not an observation, so drop it and re-check on the next refresh.
    entry.promise.catch(() => { if (this.bots.get(chatId) === entry) this.bots.delete(chatId); });
    return entry.promise;
  }

  private memberRole(scope: Scope, userId: string): Promise<"manager" | "member" | null> {
    const key = `${scope.id}:${userId}`;
    const cached = this.members.get(key);
    if (cached?.promise) return cached.promise;
    if (cached?.role !== undefined && Date.now() - cached.at < memberTtlMs) return Promise.resolve(cached.role);
    if (!cached) {
      if (this.members.size >= maxMemberEntries) {
        for (const [k, candidate] of this.members) {
          if (candidate.promise === undefined) {
            this.members.delete(k);
            break;
          }
        }
      }
      if (this.members.size >= maxMemberEntries) {
        throw new Error("Membership check capacity reached.");
      }
    }
    const entry: MemberEntry = cached ?? { at: 0, generation: ++this.generation };
    const checkGen = entry.generation;
    entry.promise = this.limited(async () => {
      const member = await this.api.getChatMember(scope.chatId, Number(userId));
      return ["creator", "administrator"].includes(member.status) ? "manager" : member.status === "member" || (member.status === "restricted" && member.is_member) ? "member" : null;
    });
    if (!cached) this.members.set(key, entry);
    entry.promise.then(role => {
      if (entry.generation === checkGen) {
        entry.role = role;
        entry.at = Date.now();
      }
    }).catch(() => { /* keep the last-known observation for the stale fallback */ }).finally(() => { delete entry.promise; });
    return entry.promise;
  }
}
