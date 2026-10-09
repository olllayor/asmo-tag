# Wave 1 write proof

## Scope and gates

Wave 1 first verifies the existing exact-reviewed GitHub issue path. Keep Notion reads, progress controls, provider continuation state, admission limits, queue leases, and the durable outbox. Do not add a new write connector or broaden GitHub permissions before the existing write gate passes.

The source baseline is `efee1e1dbd10e47dc5c47ac54668a690d884459d`. The baseline suite passed 147 tests. Later evidence must name the source commit it verifies. [The build report](build-report.md) separates this baseline from historical PostgreSQL evidence.

The execution order is:

1. Pin and review the current source baseline.
2. Fix the verified delivery-order failure.
3. Add a rerunnable isolated GitHub write and lost-receipt recovery proof.
4. Prepare exact live test actions for a disposable repository and Telegram chat.
5. Run P03 and P05 using approved resources and actions.
6. Implement a watch on one named issue only after the write proof passes.
7. Verify timezone scheduling as a separate feature with explicit DST and downtime rules.

Unreachable adapter removal and a Notion/Trello options study are independent units. Both are complete. The command-handler map and admission-limit collapse are deferred because neither is required to prove the write. The active Telegram `abort-controller` dependency remains because its messenger uses it.

## Delivery ordering

Review reproduced two consumers racing for delivery jobs. The serve execution worker now requests effect jobs first and model jobs second. The delivery worker is the sole serve consumer of delivery jobs. The scheduler remains independent. `tests/worker.test.ts` holds a progress send open while the model completes, then checks that progress and its settled state precede the final answer.

## Live readiness

Configuration presence validation passed for Telegram, the model, GitHub, Notion, and the connector vault. This validates configuration only. It does not prove provider authorization or a live tool call. No live database was opened, provider token refreshed, group message sent, issue created, connection revoked, service restarted, or deployment performed in this run.

Existing pilot documents name the daily-driver `Asmo Tag Dev` group and `olllayor/asmo-tag`. They are not assumed to be disposable destinations. The live gate needs a selected test repository and chat, an exact reviewed title/body/labels, and a model-spend bound. Revocation and process-death tests must use an isolated application database and connection.

The [prepared live procedure](wave1-live-check.md) supplies exact synthetic messages, issue payloads, expected callback decisions, and isolated revocation/restart checks. Resource selection and spend remain pending. It does not claim that a normal restart proves live lost-receipt recovery.

## Local recovery proof

Source commit `ea02a5d40918e295b1a1aa7833e230d901bb61d2` passed 143 tests across 11 files, `pnpm check`, and an isolated backend compile. The baseline also passed `pnpm web:check` and an isolated web build. Build output went under `work/wave1`, outside the daily-driver build paths.

Run `pnpm exec vitest run tests/github-recovery.test.ts` to repeat the six GitHub cases. The proof uses the production Store, Worker, IntegrationService, and issue connector with synthetic credentials, temporary SQLite, and an ephemeral loopback HTTP server. Its transport rejects unlisted routes and redirects. Every POST creates a fresh issue in the test provider, so provider deduplication cannot hide a repeated write.

The crash case records the issue in the parent process before responding. The parent observes `dispatching` with no receipt, kills the child with `SIGKILL`, reopens Store and IntegrationService, expires the lease, and recovers with one authenticated GET. Assertions require the exact reviewed body and marker, preserved provider ID and URL, one success event, one tool source, and exactly one POST after repeated approval callbacks and recovery.

The other cases cover denial, repeated and opposite callbacks, revoked repository access before dispatch, credential disconnect before dispatch and after a lost receipt, and repeated recovery with a missing marker. Missing evidence stays `unknown`; it does not authorize a fresh POST. Disconnect calls the integration service directly to isolate its credential fence. These tests do not cover the public disconnect route, live Telegram role refresh, real model output, or real provider behavior.

The unreachable Anthropic adapter, its dependency, its obsolete tests, and unused `fixtureKey` were removed in a separate commit. The [Wave 2 study](wave2-task-connectors.md) records Notion and Trello options. Notion's documented saved-write 503 response does not by itself require a shared `partial_confirmed` state.

## Evidence status

| Gate | Status | Evidence |
| --- | --- | --- |
| M0 source snapshot | Verified | Source commit above and isolated baseline checks |
| Slow delivery ordering | Verified locally | `tests/worker.test.ts` and failing pre-fix scratch reproduction |
| GitHub lost-receipt recovery | Verified locally | Six cases at the source commit above; one real socket/SIGKILL case |
| P03 real approved issue | Not run | Test destinations not selected |
| P05 live revocation | Not run | Requires isolated connection and exact action |
| Named-issue watch | Deferred | Requires P03/P05 evidence |
| Wall-clock/DST scheduling | Verified locally | [Explicit local schedule contract](local-routine-schedules.md); legacy UTC and Mini App behavior remain fixed UTC |

The local decision trail is `work/wave1/decisions.tsv`. Local process and transport proofs do not pass the live Telegram, model, and GitHub gates.
