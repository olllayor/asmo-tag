import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { migrationSql, schemaUpgrades, schemaVersion } from "./schema.js";
import { binding, decode } from "./sql.js";
import type { Db, Row } from "./sql.js";
import { inD1Transaction } from "./d1.js";
import type { D1Connection } from "./d1.js";

// Pure SQL helpers live in ./sql.js so the edge worker can use them without pulling in
// node:sqlite/node:fs. They are re-exported here for existing importers.
export { binding, decode, prepareSql } from "./sql.js";
export type { Db, Row } from "./sql.js";

const gates = new Map<string, Promise<void>>();

export class Connection {
  readonly database: DatabaseSync;
  readonly path: string;
  migrated = false;
  constructor(databasePath: string) {
    if (!databasePath.trim() || /^[a-z][a-z0-9+.-]*:\/\/$/i.test(databasePath) || /^[a-z][a-z0-9+.-]*:\/\//i.test(databasePath)) throw new Error("ASMO_DATABASE_PATH must be a local SQLite file path");
    const absolute = resolve(databasePath);
    mkdirSync(dirname(absolute), { recursive: true });
    closeSync(openSync(absolute, "a", 0o600));
    this.database = new DatabaseSync(absolute);
    this.path = realpathSync(absolute);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  }
  query<T extends Row = Row>(sql: string, parameters: unknown[] = [], workspaceId?: string): { rows: T[] } {
    const statement = this.database.prepare(sql);
    statement.setAllowUnknownNamedParameters(true);
    const parametersByName: Record<string, SQLInputValue> = { $workspace: workspaceId ?? null };
    parameters.forEach((value, index) => { parametersByName[`$${index + 1}`] = binding(value); });
    return { rows: statement.all(parametersByName).map(row => decode(row) as T) };
  }
  context(workspaceId: string): Db {
    return { workspaceId, query: async <T extends Row = Row>(sql: string, parameters: unknown[] = []) => this.query<T>(sql, parameters, workspaceId) };
  }
  async discover<T>(sql: string, parameters: unknown[], schema: z.ZodType<T>): Promise<T[]> {
    return this.query(sql, parameters).rows.map(row => schema.parse(row));
  }
  // Applies the schema on first use. Callers run this inside their transaction so a partial
  // migration is rolled back with it.
  migrate(): void {
    if (this.migrated) return;
    const row = this.database.prepare("PRAGMA user_version").get();
    let currentVersion = Number(row?.user_version);
    if (currentVersion > schemaVersion) throw new Error("SQLite schema is newer than this application");
    if (currentVersion === 0) {
      this.database.exec(migrationSql);
      currentVersion = schemaVersion;
    } else {
      for (const upgrade of schemaUpgrades) {
        if (currentVersion >= upgrade.version) continue;
        this.database.exec(upgrade.statements.map(statement => `${statement};`).join("\n"));
        currentVersion = upgrade.version;
      }
    }
    this.database.exec(`PRAGMA user_version=${currentVersion}`);
    this.migrated = true;
  }
  close(): void { this.database.close(); }
}

export const connectDatabase = (path: string): Connection => new Connection(path);

// Local SQLite runs the operation inside BEGIN IMMEDIATE, so the whole unit is atomic and
// rolls back on failure. D1 has no interactive transactions: the only atomic unit is a
// batch(), and every store callback reads rows it wrote earlier in the same callback, so a
// batch cannot substitute for one. The D1 branch therefore serializes callbacks inside this
// isolate and lets each statement commit on its own. A failure mid-callback leaves the
// statements that already ran committed; there is no rollback. Cross-isolate safety comes
// from the conditional updates in claim/finish*, not from this gate.
export async function inDatabaseTransaction<T>(connection: Connection | D1Connection, operation: () => Promise<T>): Promise<T> {
  if ("isD1" in connection && connection.isD1) {
    return inD1Transaction(connection, operation);
  }

  const conn = connection as Connection;
  const previous = gates.get(conn.path) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(accept => { release = accept; });
  const gate = previous.then(() => pending);
  gates.set(conn.path, gate);
  await previous;
  try {
    if (!conn.migrated) {
      conn.database.exec("PRAGMA journal_mode=DELETE;");
    }
    conn.database.exec("BEGIN IMMEDIATE");
    try {
      conn.migrate();
      const result = await operation();
      conn.database.exec("COMMIT");
      return result;
    } catch (error) { conn.database.exec("ROLLBACK"); throw error; }
  } finally {
    release();
    if (gates.get(conn.path) === gate) gates.delete(conn.path);
  }
}
