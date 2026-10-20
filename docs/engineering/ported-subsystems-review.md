# Ported subsystems review

Reviewed 2026-10-20 against the prompt cache work in #10. Three modules were built in parallel: a file memory engine, a compaction manager, and a tool search engine.

## Status

Compaction is wired into the request path. Memory and tool search are parked, and nothing imports them outside their own tests. The reasoning for each is below.

```
$ grep -rln "memory/file-memory\|tools/tool-search" src/ tests/
tests/memory/file-memory.test.ts
tests/tools/tool-search.test.ts
```

## Fixed in this pass

**Compaction split a tool call from its result.** `groupMessagesIntoTurns` started a new turn on every user message, and this app stores tool output inside a user entry. With `preserveRecentTurns: 2` the kept window began with a `tool_result` whose `tool_use` had been summarized away. `historyItems` rejects that shape, so wiring the module as it stood would have thrown at request time. A message that carries tool results now continues the turn of the call it answers, and a test covers the three preservation counts.

**Two barrels were reported but absent.** `src/memory/index.ts` and `src/tools/index.ts` did not exist. Added, and both compile clean.

**`Message.content` was `string | any`.** That is `any`, so every read of a message body was unchecked. It is now `string | readonly unknown[]`, which still typechecks all 21 existing compaction tests.

## Verdicts

| Module | Verdict | Reason |
| --- | --- | --- |
| File memory | Park | The sandbox is sound, but wiring it needs a new tool execution path and a filesystem dependency. |
| Compaction | Wired | The boundary is persisted on the task, so the summary is sent once and reused instead of recomputed. |
| Tool search | Do not wire | Changing the tool array mid-session invalidates the prompt prefix, which is the problem #10 exists to fix. |

### File memory

The containment surface held against my own attempts, not just its suite: 16 escape attempts (dot segments, encoded traversal, backslash traversal, null bytes, a planted symlink, and root deletion) all raised `MemorySecurityError`, and `view` through a symlink did not read the file outside the root.

What blocks wiring:

- It needs one engine per scope, rooted at a scope directory. A single root would let one group read another's notes, which contradicts the scope isolation the store enforces everywhere else.
- Tool calls become effects and go through approval. A memory write is internal, so it needs a second execution path in `finishModel`, next to the effect queue. That is the security-critical part of the store.
- It imports `node:fs` and `node:path`, so it cannot enter the edge bundle.
- The curated memory table already stores reviewed facts with evidence and revisions. A scratchpad is a different product surface, and it needs a retention and deletion story of its own.

### Compaction

Wired in `src/providers/responses.ts` and persisted by `finishModel`. When the history ladder drops entries, the provider summarizes the dropped span with `defaultStructuredSummarizer`, prepends the summary to the request, and returns it on the turn. The store writes it to `task.compaction` as `{ entries, summary }`. Later turns slice the transcript at `entries` and send the stored summary, so the prefix is stable instead of re-dropping a different window each turn.

The summary comes from the module's deterministic summarizer, so there is no extra model call and no change to the budget path. It is bounded to 4 KB.

Measured with a probe over eight turns and 28 KB tool results, which is the case that used to reset the prefix on every turn: the prefix now resets only on the turns where a new compaction happens, and is reused in between. With 2 KB tool results nothing compacts and the prefix grows every turn as before.

### Tool search

This one conflicts with the work that just landed. The cache is a byte prefix match, and the tool array sits in front of the messages. `ToolSessionManager` activates discovered tools into the schema for later turns, so each discovery rewrites the prefix and re-bills the whole conversation. The engine is built for a harness with dozens of tools. This app has four, about 1,666 bytes of schema, and the article's own rule is not to change the tool set mid-session.

Parking it is the honest call. If it is ever needed, the cache-safe shape is a fixed tool inventory plus a tool that answers discovery questions in its result, never a changing schema.

## Remaining

1. Give the memory engine a scope root and an internal tool path, behind a scope flag. It is a scratchpad, not the curated memory table.
2. Leave tool search out unless the tool inventory grows past what fits in the prefix.
3. Raise the compaction threshold only if the measured reset rate matters. Two turns of 28 KB results fill 75 percent of the cap, so compaction can only happen that often.

## Verification

- `pnpm test`: 387 tests pass across 23 files.
- `pnpm check` is clean.
- The compaction test was checked against the defect it names: removing the tool-result guard makes it report `expected [ 'call-1' ] to deeply equal []`.
- The sandbox probe is in the PR description, not the repo, because it plants symlinks outside the tree.
