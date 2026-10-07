import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { migrateDatabase, openStore } from "../src/store/index.js";
import type { Connection } from "../src/store/connection.js";
import { connectDatabase, inDatabaseTransaction } from "../src/store/connection.js";

describe("SQLite migration and durability policy", () => {
  it("initializes a private versioned database and keeps repeated migrations idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "asmo-migration-"));
    const path = join(directory, "nested", "database.sqlite");
    try {
      await Promise.all([migrateDatabase(path), migrateDatabase(path)]);
      const db = new DatabaseSync(path);
      try {
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
        expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      } finally { db.close(); }
      const connection = connectDatabase(path);
      try {
        expect(connection.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
        expect(connection.database.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
        expect(connection.database.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        await expect(inDatabaseTransaction(connection, async () => {
          await connection.context("rolled-back").query("INSERT INTO workspaces(id,bot_id,owner_id,name,budget) VALUES($1,'bot','owner','rollback',100)", ["rolled-back"]);
          throw new Error("Injected transaction failure");
        })).rejects.toThrow("Injected transaction failure");
        expect(connection.database.prepare("SELECT count(*) AS count FROM workspaces").get()?.count).toBe(0);
      } finally { connection.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects unsupported future schema versions without modifying their data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "asmo-future-schema-"));
    const path = join(directory, "database.sqlite");
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA user_version=2; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('retained');");
      db.close();
      await expect(openStore({ databasePath: path, modelReserveMicros: 1000, maxOutputTokens: 1024, maxTurns: 4, taskBudgetMicros: 10000, leaseMs: 1000, simulated: true })).rejects.toThrow("newer than this application");
      const inspect = new DatabaseSync(path);
      try { expect(inspect.prepare("SELECT value FROM future_data").get()?.value).toBe("retained"); }
      finally { inspect.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("closes the store handle when the shutdown transaction cannot acquire its lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "asmo-close-busy-"));
    const path = join(directory, "database.sqlite");
    const store = await openStore({ databasePath: path, modelReserveMicros: 1000, maxOutputTokens: 1024, maxTurns: 4, taskBudgetMicros: 10000, leaseMs: 1000, simulated: true });
    const connection = (store as typeof store & { connection: Connection }).connection;
    connection.database.exec("PRAGMA busy_timeout=1");
    const blocker = new DatabaseSync(path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      await expect(store.close()).rejects.toThrow("database is locked");
      expect(() => connection.database.prepare("SELECT 1")).toThrow("database is not open");
    } finally { blocker.exec("ROLLBACK"); blocker.close(); await rm(directory, { recursive: true, force: true }); }
  });

});
