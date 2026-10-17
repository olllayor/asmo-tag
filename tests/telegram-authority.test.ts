import { describe, expect, it, vi, type Mock } from "vitest";
import { TelegramAuthority } from "../src/telegram/messenger.js";
import type { Api } from "grammy";
import type { Scope, Store } from "../src/core.js";

const scope: Scope = { id: "scope-1", workspaceId: "ws", kind: "group", chatId: "-100", ownerId: null, name: "Group", active: true, workspacePublic: false, timezone: "Etc/UTC", policyRevision: 1, collectedSince: 0, budgetMicros: 0 };
const store = { membership: vi.fn(async () => {}) } as unknown as Store;
function authorityWith(member: Mock<() => Promise<unknown>>, bot: Mock<() => Promise<unknown>>) {
  return new TelegramAuthority("1:t", "999", store, {
    getChatMember: (_chatId: number | string, userId: number) => userId === 999 ? bot() : member(),
  } as unknown as Api);
}
const botAdmin = { status: "administrator" };

describe("TelegramAuthority caching", () => {
  it("coalesces concurrent refreshes for the same scope and user into one member check", async () => {
    const member = vi.fn(async () => ({ status: "member" }));
    const authority = authorityWith(member, vi.fn(async () => botAdmin));
    await Promise.all([authority.refresh(scope, "101"), authority.refresh(scope, "101"), authority.refresh(scope, "101")]);
    expect(member).toHaveBeenCalledTimes(1);
    expect(store.membership).toHaveBeenCalledWith("scope-1", "101", "member");
  });

  it("serves repeated refreshes from the cache within the TTL and keeps the bot check shared", async () => {
    const member = vi.fn(async () => ({ status: "member" }));
    const bot = vi.fn(async () => botAdmin);
    const authority = authorityWith(member, bot);
    await authority.refresh(scope, "101");
    await authority.refresh(scope, "101");
    await authority.refresh(scope, "102");
    expect(member).toHaveBeenCalledTimes(2);
    expect(bot).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last-known role instead of failing when Telegram rate-limits", async () => {
    const member = vi.fn(async () => ({ status: "member" })).mockRejectedValueOnce(new Error("Too Many Requests: retry after 5"));
    const authority = authorityWith(member, vi.fn(async () => botAdmin));
    await expect(authority.refresh(scope, "101")).rejects.toThrow("Too Many Requests");
    await expect(authority.refresh(scope, "101")).resolves.toBeUndefined();
    expect(store.membership).toHaveBeenLastCalledWith("scope-1", "101", "member");
  });

  it("still denies when the first observation fails and nothing is known", async () => {
    const member = vi.fn(async () => { throw new Error("Too Many Requests: retry after 5"); });
    const authority = authorityWith(member, vi.fn(async () => botAdmin));
    await expect(authority.refresh(scope, "101")).rejects.toThrow("Too Many Requests");
    expect(store.membership).not.toHaveBeenCalled();
  });

  it("persists and denies a non-member without consulting stale knowledge", async () => {
    const member = vi.fn(async () => ({ status: "kicked" }));
    const authority = authorityWith(member, vi.fn(async () => botAdmin));
    await expect(authority.refresh(scope, "101")).rejects.toThrow("Access denied.");
    expect(store.membership).toHaveBeenCalledWith("scope-1", "101", null);
  });
});
