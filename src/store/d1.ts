// Experimental D1 storage backend. Not the supported deployment. Read
// docs/engineering/edge-experimental.md before changing this file.
import type { Db, Row } from "./sql.js";
import { binding, decode, prepareSql } from "./sql.js";
import { migrationStatements, schemaVersion } from "./schema.js";
import type { z } from "zod";

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<{ success: boolean; results?: T[]; meta?: unknown; error?: string }>;
  all<T = unknown>(): Promise<{ success: boolean; results: T[]; meta?: unknown; error?: string }>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<{ success: boolean; results?: T[] }[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

const schemaMetaTable = "asmo_schema_meta";

// D1 rejects PRAGMA user_version with "not authorized: SQLITE_AUTH" (verified against
// workerd), so the schema version is stored in a table instead. table_list is one of the
// PRAGMAs D1 does allow.
async function schemaVersionOf(database: D1Database): Promise<number> {
  const tables = await database.prepare("PRAGMA table_list").all<{ name: string }>();
  if (!(tables.results ?? []).some(row => row.name === schemaMetaTable)) return 0;
  const row = await database.prepare(`SELECT version FROM ${schemaMetaTable} WHERE name='schema'`).first<{ version: number }>();
  return Number(row?.version ?? 0);
}

export class D1Connection {
  readonly isD1 = true;
  migrated = false;

  constructor(readonly database: D1Database) {}

  async query<T extends Row = Row>(sql: string, parameters: unknown[] = [], workspaceId?: string): Promise<{ rows: T[] }> {
    const { sql: preparedSql, bindings } = prepareSql(sql, parameters, workspaceId);
    const stmt = this.database.prepare(preparedSql);
    const bound = bindings.length > 0 ? stmt.bind(...bindings.map(binding)) : stmt;
    const result = await bound.all<Record<string, unknown>>();
    return { rows: (result.results ?? []).map(row => decode(row) as T) };
  }

  context(workspaceId: string): Db {
    return {
      workspaceId,
      query: <T extends Row = Row>(sql: string, parameters: unknown[] = []) => this.query<T>(sql, parameters, workspaceId),
    };
  }

  async discover<T>(sql: string, parameters: unknown[], schema: z.ZodType<T>): Promise<T[]> {
    const result = await this.query(sql, parameters);
    return result.rows.map(row => schema.parse(row));
  }

  // Migrations run as a single batch. D1 guarantees a batch commits as one unit, so a
  // failure halfway through leaves the database untouched, which exec() cannot promise.
  async migrate(): Promise<void> {
    if (this.migrated) return;
    const currentVersion = await schemaVersionOf(this.database);
    if (currentVersion > schemaVersion) throw new Error("SQLite schema is newer than this application");
    if (currentVersion < schemaVersion) {
      const statements = [
        `CREATE TABLE IF NOT EXISTS ${schemaMetaTable}(name TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL)`,
        ...migrationStatements,
        `INSERT INTO ${schemaMetaTable}(name,version) VALUES('schema',${schemaVersion}) ON CONFLICT(name) DO UPDATE SET version=${schemaVersion}`,
      ];
      await this.database.batch(statements.map(sql => this.database.prepare(sql)));
    }
    this.migrated = true;
  }

  async close(): Promise<void> {}
}

export const isD1Database = (value: unknown): value is D1Database =>
  typeof value === "object" && value !== null && typeof (value as { prepare?: unknown }).prepare === "function";

export const connectD1Database = (database: D1Database): D1Connection => new D1Connection(database);

const d1Gates = new WeakMap<object, Promise<void>>();

// D1 has no interactive transactions: the only atomic unit is a batch(), and every store
// callback reads rows it wrote earlier in the same callback, so a batch cannot substitute
// for one. This serializes callbacks inside this isolate and lets each statement commit
// on its own. A failure mid-callback leaves the statements that already ran committed;
// there is no rollback. Cross-isolate safety comes from the conditional updates in
// claim/finish*, not from this gate. Lives here (not in ./connection.js) so the edge
// worker can use it without importing node:sqlite/node:fs.
export async function inD1Transaction<T>(connection: D1Connection, operation: () => Promise<T>): Promise<T> {
  const previous = d1Gates.get(connection) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(accept => { release = accept; });
  const gate = previous.then(() => pending);
  d1Gates.set(connection, gate);
  await previous;
  try {
    await connection.migrate();
    return await operation();
  } finally {
    release();
    if (d1Gates.get(connection) === gate) d1Gates.delete(connection);
  }
}
