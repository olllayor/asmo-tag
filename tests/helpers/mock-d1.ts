import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement } from "../../src/store/d1.js";

// PRAGMAs workerd allows. Anything else fails with the same SQLITE_AUTH error the real
// binding raises, so a migration written against PRAGMA user_version cannot pass here.
// Source: developers.cloudflare.com/d1/sql-api/sql-statements
const allowedPragmas = new Set([
  "table_list", "table_info", "table_xinfo", "index_list", "index_info", "index_xinfo",
  "quick_check", "foreign_key_check", "foreign_key_list", "case_sensitive_like",
  "ignore_check_constraints", "legacy_alter_table", "recursive_triggers",
  "reverse_unordered_selects", "foreign_keys", "defer_foreign_keys", "optimize",
]);
const pragmaName = /^\s*PRAGMA\s+([a-zA-Z_]+)/i;

/**
 * A D1 database backed by node:sqlite, faithful to the parts of the real binding this
 * project uses: positional bind(), all/first/run/raw, batch() as one atomic unit, and
 * exec() that splits on newlines and rejects PRAGMAs D1 does not allow.
 */
export function createMockD1(db: DatabaseSync): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let bound: SQLInputValue[] = [];
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values.map(value => (value === undefined ? null : value) as SQLInputValue);
          return statement;
        },
        async all<T>() {
          const stmt = db.prepare(query);
          const results = (bound.length > 0 ? stmt.all(...bound) : stmt.all()) as T[];
          return { success: true, results };
        },
        async first<T>(colName?: string) {
          const stmt = db.prepare(query);
          const row = (bound.length > 0 ? stmt.get(...bound) : stmt.get()) as Record<string, unknown> | undefined;
          if (!row) return null;
          if (colName) return (row[colName] as T) ?? null;
          return row as T;
        },
        async run<T>() {
          const stmt = db.prepare(query);
          if (bound.length > 0) stmt.run(...bound);
          else stmt.run();
          return { success: true };
        },
        async raw<T>() {
          const stmt = db.prepare(query);
          const results = (bound.length > 0 ? stmt.all(...bound) : stmt.all()) as Record<string, unknown>[];
          return results.map(row => Object.values(row)) as T[];
        },
      };
      return statement;
    },
    async dump() { return new ArrayBuffer(0); },
    async batch<T>(statements: D1PreparedStatement[]) {
      db.exec("BEGIN");
      try {
        const results: { success: boolean; results?: T[] }[] = [];
        for (const statement of statements) {
          const res = await statement.all<T>();
          results.push({ success: true, results: res.results });
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    // D1 executes "one or multiple queries separated by \n" and stops at the first error,
    // so a later statement never runs after an earlier one fails.
    async exec(query: string) {
      let count = 0;
      for (const line of query.split("\n")) {
        const sql = line.trim();
        if (!sql) continue;
        const pragma = pragmaName.exec(sql);
        if (pragma && !allowedPragmas.has(pragma[1]?.toLowerCase() ?? "")) throw new Error("not authorized: SQLITE_AUTH");
        db.exec(sql);
        count += 1;
      }
      return { count, duration: 0 };
    },
  };
}
