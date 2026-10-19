# Ported subsystems review

Reviewed 2026-10-20 against `main` at `0e86f18`, with the prompt cache work from #10 on a separate branch. Three modules were built in parallel: a file memory engine, a compaction manager, and a tool search engine.

## Status

None of the three is wired into the application. Every import of `src/memory`, `src/context`, and `src/tools` comes from that module's own test file:

```
$ grep -rln "memory/file-memory\|context/compaction\|tools/tool-search" src/ tests/
tests/memory/file-memory.test.ts
tests/context/compaction.test.ts
tests/tools/tool-search.test.ts
```

The request path still builds tools from `src/providers/responses.ts` and `src/store/index.ts`. Their 102 tests pass, and they prove the modules in isolation, not the runtime.

## Fixed in this pass

**Compaction split a tool call from its result.** `groupMessagesIntoTurns` started a new turn on every user message, and this app stores tool output inside a user entry. With `preserveRecentTurns: 2` the kept window began with a `tool_result` whose `tool_use` had been summarized away. `historyItems` rejects that shape, so wiring the module as it stood would have thrown at request time. A message that carries tool results now continues the turn of the call it answers, and a test covers the three preservation counts.

**Two barrels were reported but absent.** `src/memory/index.ts` and `src/tools/index.ts` did not exist. Added, and both compile clean.

**`Message.content` was `string | any`.** That is `any`, so every read of a message body was unchecked. It is now `string | readonly unknown[]`, which still typechecks all 21 existing compaction tests.

## Verdicts

| Module | Verdict | Reason |
| --- | --- | --- |
| File memory | Park | The sandbox is sound, but wiring it needs a new tool execution path and a filesystem dependency. |
| Compaction | Park, fix first | The pairing bug is fixed, but a stateless compaction would change the prompt prefix every turn. |
| Tool search | Do not wire | Changing the tool array mid-session invalidates the prompt prefix, which is the problem #10 exists to fix. |

### File memory

The containment surface held against my own attempts, not just its suite: 16 escape attempts (dot segments, encoded traversal, backslash traversal, null bytes, a planted symlink, and root deletion) all raised `MemorySecurityError`, and `view` through a symlink did not read the file outside the root.

What blocks wiring:

- It needs one engine per scope, rooted at a scope directory. A single root would let one group read another's notes, which contradicts the scope isolation the store enforces everywhere else.
- Tool calls become effects and go through approval. A memory write is internal, so it needs a second execution path in `finishModel`, next to the effect queue. That is the security-critical part of the store.
- It imports `node:fs` and `node:path`, so it cannot enter the edge bundle.
- The curated memory table already stores reviewed facts with evidence and revisions. A scratchpad is a different product surface, and it needs a retention and deletion story of its own.

### Compaction

Usable as a library once the pairing bug is fixed. It cannot be dropped into the provider as it stands.

The provider is stateless per turn. It recomputes the window from the stored transcript. A summary derived from the dropped entries would therefore be recomputed on every turn, and it would appear on turns that drop and vanish on turns that do not. Either case changes the prefix and defeats the cache. Making compaction solid needs the boundary persisted, which means a task field or a summary transcript entry plus a transcript flag, and a decision about who pays for the summarizer call.

### Tool search

This one conflicts with the work that just landed. The cache is a byte prefix match, and the tool array sits in front of the messages. `ToolSessionManager` activates discovered tools into the schema for later turns, so each discovery rewrites the prefix and re-bills the whole conversation. The engine is built for a harness with dozens of tools. This app has four, about 1,666 bytes of schema, and the article's own rule is not to change the tool set mid-session.

Parking it is the honest call. If it is ever needed, the cache-safe shape is a fixed tool inventory plus a tool that answers discovery questions in its result, never a changing schema.

## If this gets wired

In order of value to cost:

1. Persist a compaction boundary on the task, then let the store run a summarizer call on the parent prefix and store the result as a transcript entry. That closes the long-task cache reset measured in #11 and gives the compaction module a real consumer.
2. Give the memory engine a scope root and an internal tool path, behind a scope flag. It is a scratchpad, not the curated memory table.
3. Leave tool search out unless the tool inventory grows past what fits in the prefix.

## Verification

- `npx vitest run tests/memory tests/context tests/tools`: 103 tests pass after the fixes.
- `pnpm check` is clean.
- The compaction test was checked against the defect it names: removing the tool-result guard makes it report `expected [ 'call-1' ] to deeply equal []`.
- The sandbox probe is in the PR description, not the repo, because it plants symlinks outside the tree.
