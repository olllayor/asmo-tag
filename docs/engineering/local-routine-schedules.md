# Daily local routine schedules

The backend supports an explicit daily local time in a named IANA timezone. Existing routines and commands without `schedule` retain their fixed UTC behavior. The current Mini App still creates fixed UTC routines. Configure local schedules through the existing authenticated command API or the Store API.

## Create a local schedule

Add `schedule: { kind: "daily_local", time: "09:00" }` to `create_routine`. Time uses 24-hour `HH:mm`. `timezone` remains the only timezone setting. Numeric offset zones are not accepted for local schedules. `UTC` and named IANA aliases are accepted.

For a local schedule, input `nextAt` is the earliest allowed UTC instant. The backend resolves the first intended local occurrence at or after it and saves that occurrence in `nextAt`. The stored schedule also carries `nextDate`, its intended calendar date. Clients do not supply that field. `intervalMs` remains `86400000` for compatibility; local scheduling does not advance by adding that interval to UTC.

```ts
await store.command({
  scopeId,
  userId: managerId,
  key: "daily-local-digest-v1",
  command: {
    kind: "create_routine",
    instruction: "Summarize captured release risks with source citations.",
    timezone: "America/New_York",
    schedule: { kind: "daily_local", time: "09:00" },
    nextAt: Date.parse("2026-03-07T00:00:00Z"),
    intervalMs: 86400000,
    budgetMicros: 500000,
  },
});
```

This example stores March 7 at `14:00Z`. Its March 8 occurrence is `13:00Z`, still 09:00 in New York. It is an API example, not a live activation or an approved spending allowance. The existing HTTP endpoint is `POST /api/command`; it derives the actor from authentication rather than accepting `userId` from the request body. Routine changes still require a manager or owner.

## DST and recovery policy

Use Temporal's explicit `compatible` policy. A nonexistent local time moves forward by the gap. A repeated local time selects its earlier instant and runs once. Each day's conversion starts from the saved intended time. A shifted gap occurrence does not shift the following day's routine. These rules follow [Temporal's disambiguation definition](https://tc39.es/proposal-temporal/docs/zoneddatetime.html#static-methods).

| Intended time and timezone | Resolved occurrence |
| --- | --- |
| New York, 02:30 on March 8, 2026 | 07:30Z, which is 03:30 locally; March 9 returns to 02:30 |
| New York, 01:30 on November 1, 2026 | 05:30Z; the second 01:30 at 06:30Z does not run |
| Lord Howe, 02:15 on October 4, 2026 | 15:45Z on October 3, which is 02:45 locally |
| Apia, 09:00 on the skipped December 30, 2011 | Same UTC instant as December 31 at 09:00; one occurrence |

Active downtime creates at most one task for the latest due occurrence, then advances to a future local occurrence. Older missed occurrences are skipped. Resume skips all due times and preserves an already future cursor. Capacity failure skips the due occurrence, as with fixed UTC routines. Task creation, occurrence identity, and cursor advancement remain in one scope transaction.

The backend uses a fixed neighborhood of local dates, not a loop over missed days. Equal resolved UTC instants share one occurrence. The saved UTC cursor and its intended date remain authoritative even if the host's timezone data changes after creation. After consuming or skipping that date, the backend selects a later calendar date and a future UTC instant. A revised timezone rule cannot schedule the consumed date again. Future conversions use the host's current timezone data. Calculation errors roll back rather than selecting a guessed time.

The pinned backend dependency is `@js-temporal/polyfill@0.5.1`. It does not install a global Temporal object. The conversion module imports it directly. See [the polyfill documentation](https://github.com/js-temporal/temporal-polyfill).

## Verification

Run `pnpm exec vitest run tests/routine-schedule.test.ts tests/store.test.ts` and `pnpm check`. Expected UTC values are literal test expectations. Tests must cover both DST directions, gap recovery on the following day, half-hour and whole-date changes, restart deduplication, distant downtime, pause/resume, and unchanged fixed UTC behavior.

Source commit `061184cf556b8bcc4816f1206c7bd9c6ebb66c74` passed 171 tests across 12 files, backend and web TypeScript checks, and isolated backend and web builds. Independent source review accepted the date/UTC cursor fix. Tests simulate timezone-data changes with saved cursor/date pairs; they do not replace the host timezone database. Local dates use `YYYY-MM-DD`. Creation rejects anchors whose complete calculation window exceeds that date format.

Local scheduling is backend support. The Mini App's schedule controls and interval display still describe fixed UTC schedules. A local-time UI requires the separate mock-and-pick process before implementation. This unit does not prove live scheduled delivery or the complete L17 product gate.
