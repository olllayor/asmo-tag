export type Row = Record<string, unknown>;
export interface Db {
  readonly workspaceId: string;
  query<T extends Row = Row>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
}

const jsonColumns = new Set(["data", "receipt", "sources", "memories"]);
const booleanColumns = new Set(["deleted", "redacted", "settled", "expired"]);

// Narrow enough for node:sqlite (SQLInputValue) and Cloudflare D1 alike, so both
// backends share this mapping without importing any Node builtin. This module must
// stay free of node:* imports: the edge worker bundle includes it.
export function binding(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  throw new Error("Unsupported SQLite binding");
}

export function decode(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonColumns.has(key) && typeof value === "string" ? JSON.parse(value) as unknown : booleanColumns.has(key) ? Boolean(value) : value]));
}

const namedParameter = /\$([a-zA-Z0-9_]+)/y;

// D1 binds positionally, so `$workspace` and `$1..$n` are rewritten to `?N`. The scan walks
// the statement and skips string literals, quoted identifiers, and comments, so a `$` that
// belongs to data (a price, a JSON path) is never rewritten. An unknown or out-of-range
// parameter throws instead of binding null into the wrong column.
function endOfQuoted(sql: string, start: number): number {
  const quote = sql[start];
  let cursor = start + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) { cursor += 2; continue; }
      return cursor + 1;
    }
    cursor += 1;
  }
  return sql.length;
}

export function prepareSql(sql: string, parameters: unknown[] = [], workspaceId?: string): { sql: string; bindings: unknown[] } {
  const paramMap = new Map<string, number>();
  const bindings: unknown[] = [];
  const index = (name: string, value: unknown): string => {
    const existing = paramMap.get(name);
    if (existing !== undefined) return `?${existing}`;
    bindings.push(value);
    paramMap.set(name, bindings.length);
    return `?${bindings.length}`;
  };
  let translated = "";
  let cursor = 0;
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char === "'" || char === '"' || char === "`") {
      const end = endOfQuoted(sql, cursor);
      translated += sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (char === "-" && sql[cursor + 1] === "-") {
      const end = sql.indexOf("\n", cursor);
      const stop = end === -1 ? sql.length : end + 1;
      translated += sql.slice(cursor, stop);
      cursor = stop;
      continue;
    }
    if (char === "/" && sql[cursor + 1] === "*") {
      const end = sql.indexOf("*/", cursor + 2);
      const stop = end === -1 ? sql.length : end + 2;
      translated += sql.slice(cursor, stop);
      cursor = stop;
      continue;
    }
    namedParameter.lastIndex = cursor;
    const match = namedParameter.exec(sql);
    if (!match) {
      translated += char;
      cursor += 1;
      continue;
    }
    const [token, name = ""] = match;
    if (name === "workspace") translated += index(name, workspaceId ?? null);
    else if (!/^\d+$/.test(name)) throw new Error(`Unknown SQL parameter $${name}`);
    else if (Number(name) < 1 || Number(name) > parameters.length) throw new Error(`SQL parameter $${name} is out of range; ${parameters.length} parameter(s) supplied`);
    else translated += index(name, parameters[Number(name) - 1] ?? null);
    cursor += token.length;
  }
  return { sql: translated, bindings };
}
