import { randomUUID } from "node:crypto";
import type { Scope, Seed, Store } from "./core.js";

export const fixtureBot = { id: "999", username: "asmo_fixture_bot" };
export const fixtureActors = new Set(["100", "101", "102", "103", "200", "201"]);
export const fixtureScope = "engineering";
function scope(id: string, workspaceId: string, chatId: string, name: string, ownerId: string | null = null): Scope {
  return { id, workspaceId, chatId, name, ownerId, kind: ownerId ? "dm" : "group", active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: Date.now(), budgetMicros: 50000000 };
}

export async function seedFixture(store: Store): Promise<void> {
  const atlas: Seed = {
    botId: fixtureBot.id, workspaceId: "ws_atlas", name: "Atlas demo team", ownerId: "100", budgetMicros: 100000000,
    scopes: [scope("engineering", "ws_atlas", "-100100", "Engineering"), scope("operations", "ws_atlas", "-100200", "Operations"), scope("maya_dm", "ws_atlas", "101", "Maya's private work", "101"), scope("sam_dm", "ws_atlas", "102", "Sam's private work", "102")],
    memberships: [
      { scopeId: "engineering", userId: "100", role: "owner" }, { scopeId: "engineering", userId: "101", role: "member" }, { scopeId: "engineering", userId: "102", role: "manager" },
      { scopeId: "operations", userId: "100", role: "owner" }, { scopeId: "maya_dm", userId: "101", role: "member" }, { scopeId: "sam_dm", userId: "102", role: "member" },
    ],
    grants: [{ id: "atlas_checkout", scopeId: "engineering", repository: "atlas/checkout", read: true, write: true, active: true, revision: 1 }],
  };
  const other: Seed = {
    botId: fixtureBot.id, workspaceId: "ws_other", name: "Other demo workspace", ownerId: "200", budgetMicros: 100000000,
    scopes: [scope("other_team", "ws_other", "-100300", "Other workspace")],
    memberships: [{ scopeId: "other_team", userId: "200", role: "owner" }, { scopeId: "other_team", userId: "201", role: "member" }], grants: [],
  };
  for (const seed of [atlas, other]) {
    const first = seed.scopes[0];
    if (first && !await store.resolveChat(fixtureBot.id, first.chatId)) await store.seed(seed);
  }
  const entries = [
    { chatId: "-100100", userId: "101", text: "EU checkout fails with 422 when two eligible coupons are added. One coupon succeeds.", messageId: 42 },
    { chatId: "-100100", userId: "102", text: "The last EU deploy changed coupon validation. This is a lead to investigate, not a proven root cause.", messageId: 43 },
    { chatId: "-100200", userId: "100", text: "PRIVATE OPERATIONS: incident-review staffing is confidential.", messageId: 50 },
    { chatId: "101", userId: "101", text: "PRIVATE MAYA: interview notes belong only in my DM.", messageId: 60 },
    { chatId: "102", userId: "102", text: "PRIVATE SAM: personal calendar notes belong only in my DM.", messageId: 70 },
    { chatId: "-100300", userId: "201", text: "OTHER TENANT SECRET: do not publish outside this workspace.", messageId: 80 },
  ];
  for (const [index, entry] of entries.entries()) await store.ingest({ ...entry, kind: "message", botId: fixtureBot.id, updateId: 10000 + index, topicId: null, mentioned: false, replyTo: null, edited: false });
}

export async function startFixtureTask(store: Store) {
  return store.ingest({ kind: "message", botId: fixtureBot.id, updateId: 11000, chatId: "-100100", userId: "101", messageId: 100, topicId: null, text: "@asmo_fixture_bot investigate the EU coupon failure and draft a GitHub issue in atlas/checkout. Cite the captured evidence.", mentioned: true, replyTo: 42, edited: false });
}

export async function enrichFixture(store: Store): Promise<void> {
  const current = await store.view(fixtureScope, "100");
  if (!current.memories.length) await store.command({ scopeId: fixtureScope, userId: "101", key: "fixture-memory-v1", command: { kind: "remember", content: "EU coupon investigations must distinguish observations from suspected causes.", evidenceIds: current.tasks[0]?.sources.slice(0, 1).map(source => source.id) ?? [], candidate: false } });
  if (!current.routines.length) await store.command({ scopeId: fixtureScope, userId: "102", key: "fixture-routine-v1", command: { kind: "create_routine", instruction: "Summarize captured release risks with source citations. Do not create an issue.", timezone: "UTC", nextAt: Date.now() + 86400000, intervalMs: 86400000, budgetMicros: 500000 } });
}

export const fixtureKey = () => randomUUID();
