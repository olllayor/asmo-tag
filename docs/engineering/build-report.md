# Asmo Tag local build report

## Wave 1 source baseline, October 9, 2026

The current pilot source baseline is commit `efee1e1dbd10e47dc5c47ac54668a690d884459d`. It includes the existing SQLite, connector, conversation, scheduler, and outgoing Telegram Rich Message work. Documentation and local survey artifacts outside that source commit are not runtime evidence.

The baseline passed 147 tests across nine files, backend and web TypeScript checks, and isolated backend and web builds. Commands used `npm exec --yes --package=pnpm@12.9.1 -- pnpm` because the global launcher is broken. Build outputs went to `work/wave1/backend-build` and `work/wave1/web-build`, preserving the existing live `dist` and web preview outputs.

Read-only review found a delivery-order race beyond the baseline suite. Both serve workers could claim delivery jobs. A slow progress send could arrive after the answer. The isolated reproduction is `work/wave1/baseline-delivery-race.repro.ts`, run with `vitest run --config work/wave1/repro.config.ts`. Its broad-worker case failed and its dedicated-execution case passed. The intentional failure is excluded from the default suite by its `.repro.ts` filename. This finding does not establish a GitHub write failure. Follow-up changes and write gate evidence are recorded in [the Wave 1 report](wave1-write-proof.md).

The local-time routine unit at source commit `061184cf556b8bcc4816f1206c7bd9c6ebb66c74` passed 171 tests across 12 files, both TypeScript checks, and isolated backend/web builds. The [routine contract](local-routine-schedules.md) defines DST, backlog, and durable calendar-date rules. Live write, live scheduling, and named-issue watch gates remain unrun.

The primary checkout's existing `dist` was not rebuilt. Read-only inspection found that its provider barrel still exports the removed Anthropic adapter. That cached artifact needs a fresh build before reuse after dependency cleanup. No existing service was restarted or deployed.

## Historical PostgreSQL milestone

This report records the historical PostgreSQL milestone. On October 6, 2026, the user selected SQLite for the current build. See [the current architecture](architecture.md) and [the SQLite migration report](sqlite-migration-report.md) for its separate verification. The 73-test result below is the pre-migration baseline, not proof of SQLite behavior.

Asmo Tag now runs a shared discussion-to-issue workflow through a real PostgreSQL database and a working React Mini App. A member starts scoped work, teammates steer it, and a manager approves the saved exact issue before creation. The local model and issue provider are explicitly simulated. Real Telegram, Anthropic Messages, and GitHub adapters exist, but their connected acceptance gates remain unrun.

This report records the October 6, 2026 local milestone. It does not declare complete Claude Tag parity or production readiness. The full target and remaining gates are in [the acceptance plan](../product/acceptance-plan.md).

## Observed checks

The final integrated suite passed all 73 tests across five files. It ran against the disposable PostgreSQL 17 database on loopback port 55473 using a non-owner, non-superuser, non-bypass runtime role. Each database scenario used generated workspace identities. No live provider ran.

| Check | Result | Saved evidence |
| --- | --- | --- |
| PostgreSQL state, policy, races, and recovery | 36 tests passed in the integrated suite. | `tests/store.test.ts`, `work/backend/report.md` |
| Provider and connector boundaries | 20 tests passed in the integrated suite. | `tests/providers.test.ts` |
| Telegram identity, normalization, and files | 10 tests passed in the integrated suite. | `tests/telegram.test.ts` |
| Actual HTTP and launch navigation | 6 tests passed in the integrated suite. | `tests/http.test.ts` |
| Real process-death recovery | 1 test passed in the integrated suite. | `tests/recovery.test.ts`, `scripts/crash-worker.ts` |
| Combined suite | 73 passed, five files passed, exit 0. | `work/evidence/full-tests.txt` |
| Backend strict TypeScript | Exit 0. | `work/evidence/typecheck.txt` |
| Browser strict TypeScript | Exit 0. | `work/evidence/web-typecheck.txt` |
| Backend production build | Exit 0. | `work/evidence/build.txt` |
| Browser production build | Exit 0. | `work/evidence/web-build.txt` |
| Actual browser workflow | Member start, manager review, completed cited result, saved memory, and authorized Configure navigation observed. | `work/ui/browser-report.md` |

The combined command was `ASMO_TEST_DATABASE_URL=postgresql://asmo_fixture_app@127.0.0.1:55473/asmo_test ./node_modules/.bin/vitest run`. The other checks used `tsc --noEmit`, `tsc -p web/tsconfig.json`, `tsc -p tsconfig.build.json`, and `vite build --config web/vite.config.ts`. The latest compiled `node dist/main.js serve` restarted successfully after these builds.

The crash test forks an owned child process. The child durably applies one synthetic issue and dies by SIGKILL before saving its database receipt. A reopened store finds the original provider identity and continues without another issue. One ledger issue remains. This proves the tested fixture recovery path across process death. It does not prove GitHub's behavior under every network failure.

## Implemented behavior

| Area | Local behavior | Material limit |
| --- | --- | --- |
| Intake and identity | Deduplicated updates and commands, UTF-16 mention handling, explicit progress-message routing, group/topic/DM scopes, signed Mini App identity, and authenticated navigation. | Standard bots cannot retrieve arbitrary old group history. Telegram's general message deletion events are unavailable. |
| Tasks | Durable states, ordered teammate instructions, Stop, Cancel, Resume, saved event order, complete model history, stale-turn fencing, and incomplete-output barriers. | Stop cannot undo a request already dispatched. Conflicting teammate intent still needs explicit human resolution. |
| Context and memory | Scoped evidence, citations, curated notes, inspection, revision-based correction, rejection, invalidation, and cross-group sharing of active curated facts only. | Automatic memory extraction is not enabled. Exact internal recovery payloads and external copies can remain after invalidation. |
| Tool work | Allowlisted issue reads and exact issue creation, saved action hashes, current-role review, expiry, grant checks, durable receipts, and unknown-outcome holds. | Live installation-token minting and refresh are not implemented. Bounded no-match searches do not prove absence. |
| Budgets | Atomic reservations, configured token prices, reported or conservative estimated usage, turn limits, and task/group/workspace allowances. | Synthetic usage is labeled simulated. Real billing reconciliation remains untested. |
| Routines | Manager-controlled daily fixed UTC occurrences, replay prevention, pause, restart, and shared ownership after creator departure. | General intervals and full-target member controls remain planned. Fixed UTC schedules shift local wall time across DST. |
| Mini App | Findings, sources, effects, exact approvals, event order, contextual Configure, General, Tools and access, Memory, Routines, and separate role-controlled administration. | Ordinary browser checks do not pass live Telegram-client compatibility or signed launch gates. |
| Files | Bounded UTF-8 text ingestion for `.txt`, `.md`, `.csv`, `.log`, and `.json`, with explicit unsupported-file outcomes. | Maximum 32 KiB. No PDF, image, audio, or archive parsing. |
| Capacity | 20 active tasks per scope, 100 pending tasks per workspace, 500 ready or leased jobs per workspace, and two current model leases per scope. | Passive storage and held-notice retention remain unbounded. Lease counts do not bound physical calls that were already dispatched before steering. |

The Claude Tag walkthrough places Configure under replies and shows channel settings. Asmo uses the same conversation-first method through Telegram task links and contextual configuration. The UI follows the user's black/white and dense-layout constraints. The evidence is the public [Claude Tag course](https://academy.claude.com/courses/introduction-to-claude-tag/expand-what-claude-owns) and [admin guide](https://academy.claude.com/tutorials/claude-tag-admin-guide). No private Anthropic prompt or internal architecture was available.

## Independent review and corrections

The final reviewer read application source, browser source, tests, contracts, and the decision trail. Its actual-store reproductions found a stale shared-memory fact in another group's continuation history. The fix records consumed memory revisions and invalidates dependent transcripts, results, sources, pending output, and approvals. The repeated reproduction no longer retrieves the removed fact.

Cleanup previously required an inactive scope to resume collection. Authorized cleanup now works while collection remains inactive. A fixture issue result could hide its receipt by re-entering read preparation. Completed writes now take the receipt path. A broad Telegram reply condition interrupted a running model on `/status`. The HTTP regression now keeps both ordinary and whitespace-padded status replies read-only.

A late positive receipt could automatically resume a blocked task after its admission slot had filled. Recovery now rechecks scope and workspace limits and preserves the receipt while blocked. An authorized Resume proceeds after capacity returns without another write. Tool preparation at a saturated queue now stores matching error results and leaves a resumable task with no prepared effects.

Late review also reproduced source starvation. After 301 captured messages, the model received the oldest 300 and missed the newest fact. The current scope's raw context window now prioritizes the original task prompt, linked task messages and files, and task-owned tool records. It fills remaining slots with recent sources and presents those selected raw records chronologically. The window stays at 300. Active memory outside that window receives content-free supporting references so its citations remain valid. Shared-memory evidence remains content-free across groups. Provider input and result limitations disclose that omitted sources do not prove absence.

The final context review then found that one memory correction cleared unrelated completed tasks in the same group. Invalidation now starts from recorded source/memory consumers, changed task-owned tool records, and linked raw inputs. It follows derived-source and memory dependencies from those tasks. Source forgetting also conservatively redacts already dispatched or unknown effects in the source group because an opaque late receipt can return the removed content. It no longer clears every completed task in that group. Changed tool ownership is read separately from active sources, so a receipt forgotten before another model reservation still invalidates its owning task.

Seven new database cases cover recent context and attachments, resumed older task records, memory citation references, raw-input preservation during memory correction, unrelated-result preservation, pre-dispatch input scrubbing, and tool-receipt deletion before another reservation. The separate gpt-6-luna reviewer ran four context cases and actual-store invalidation reproductions. The root ran the full 73-test suite after these corrections. The current context artifacts are under `work/context-review/`. The reviewer reconstructed its pre-patch JSON from captured tool output after an accidental overwrite. That file is explicitly labeled reconstructed; the after JSON is actual saved run output.

The independent artifacts are `work/review/final-review.md`, `trail-audit.md`, and their before/after JSON reproductions. Finite checks reduce risk. They do not establish that every permission or concurrency defect is absent.

## Team and selected architecture

The lead coordinated PM, two architecture candidates, a judge, backend, AI/connectors, Telegram integration, UI, QA, and local operations responsibilities. Three worker slots rotated across stages. Exclusive module ownership kept shared contract changes with the lead.

The judge preferred PostgreSQL over Convex, 26/30 against 21/30. The lead scored them 28/30 and 24/30. These scores compare proposals, not measured runtime quality. PostgreSQL made transactional policy, dispatch fences, saved receipts, and local crash tests explicit. A single TypeScript worker owns bounded Messages API turns. The AI candidate contributed complete provider-message preservation, separate provider retention review, and the planned private personal-connector branch.

The early Luna review provided independent findings. Its first final run hit model capacity. The replacement whole-application reviewer was a separate gpt-6.1-sol agent, the same model family as the builders. That reviewer later hit a usage limit before the late context corrections completed. After the reset, a fresh gpt-6-luna reviewer checked the context and invalidation changes independently. Whole-application review and the earlier decision audit have reduced model diversity. The final focused review uses a different model.

## Principles that changed choices

These poteto-mode leaf principles were read during this session. Each changed a concrete decision.

| Principle | Specific choice |
| --- | --- |
| Foundational Thinking | Defined source, task, approval, effect, usage, and lease data before assigning implementation modules. |
| Model the Domain | Kept task state and external-effect state separate. A canceled task can still retain a late successful write receipt. |
| Separate Before Serializing Shared State | Assigned separate owned modules and per-task transcripts before adding transactional locks for shared workspace limits. |
| Make Operations Idempotent | Gave updates, commands, scheduled occurrences, and effects stable identities. Recovery requires a positive receipt or authoritative absence before another write. |
| Sequence Work into Verifiable Units | Built intake and scope rules before the tool loop, then approvals, crash recovery, memory, routines, and authenticated UI. |
| Prove It Works | Ran the actual database, HTTP server, browser, and SIGKILL child instead of relying on compilation and fixture exceptions alone. |
| Test Behavior, Not Implementation | Asserted visible role decisions, provider dispatch counts, resumed model input, and one external effect after process death. |
| Boundary Discipline | Parsed Telegram authentication, files, provider messages, and GitHub responses at their boundaries. Application policy owns permission decisions. |
| Type System Discipline | Used strict TypeScript and Zod contracts for commands, saved JSON, and external input. No permissive `any` boundary was added. |
| Redesign From First Principles | Put full provider messages and source/memory dependencies in the core contracts. Kept private-connector separation explicit in the expanded product contract. |

## Unpassed gates and next implementation order

The entire L01-L20 acceptance gate is not passed. The final tests cover meaningful parts of the local scenarios, but a scenario-by-scenario proof ledger is still required. L20 is explicitly partial. All connected P gates, expanded B gates, and release gates remain unrun.

Text files currently associate with their parent through message ID and capture time within the same scope. These fields are not a stable parent key across every migration collision. The focused reviewer identified this residual same-scope association risk. Live migration checks and a stable file-parent identity remain necessary before release.

1. Complete passive-ingestion limits, retention expiry, held-notice draining, and an explicit physical-call concurrency contract. Add evidence to L20 rather than inferring it from task admission tests.
2. Configure an authorized private Telegram test bot, test groups/DMs, a model and spending allowance, and an approved GitHub test repository. Real mode already fails clearly when configuration is absent.
3. Prove current membership at worker dispatch and delivery, real permission-revocation races, webhook retries, supported Telegram clients, Stop during live calls, provider usage, and token refresh. API/webhook actor refresh alone does not prove these dispatch gates.
4. Implement and drill backup restore, deletion reapplication, provider-retention disclosure, operator audit export, and unknown-write reconciliation. Retained exact recovery records need a documented retention policy.
5. Run assessed task outcomes and citations against the pilot rubric. Test infrastructure correctness and model usefulness separately.
6. Add actual isolated repository execution and draft PRs. Prove process isolation, egress restrictions, resource limits, and real checks before reporting code work as supported.
7. Add automatic curated memory, privately reviewed personal connectors, richer schedules and member controls, individual PR watches, and authorized hosted artifacts.
8. Keep ambient replies off until shadow evaluation passes the privacy and usefulness gates. Add commercial administration and the chosen Telegram payment path after measured pilot usage.

The full roadmap preserves broad Claude Tag ambitions. It orders work by prerequisites instead of simulating unavailable features. Credentials, approved external resources, retention policy, and release authorization cannot be obtained by researching another team's product.

## Handoff

The working name is Asmo Tag under Asmo AI. Asmo Djinn remains the playful alternative. Public research found no obvious exact-name AI competitor, but no domain, trademark, or Telegram username has been cleared or reserved.

The local compiled server runs at `http://127.0.0.1:8787/?fixture=1`. The database belongs to this project's `work/` directory. Stop the server before `pnpm db:stop`. No production system, paid model, live Telegram message, live GitHub issue, remote repository, or production deployment was touched. Static A/B/C design mocks were published earlier for review.
