# Shrink targets (2026-10-01)

Cold start on Workers scales with shipped minified bytes (about 75% of import time is V8 compiling the bundle). Code splitting, lazy `import()`, per-feature named imports and code generation are out of scope. The only lever left is making the shipped code smaller.

## Baseline

The baseline comes from `node benchmarks/probe-shrink.mjs`. The app has two related models with common scalar kinds and uses better-sqlite3. It is bundled minified the way a Worker ships it.

- Bundle: **511.5 KiB**.
- Code that ran, by first phase: load 43.2 KiB, read 85.3 KiB, write 25.3 KiB, other 52.6 KiB. "Other" covers upsert, nested writes, aggregate, groupBy and transactions.
- Code that never ran: **305.1 KiB**.

| Area | Total KiB | Never ran KiB |
|---|---|---|
| query-engine/raptor3/shared | 110.6 | 55.5 |
| query-engine/raptor3/commands | 58.6 | 26.3 |
| drivers (+shared, sqlite3) | 58.6 | 38.2 |
| validation (all) | 100 | 55 |
| schema (all) | 77 | 53 |
| client | 27.6 | 21.5 |
| extensions | 20.9 | 19.7 |
| errors | 22.0 | 14.6 |

Error handling is cross-cutting: classes, throw sites and message text. It amounts to about 72–96 KiB, or 14–19% of the bundle.

Most of the never-run bytes are capabilities this workload does not use. Seven independent reviews found little dead code. The savings come from duplicated runtime mechanisms, per-variant copies, redundant checks, and member names that minification cannot shorten.

Reviewer prototypes and measurement scripts are under the session scratchpad `shrink-agents/`. Unless marked "est.", every number is a measured minified delta, with the cost of the replacement code already subtracted.

## Targets that change no capability, ranked

| # | Target | KiB | Confidence | Effort | Notes |
|---|---|---|---|---|---|
| 1 | **TypeScript `private` → `#private`, repo-wide** | ≈14 (est.); 8.7 measured on 4 engine files | high | M (scripted) | TS private names survive minification; `#x` is mangled. The target is es2022 or later. Only `private` qualifies, not `protected`. |
| 2 | **One runtime class for the 14 scalar builders** | 8.9 | high (bytes) | M | `nullable`/`array`/`default`/`map`/`id`/`unique`/`schema` are copied in every kind. Types stay per kind through `declare` members, which cost 0 B. Side effect: `state.schema` would be kept consistently, which fixes a known inconsistency. |
| 3 | **Driver statement-dispatch collapse** | 2.8 | high | M | Observed/unobserved × serialized branches repeated in `executeTypedStatement`, `_executeRaw`, `executeBatch`, `_executeBatch` and `TransactionBoundDriver`. Also removes an unreachable throw and a duplicate `supportsTransactions` refusal. |
| 4 | **Pinned-session methods off `Driver`, into `src/migrations`** | 2.5 | high | M | Only migrations call them. They ship today because class methods are never tree-shaken. This moves code to its only consumer and is not a user-facing import scheme, but confirm it is acceptable. |
| 5 | **Client transaction lifecycle collapse** | 1.9 | high | M | One outcome-transaction runner, one proxy get-trap and one `transact`. Also removes a duplicate `supportsTransactions` check. |
| 6 | **Keep the `VibORMErrorCode` enum object out of the bundle** | 2.1 | high | S | Its only runtime use is `Object.values(...)` in `isVibORMErrorCode`; a `V\d{4,5}` test replaces it. |
| 7 | **Table-driven provider error mapping** | 1.25 | high | S | 19 copies of `new XError(...)` in `error-mapping.ts`. Message text unchanged. |
| 8 | **Engine guards whose upstream owner is named** | 2.0 | high | S | 10 sites in shared and 10 in commands. Each comment names the check that already holds. |
| 9 | **Small factories and dedups in engine commands** | 2.9 | high | S | Dependency-refusal factory (0.8), relation-body factories (0.6), dead `QueryEngine` surface and `ModelRegistry` (1.0, test-only users), query-inspection snapshot merge (0.4). |
| 10 | **Validation dedups** | 4.0 | high/medium | S | Decimal update-op switches (1.2), six per-scalar operation files (1.0), two binary decoders shared with the engine (1.2–1.4), second array walker and schema factory (0.5). |
| 11 | **`Object.freeze` alias in `query.ts`** | 1.1 | high | S | 92 calls. |
| 12 | **Error machinery small items** | 2.1 | high | S | `verdictFor` switch (0.9), clone constructor read from the prototype (0.75; drops 5 cache/migration error classes from every bundle), one metadata key table (0.46). |
| 13 | **Repeated message text** | ≈1.5 | high | S | Duplicate literals across the bundle total 4 KiB; minifiers never merge strings. Text unchanged. |
| 14 | **Schema small items** | 2.2 | high | S | Native-type constant helpers (1.1), client validator as one function (0.7), dead relation-name registry (0.4). |
| 15 | **Dead code** | ≈1.5 | high | S | Consumable-result mechanism (0.8), `OperationContext.associate` (0.5), client crumbs (0.25). |
| 16 | **Array `$transaction`: one path** | 2.4–4.6 | high | M | Delete the observe-only copies (2.4, low risk), or the whole legacy path (4.6). The full version changes behaviour: an unextended callback driver refuses `$transaction([op, op])` as extended clients already do. It also needs a waiver of `src/client/AGENTS.md`. |

**Total without changing any capability: ≈55 KiB** (about 11% of the bundle). Overlaps are already removed:
- error mapping is counted once;
- the blob decoder is counted once;
- `_nativeType` is shared between targets 1 and 2.

Expected effect is about 0.8 ms of the Node cold proxy, and about 10% of the parse cost on Workers.

Order of work:
- 1 first: mechanical, biggest, and the other targets then measure against it.
- Then 2.
- Then 3–7: driver and error items, about 10 KiB.
- Then the S items, 8–15.
- Last, 16, after an owner decision.

## Owner decisions (measured, not recommended)

| Item | KiB | What would change |
|---|---|---|
| Extension runtime as an install-on-import entry (like `viborm/cache`) | 17–19 | `$extends` users import an entry. The same pattern was accepted once before. |
| Array `$transaction` capability as a whole | 10.6 (6.4 after 16) | |
| Captured series (nested updateMany/deleteMany through junctions or relation-bearing data) | ≈6.5+ | |
| Recursive projections | ≈7.0 | About 2 KiB of that is consistency checks on SQL the engine builds itself. |
| Raw SQL surface | 6.2 | |
| Error trusted-snapshot double storage + clone path | 4.8 | A hardening contract pinned by tests. |
| Geo polygon validity sweep (replace with pairwise checks) | 2.5–3 | Slower on large rings. |
| Long error messages / `repair:` hints / decode reasons | ≈2 + 2.5 + 1.5–2.8 | Public error text changes. |
| `defaultOmit` as its own entry | 3.2 | |
| D1 SQL tokenizer → operation contract + INSERT regex | 2.8 | D1 only. |
| cuid2 (own SHA3) | 2.6 | |
| Native-type runtime admission → `viborm check` only | 2.6 | |
| Interceptor-input deep snapshot → shallow freeze | 2.3 | Loses isolation from hostile input. |
| Raw-parameter prototype fingerprinting | 1.6 | Cross-realm containers and patched prototypes. |
| ValidationError re-snapshot on clone | 1.4 | |
| Provider-code allowlist → pattern | 1.0 | Loosens the redaction policy. |

## Not worth it (measured)

- Merging `Commands.create`/`update`: 38 B.
- Recipe in-place materialization: 242 B, risky.
- Removing extension layers for unextended clients: they already skip them at runtime; the bytes are the capability itself.
- Dependency analysis in commands (≈9 KiB): it is what admits common nested shapes.
