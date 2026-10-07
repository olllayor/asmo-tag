import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { migrationSql, schemaVersion } from "./schema.js";

type Row = Record<string, unknown>;
export interface Db {
  readonly workspaceId: string;
  query<T extends Row = Row>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
}
const gates = new Map<string, Promise<void>>();
const jsonColumns = new Set(["data", "receipt", "sources", "memories"]);
const booleanColumns = new Set(["deleted", "redacted", "settled", "expired"]);
function binding(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  throw new Error("Unsupported SQLite binding");
}
function decode(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonColumns.has(key) && typeof value === "string" ? JSON.parse(value) as unknown : booleanColumns.has(key) ? Boolean(value) : value]));
}
export class Connection {
  readonly database: DatabaseSync;
  readonly path: string;
  migrated = false;
  constructor(databasePath: string) {
    if (!databasePath.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(databasePath)) throw new Error("ASMO_DATABASE_PATH must be a local SQLite file path");
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
  close(): void { this.database.close(); }
}
export const connectDatabase = (path: string): Connection => new Connection(path);
export async function inDatabaseTransaction<T>(connection: Connection, operation: () => Promise<T>): Promise<T> {
  const previous = gates.get(connection.path) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(accept => { release = accept; });
  const gate = previous.then(() => pending);
  gates.set(connection.path, gate);
  await previous;
  try {
    if (!connection.migrated) {
      connection.database.exec("PRAGMA journal_mode=DELETE;");
    }
    connection.database.exec("BEGIN IMMEDIATE");
    try {
      if (!connection.migrated) {
        const row = connection.database.prepare("PRAGMA user_version").get();
        const currentVersion = Number(row?.user_version);
        if (currentVersion > schemaVersion) throw new Error("SQLite schema is newer than this application");
        if (currentVersion === 0) {
          connection.database.exec(migrationSql);
          connection.database.exec(`PRAGMA user_version=${schemaVersion}`);
        }
      }
      const result = await operation();
      connection.database.exec("COMMIT");
      connection.migrated = true;
      return result;
    } catch (error) { connection.database.exec("ROLLBACK"); throw error; }
  } finally {
    release();
    if (gates.get(connection.path) === gate) gates.delete(connection.path);
  }
}
