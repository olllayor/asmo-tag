import { Api, GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Delivery } from "../src/core.js";
import { createTelegramMessenger, telegramReplyMarkup } from "../src/telegram/messenger.js";

const delivery: Delivery = {
  id: "delivery", taskId: "task", scopeId: "scope", chatId: "-100", topicId: 7,
  text: "# Result\n\n**Done**\n\n| Item | State |\n| --- | --- |\n| Test | Passed |\n\n- [x] Checked\n\n> Evidence\n\n```ts\nconst ok = true;\n```",
  buttons: [{ text: "Approve", data: "approve:exact-action" }], messageId: null, replyTo: 20, format: "markdown",
};
const message = { message_id: 42, date: 0, chat: { id: -100, type: "supergroup" as const, title: "Test" } };
const reply = { ...message, rich_message: { blocks: [{ type: "paragraph" as const, text: "Result" }] } };
const token = "123456:synthetic-token";
const options = {
  reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve:exact-action" }]] },
  message_thread_id: 7, reply_parameters: { message_id: 20, allow_sending_without_reply: true },
};
const send = (value = delivery, signal = new AbortController().signal) => createTelegramMessenger(token).send(value, signal);
const rejected = (description: string, error_code = 400) => new GrammyError("Synthetic API error", { ok: false, error_code, description }, "sendRichMessage", {});

afterEach(() => vi.restoreAllMocks());

describe("Telegram rich response delivery", () => {
  it("sends GFM directly through the new API with the original reply routing and controls", async () => {
    const rich = vi.spyOn(Api.prototype, "sendRichMessage").mockResolvedValue(reply);
    const plain = vi.spyOn(Api.prototype, "sendMessage");
    expect(await send()).toEqual({ messageId: 42 });
    expect(rich).toHaveBeenCalledExactlyOnceWith("-100", { markdown: delivery.text }, options, expect.anything());
    expect(plain).not.toHaveBeenCalled();
  });

  it("edits with rich content and still accepts an unchanged message", async () => {
    const edit = vi.spyOn(Api.prototype, "editMessageText").mockResolvedValue(true);
    expect(await send({ ...delivery, messageId: 42 })).toEqual({ messageId: 42 });
    expect(edit).toHaveBeenCalledExactlyOnceWith("-100", 42, { markdown: delivery.text }, { reply_markup: options.reply_markup }, expect.anything());
    edit.mockRejectedValue(rejected("Bad Request: message is not modified"));
    expect(await send({ ...delivery, messageId: 42 })).toEqual({ messageId: 42 });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it.each(["Can't parse rich message", "Too many blocks", "Message is too long"])("retries a rejected Markdown payload as literal rich text: %s", async description => {
    const rich = vi.spyOn(Api.prototype, "sendRichMessage").mockRejectedValueOnce(rejected(description)).mockResolvedValue(reply);
    expect(await send()).toEqual({ messageId: 42 });
    expect(rich).toHaveBeenNthCalledWith(2, "-100", { blocks: [{ type: "paragraph", text: delivery.text }], skip_entity_detection: true }, options, expect.anything());
  });

  it("keeps the existing rich message type on a failed edit", async () => {
    const edit = vi.spyOn(Api.prototype, "editMessageText").mockRejectedValueOnce(rejected("Can't parse rich message")).mockResolvedValue(true);
    await send({ ...delivery, messageId: 42 });
    expect(edit).toHaveBeenNthCalledWith(2, "-100", 42, { blocks: [{ type: "paragraph", text: delivery.text }], skip_entity_detection: true }, { reply_markup: options.reply_markup }, expect.anything());
  });

  it.each([rejected("Chat not found"), rejected("Too Many Requests", 429), new Error("Network failed")])("propagates unrelated failures without another send", async error => {
    const rich = vi.spyOn(Api.prototype, "sendRichMessage").mockRejectedValue(error);
    await expect(send()).rejects.toBe(error);
    expect(rich).toHaveBeenCalledTimes(1);
  });

  it.each(["<tg-button type=\"callback_data\" data=\"approve:other\">Approve</tg-button>", "![photo](https://example.com/image.jpg)", "```html\n<div>literal code</div>\n```"])("keeps HTML, inline actions and media syntax literal: %s", async text => {
    const rich = vi.spyOn(Api.prototype, "sendRichMessage").mockResolvedValue(reply);
    await send({ ...delivery, text });
    expect(rich).toHaveBeenCalledWith("-100", { blocks: [{ type: "paragraph", text }], skip_entity_detection: true }, options, expect.anything());
  });

  it("keeps long rich answers intact and truncates by Unicode characters with an inspector link", async () => {
    const rich = vi.spyOn(Api.prototype, "sendRichMessage").mockResolvedValue(reply);
    const text = "😀".repeat(32768);
    await send({ ...delivery, text });
    expect(rich.mock.calls[0]?.[1]).toEqual({ markdown: text });
    expect(telegramReplyMarkup({ ...delivery, text }, "https://t.me/bot/app").inline_keyboard).toEqual(options.reply_markup.inline_keyboard);
    await send({ ...delivery, text: text + "😀" });
    const payload = rich.mock.calls[1]?.[1];
    expect(payload?.blocks?.[0]).toMatchObject({ type: "paragraph" });
    const block = payload?.blocks?.[0];
    if (block?.type !== "paragraph" || typeof block.text !== "string") throw new Error("Literal fallback missing");
    expect(Array.from(block.text)).toHaveLength(32768);
    expect(block.text).toContain("Full saved result is available");
    expect(block.text).not.toContain("\uFFFD");
    expect(telegramReplyMarkup({ ...delivery, text: text + "😀" }, "https://t.me/bot/app").inline_keyboard.at(-1)).toEqual([{ text: "Open full answer", url: "https://t.me/bot/app?startapp=c_task" }]);
  });

  it("keeps control and exact approval deliveries plain, with safe legacy truncation", async () => {
    const plain = vi.spyOn(Api.prototype, "sendMessage").mockResolvedValue({ ...message, text: "Literal" });
    const rich = vi.spyOn(Api.prototype, "sendRichMessage");
    await send({ ...delivery, format: undefined });
    expect(plain).toHaveBeenCalledWith("-100", delivery.text, options, expect.anything());
    await send({ ...delivery, format: undefined, text: "a".repeat(3799) + "😀" + "a".repeat(300) });
    expect(plain.mock.calls[1]?.[1]).toBe("a".repeat(3799) + "\n\nFull saved result is available in the task inspector.");
    expect(rich).not.toHaveBeenCalled();
  });

  it("does not retry when cancellation happens during a parse rejection", async () => {
    const controller = new AbortController();
    const rich = vi.spyOn(Api.prototype, "sendRichMessage").mockImplementation(async () => {
      controller.abort();
      throw rejected("Can't parse rich message");
    });
    await expect(send(delivery, controller.signal)).rejects.toThrow();
    expect(rich).toHaveBeenCalledTimes(1);
  });
});
