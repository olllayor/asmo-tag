import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// src/main.ts runs main() on import, so it cannot be imported to reach d1ExecuteFlags.
// Read the source and evaluate just the helper, which keeps the regression covered without
// restructuring the CLI entry point to be importable.
function d1ExecuteFlags(rest: string[]): string[] {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const match = /export function d1ExecuteFlags\(rest: string\[\]\): string\[\] \{\s*return (.*?);\s*\}/.exec(source);
  if (!match) throw new Error("d1ExecuteFlags not found in src/main.ts");
  return new Function("rest", `return ${match[1]}`)(rest) as string[];
}

describe("d1 execute flags", () => {
  it("defaults to remote so a bare database name cannot migrate local D1", () => {
    expect(d1ExecuteFlags([])).toEqual(["--remote"]);
  });

  it("keeps explicit flags so --local stays usable as an opt-out", () => {
    expect(d1ExecuteFlags(["--local"])).toEqual(["--local"]);
    expect(d1ExecuteFlags(["--remote", "--json"])).toEqual(["--remote", "--json"]);
  });
});
