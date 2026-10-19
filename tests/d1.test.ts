import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { connectD1Database } from "../src/store/d1.js";
import type { D1Database } from "../src/store/d1.js";
import { inDatabaseTransaction, prepareSql } from "../src/store/connection.js";
import { migrateDatabase, openStore } from "../src/store/index.js";
import { createMockD1 } from "./helpers/mock-d1.js";
import type { Command, Scope, Seed, Store, StoreOptions } from "../src/core.js";
import { schemaVersion } from "../src/store/schema.js";

describe("SQL parameter translation", () => {
  it("translates $workspace and numbered parameters to positional ?N placeholders", () => {
    const q1 = prepareSql("SELECT * FROM tasks WHERE workspace_id=$workspace AND scope_id=$1 AND id=$2", ["scope-a", "task-b"], "ws-root");
    expect(q1.sql).toBe("SELECT * FROM tasks WHERE workspace_id=?1 AND scope_id=?2 AND id=?3");
    expect(q1.bindings).toEqual(["ws-root", "scope-a", "task-b"]);
  });

  it("handles queries without workspace binding", () => {
    const q2 = prepareSql("SELECT workspace_id,id AS scope_id FROM scopes WHERE id=$1", ["scope-xyz"]);
    expect(q2.sql).toBe("SELECT workspace_id,id AS scope_id FROM scopes WHERE id=?1");
    expect(q2.bindings).toEqual(["scope-xyz"]);
  });

  it("deduplicates repeated parameter references into the same index", () => {
    const q3 = prepareSql(
      "INSERT INTO transcripts(workspace_id,scope_id,task_id,sequence,data) SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1,$4 FROM transcripts WHERE workspace_id=$workspace AND task_id=$3",
      ["ws-1", "scope-1", "task-1", "{}"]
    );
    expect(q3.sql).toBe("INSERT INTO transcripts(workspace_id,scope_id,task_id,sequence,data) SELECT ?1,?2,?3,COALESCE(MAX(sequence),0)+1,?4 FROM transcripts WHERE workspace_id=?5 AND task_id=?3");
    expect(q3.bindings).toEqual(["ws-1", "scope-1", "task-1", "{}", null]);
  });

  it("preserves zero-parameter statements untouched", () => {
    const q4 = prepareSql("PRAGMA user_version");
    expect(q4.sql).toBe("PRAGMA user_version");
    expect(q4.bindings).toEqual([]);
  });

  // A $ inside quoted text is literal data. Rewriting it into a placeholder corrupts the
  // statement and, because repeated $1 references dedupe to one binding, silently binds the
  // wrong value into a quoted identifier without shifting anything visible. Assert the
  // whole output string, not just that the trailing parameter translated.
  it.each([
    ["bracket identifier", "SELECT [price$1] FROM t WHERE id=$1", "SELECT [price$1] FROM t WHERE id=?1"],
    ["single-quoted literal", "SELECT 'cost $10 total' AS x WHERE id=$1", "SELECT 'cost $10 total' AS x WHERE id=?1"],
    ["double-quoted identifier", "SELECT \"col$2\" FROM t WHERE id=$1", "SELECT \"col$2\" FROM t WHERE id=?1"],
    ["backtick identifier", "SELECT `c$3` FROM t WHERE id=$1", "SELECT `c$3` FROM t WHERE id=?1"],
    ["json path", "SELECT data->>'$.detail.text' FROM t WHERE id=$1", "SELECT data->>'$.detail.text' FROM t WHERE id=?1"],
    ["line comment", "SELECT 1 -- keep $9\nWHERE id=$1", "SELECT 1 -- keep $9\nWHERE id=?1"],
    ["block comment", "SELECT 1 /* $8 */ WHERE id=$1", "SELECT 1 /* $8 */ WHERE id=?1"],
    ["bracket with doubled close", "SELECT [a]]b$4] FROM t WHERE id=$1", "SELECT [a]]b$4] FROM t WHERE id=?1"],
  ])("leaves a $ inside a %s alone", (_name, sql, expected) => {
    const q = prepareSql(sql, ["a"]);
    expect(q.sql).toBe(expected);
    expect(q.bindings).toEqual(["a"]);
  });

  it("rejects parameters that were never supplied", () => {
    expect(() => prepareSql("SELECT $1,$2", ["only-one"])).toThrow("SQL parameter $2 is out of range");
  });

  it("rejects named parameters D1 cannot bind", () => {
    expect(() => prepareSql("SELECT * FROM t WHERE kind=$kind", ["x"])).toThrow("Unknown SQL parameter $kind");
  });

  it("leaves unquoted column names containing a $ character uncorrupted", () => {
    const q = prepareSql("SELECT item$1 FROM t WHERE id=$1", ["val"]);
    expect(q.sql).toBe("SELECT item$1 FROM t WHERE id=?1");
    expect(q.bindings).toEqual(["val"]);
  });

  it("rejects positional ? placeholders", () => {
    expect(() => prepareSql("SELECT * FROM t WHERE id = ?", ["val"])).toThrow("Positional ? parameters are not supported");
  });

  it("rejects parameters with leading zeros or zero index", () => {
    expect(() => prepareSql("SELECT $0 FROM t", ["val"])).toThrow("Unknown SQL parameter $0");
    expect(() => prepareSql("SELECT $01 FROM t", ["val"])).toThrow("Unknown SQL parameter $01");
  });
});

describe("Cloudflare D1 migration", () => {
  it("records the schema version in a table and migrates idempotently", async () => {
    const rawDb = new DatabaseSync(":memory:");
    await migrateDatabase(createMockD1(rawDb));

    const version = rawDb.prepare("SELECT version FROM asmo_schema_meta WHERE name='schema'").get() as { version: number };
    expect(version.version).toBe(schemaVersion);

    await migrateDatabase(createMockD1(rawDb));
    expect(rawDb.prepare("SELECT version FROM asmo_schema_meta WHERE name='schema'").get()).toEqual({ version: schemaVersion });
    expect(rawDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workspaces'").get()).toEqual({ n: 1 });

    rawDb.close();
  });

  it("rejects a database whose schema is newer than this application", async () => {
    const rawDb = new DatabaseSync(":memory:");
    await migrateDatabase(createMockD1(rawDb));
    rawDb.exec(`UPDATE asmo_schema_meta SET version=99 WHERE name='schema'`);

    const conn = connectD1Database(createMockD1(rawDb));
    await expect(conn.migrate()).rejects.toThrow("newer than this application");
    rawDb.close();
  });

  it("treats a missing schema_meta table as unmigrated rather than failing", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const conn = connectD1Database(createMockD1(rawDb));
    await conn.migrate();
    expect(rawDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='jobs'").get()).toEqual({ n: 1 });
    rawDb.close();
  });

  it("rolls the whole migration back when one statement fails", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const broken: D1Database = {
      ...d1,
      prepare(query: string) {
        if (query.includes("CREATE TABLE jobs")) {
          return { ...d1.prepare(query), all: async () => { throw new Error("D1_ERROR: statement failed"); } };
        }
        return d1.prepare(query);
      },
    };
    const conn = connectD1Database(broken);
    await expect(conn.migrate()).rejects.toThrow("statement failed");
    // A batch is one unit, so no earlier CREATE TABLE survives.
    expect(rawDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()).toEqual({ n: 0 });
    rawDb.close();
  });

  it("refuses PRAGMA user_version, which workerd does not allow", async () => {
    const rawDb = new DatabaseSync(":memory:");
    await expect(createMockD1(rawDb).exec("PRAGMA user_version")).rejects.toThrow("SQLITE_AUTH");
    rawDb.close();
  });

  it("upgrades a v1 schema to v2 by creating messages_task index and updating meta version", async () => {
    const rawDb = new DatabaseSync(":memory:");
    await migrateDatabase(createMockD1(rawDb));
    rawDb.exec("DROP INDEX IF EXISTS messages_task");
    rawDb.exec("UPDATE asmo_schema_meta SET version=1 WHERE name='schema'");

    const beforeVersion = rawDb.prepare("SELECT version FROM asmo_schema_meta WHERE name='schema'").get() as { version: number };
    expect(beforeVersion.version).toBe(1);
    expect(rawDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='messages_task'").get()).toEqual({ n: 0 });

    const conn = connectD1Database(createMockD1(rawDb));
    await conn.migrate();

    const afterVersion = rawDb.prepare("SELECT version FROM asmo_schema_meta WHERE name='schema'").get() as { version: number };
    expect(afterVersion.version).toBe(2);
    expect(rawDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='messages_task'").get()).toEqual({ n: 1 });
    rawDb.close();
  });
});

describe("D1Connection execution", () => {
  it("decodes JSON and boolean columns correctly", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const conn = connectD1Database(createMockD1(rawDb));
    await conn.migrate();

    await conn.query("INSERT INTO workspaces(id,bot_id,owner_id,name,budget) VALUES($1,$2,$3,$4,$5)", ["ws-test", "bot-1", "owner-1", "Test", 50000]);
    await conn.query("INSERT INTO scopes(workspace_id,id,bot_id,chat_id,data) VALUES($1,$2,$3,$4,$5)", ["ws-test", "sc-1", "bot-1", "c-1", JSON.stringify({ name: "Scope 1" })]);
    await conn.query("INSERT INTO tasks(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4)", ["ws-test", "sc-1", "t-1", JSON.stringify({ state: "running" })]);
    await conn.query("INSERT INTO sources(workspace_id,scope_id,id,data,deleted) VALUES($1,$2,$3,$4,$5)", ["ws-test", "sc-1", "src-1", JSON.stringify({ text: "Fact" }), 1]);

    const res = await conn.query("SELECT id,data,deleted FROM sources WHERE workspace_id=$workspace AND id=$1", ["src-1"], "ws-test");
    expect(res.rows[0]?.data).toEqual({ text: "Fact" });
    expect(res.rows[0]?.deleted).toBe(true);

    rawDb.close();
  });

  it("serializes transactions on one D1 connection", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const conn = connectD1Database(createMockD1(rawDb));
    const events: string[] = [];
    let active = 0;
    let peak = 0;

    const run = async (label: string) => {
      active += 1;
      peak = Math.max(peak, active);
      events.push(`start:${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      events.push(`end:${label}`);
      active -= 1;
    };

    await Promise.all([
      inDatabaseTransaction(conn, () => run("first")),
      inDatabaseTransaction(conn, () => run("second")),
    ]);

    expect(peak).toBe(1);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);

    rawDb.close();
  });

  it("releases the gate so a later transaction still runs after one throws", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const conn = connectD1Database(createMockD1(rawDb));
    await expect(inDatabaseTransaction(conn, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(inDatabaseTransaction(conn, async () => "ok")).resolves.toBe("ok");
    rawDb.close();
  });

  it("lets a read see a write made earlier in the same callback", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const conn = connectD1Database(createMockD1(rawDb));
    await conn.migrate();
    await conn.query("INSERT INTO workspaces(id,bot_id,owner_id,name,budget) VALUES($1,$2,$3,$4,$5)", ["ws-1", "bot", "owner", "Name", 10]);
    await inDatabaseTransaction(conn, async () => {
      await conn.query("INSERT INTO scopes(workspace_id,id,bot_id,chat_id,data) VALUES($1,$2,$3,$4,$5)", ["ws-1", "sc-1", "bot", "chat", JSON.stringify({})]);
      // Every store transaction reads rows it wrote earlier, so this must see the insert.
      const found = await conn.query("SELECT id FROM scopes WHERE workspace_id=$workspace AND id=$1", ["sc-1"], "ws-1");
      expect(found.rows).toEqual([{ id: "sc-1" }]);
    });
    rawDb.close();
  });

  it("leases a job with a compare-and-swap so two claimers cannot both win", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const conn = connectD1Database(createMockD1(rawDb));
    await conn.migrate();
    await conn.query("INSERT INTO workspaces(id,bot_id,owner_id,name,budget) VALUES($1,$2,$3,$4,$5)", ["ws-1", "bot", "owner", "Name", 10]);
    await conn.query("INSERT INTO scopes(workspace_id,id,bot_id,chat_id,data) VALUES($1,$2,$3,$4,$5)", ["ws-1", "sc-1", "bot", "chat", JSON.stringify({})]);
    await conn.query("INSERT INTO jobs(workspace_id,scope_id,id,entity_id,kind,data,state,ready_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", ["ws-1", "sc-1", "job-1", "task-1", "model", "{}", "ready", 1]);

    const leaseSql = "UPDATE jobs SET state='leased',token=$2,worker_id=$3,expires_at=$4,attempts=attempts+1 WHERE workspace_id=$workspace AND id=$1 AND (state='ready' OR (state='leased' AND expires_at<=$5)) RETURNING id";
    const first = await conn.query(leaseSql, ["job-1", "token-a", "worker-a", 10_000, 5_000], "ws-1");
    expect(first.rows).toEqual([{ id: "job-1" }]);

    // Same statement with a second token must not take the job off the live lease.
    const second = await conn.query(leaseSql, ["job-1", "token-b", "worker-b", 10_000, 5_000], "ws-1");
    expect(second.rows).toEqual([]);

    rawDb.close();
  });
});

describe("Cloudflare D1 store lifecycle", () => {
  const storeOptions = (d1: D1Database, now: () => number): StoreOptions => ({
    d1,
    modelReserveMicros: 1000,
    maxOutputTokens: 2000,
    maxTurns: 12,
    taskBudgetMicros: 20_000,
    leaseMs: 10_000,
    simulated: true,
    clock: now,
  });

  it("runs a full command lifecycle through a D1 binding", async () => {
    const rawDb = new DatabaseSync(":memory:");
    let now = Date.now();
    const store: Store = await openStore(storeOptions(createMockD1(rawDb), () => now));
    const workspaceId = randomUUID();
    const scope: Scope = {
      id: randomUUID(),
      workspaceId,
      kind: "group",
      chatId: "-100123456789",
      ownerId: null,
      name: "D1 Team",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: now - 1000,
      budgetMicros: 100_000,
    };
    const seed: Seed = {
      botId: randomUUID(),
      workspaceId,
      name: "Cloudflare D1 Workspace",
      ownerId: "owner-user",
      budgetMicros: 200_000,
      scopes: [scope],
      memberships: [
        { scopeId: scope.id, userId: "member-user", role: "member" },
        { scopeId: scope.id, userId: "owner-user", role: "owner" },
      ],
      grants: [],
    };

    await store.seed(seed);
    const receipt = await store.command({
      scopeId: scope.id,
      userId: "member-user",
      key: "update-1",
      command: { kind: "start", instruction: "Port database layer to Cloudflare D1", topicId: null } as Command,
    });

    expect(receipt.kind).toBe("accepted");
    expect(receipt.taskId).toBeDefined();

    const taskView = await store.task(scope.id, "member-user", receipt.taskId!);
    expect(taskView.task.instruction).toBe("Port database layer to Cloudflare D1");
    expect(taskView.task.state).toBe("queued");

    const job = await store.claim("worker-edge-1", "model");
    expect(job).not.toBeNull();
    expect(job?.kind === "model" && job.input.task.id).toBe(receipt.taskId);

    await store.close();
    rawDb.close();
  });

  it("does not cache a failed store start", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    await connectD1Database(d1).migrate();
    rawDb.exec("UPDATE asmo_schema_meta SET version=99 WHERE name='schema'");
    await expect(openStore(storeOptions(d1, () => Date.now()))).rejects.toThrow("newer than this application");

    // Once the cause is gone the same binding must start again instead of replaying the error.
    rawDb.exec(`UPDATE asmo_schema_meta SET version=${schemaVersion} WHERE name='schema'`);
    const store = await openStore(storeOptions(d1, () => Date.now()));
    await store.close();
    rawDb.close();
  });

  it("rejects a store configured with both backends or neither", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const base = { modelReserveMicros: 1000, maxOutputTokens: 2000, maxTurns: 12, taskBudgetMicros: 20_000, leaseMs: 10_000, simulated: true };
    await expect(openStore({ ...base, databasePath: "work/both.sqlite", d1 })).rejects.toThrow("either databasePath or d1, not both");
    await expect(openStore({ ...base })).rejects.toThrow("requires either databasePath or d1");
    await expect(openStore({ ...base, d1: {} as D1Database })).rejects.toThrow("requires a Cloudflare D1 database binding");
    rawDb.close();
  });
});
