# asmo-tag Effect v4 Porting Contract (PORTING.md)

## 1. Architectural Scope & Target
- **Target**: `effect@4.0.5`
- **TypeScript**: `7.0.2` with `"strict": true`
- **Objective**: Introduce Effect v4 primitives to elevate type safety, runtime performance, and clean functional error handling across `asmo-tag` without breaking any of the existing tests.

## 2. Inviolable Constraints & Invariants
1. **Zero Test Regressions**: All tests across test suites must remain 100% green. Zero tests skipped, disabled, or weakened.
2. **Coding Preferences (AGENTS.md)**:
   - "Channel 'yagni' energy" — keep it simple, avoid unnecessary abstraction layers.
   - "any is the enemy. Inferred types are our friend."
   - "Avoid one-line functions that are just casting wrappers."
   - Write TypeScript that Matt Pocock and Theo would be proud of.
3. **No Stubbing or Hack Comments**:
   - Disallow `@ts-ignore`, `as any`, or `todo!()` workarounds.
   - Disallow multi-line excuse comments justifying hacks.

## 3. Primitives & Mapping

| Capability | Legacy / Zod / Ad-hoc | Effect v4 Standard |
| :--- | :--- | :--- |
| **Schema Definition** | `z.object({...})` / `z.infer` | `Schema.Struct({...})` & `Schema.Type<typeof S>` |
| **Parsing / Decoding** | `schema.parse(data)` / `safeParse` | `Schema.decodeUnknownSync(S)` / `Schema.decodeUnknownResult(S)` yielding `Result` |
| **Error Handling** | Thrown exceptions or null returns | `Result<A, E>` (`Result.succeed`, `Result.fail`) |
| **Service Injections** | Ad-hoc class instances | `Context.Service<T, Shape>()("ID")` |

## 4. Phase Plan
- **Phase 1 Pilot**: Core domain models and schema definitions (`src/core-effect.ts`).
- **Phase 2 Pilot**: Bounded text buffer operations & functional conversation answering.
- **Phase 3 Verification**: Run `scripts/verify-guardrails.sh`, `pnpm run check`, and `pnpm test`.
