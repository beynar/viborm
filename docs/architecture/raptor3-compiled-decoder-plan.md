# Raptor 3 — compile the prepared result shape once per execution

## Handoff and decision

Implement the execution-local decoder experiment as **one production decoder**, not as a flat-row fast path beside the current generic decoder. The goal is to remove repeated per-cell construction of provider continuations and repeated per-row inspection of a projection whose member list is already prepared. Preserve the existing result language and all provider-result validation.

Start from the current checked-out product tree, not by merging the prototype branch. At plan time this is `main` at `0dc70c28a` plus this document; the prototype `5d35d5224` was based on older `5d39cf95c`, and the product's `query.ts` has changed since then. Recheck the call graph and remeasure the **current** baseline before treating the prototype's ratios as applicable. The prototype is evidence and a useful source of tests; its flat-only dispatch and its second provider-chain implementation are **not** the production design. Inspect commit `5d35d5224` in the task-local worktree `/Users/arnaud/.codex/worktrees/decoder-compiled-prototype/viborm` if it still exists. The measurements and known limitations are in that tree's `benchmarks/decoder-prototype.md`. If the worktree is gone, recover the commit through Git rather than assuming the path exists.

No public API, driver or adapter contract, SQL, transport integer policy, transaction authority, cache semantics, or schema admission changes are in scope. Do not disable SQLite `safeIntegers(true)`: the rejected probe corrupted integers beyond `Number.MAX_SAFE_INTEGER`.

## Why this is worth doing

On Node 24.21.0, a matched ordered 1,000-row/six-scalar SQLite read measured 0.526 ms wall and 0.557 ms CPU per operation on the baseline, versus 0.457 ms wall and 0.484 ms CPU with a compiled flat decoder. The ten-call post-GC heap-growth proxy fell from about 1.98 MB to 1.00 MB per operation. Drizzle 0.43.1 measured 0.457 ms wall and 0.477 ms CPU in that fixture. One-row reads were effectively neutral. This is a strong local signal, **not** a production or cross-provider result. The heap figure is not retained memory or peak RSS.

The independent truths are already in the engine:

1. `Queries.prepareProjection` owns an immutable, alias-free `ProjectionShape`, including exactly which fields exist and where values are carried inside JSON.
2. The current execution's `Queries` owns the exact driver → adapter `parseField` chain; `decodeResult` owns `parseResult` once per operation.
3. `decodeScalar`, the existing scalar/list/JSON/decimal/date/vector/geo codecs, and `decodeRecursiveCarrier` own semantic validation.

The compiler may bind (1) and (2) for an execution. It must **reuse** (3), not translate scalar semantics into a new switch. A factory-level prepared projection may be shared across operations, but a compiled reader containing a driver parser must not be stored on that shared shape: borrowed transaction bindings can supply a different transaction-bound driver.

## Required ownership shape

- Keep `ProjectionShape` and `PreparedProjection` immutable and free of execution state. Keep preparation, SQL lowering, result parsing and recursive-carrier validation with `Queries` in `src/query-engine/raptor3/shared/query.ts`.
- Introduce one private compilation function/visitor over the existing shape. It returns a reader for a value; object, collection, variant and recursive nodes compose readers of their children. Build each object's ordered field slots once before mapping rows. Compile at the **current execution/decoding boundary**, with that `Queries` instance's driver and adapter, once per result batch/window. Do not compile per row or attach a driver-bound closure to `EngineSchema`'s shared leaves/default projections.
- Give the provider `parseField` continuation one owner. Capture the continuation for each physical scalar slot once, preserving driver-first/adapter-second order, `next` behavior, original `InvalidScalarResult` identity, and the current error translation for other throws. The prototype's `compileProviderValue` and current `providerValue` must not survive as separate authorities. A carried JSON member skips this chain exactly as it does today; SQL NULL and absent-value decisions remain before it.
- Keep one strict scalar decoder and its codecs. A compiled scalar reader binds the leaf, `internal` mode, carried/physical status and (only for a physical value) its provider continuation; it calls the existing strict decoder. List members are carried values, not fresh provider columns.
- Object validation and own-key reading are one rule for every placement: `null` only where the prepared shape permits it; an object but not an array for a row; own field access, never inherited values. Compile member names, not observed row keys. Keep fresh public result objects and arrays and existing identity/copy policy at the outer executor/parser boundary.
- Keep the recursive carrier's integrity, identity, depth, cycle, order and path-occurrence logic in `decodeRecursiveCarrier`. Pass it the compiled row/identity readers it needs; do not create a second recursive traversal or a different carrier validator. Variant orphan checks, singular/many results and reversed collections retain their existing owner and timing.
- `decodeProjection` and `decodeQuery` remain the entry points for ordinary reads, writes with `RETURNING`, terminal series, reference projections, prepared arrays and recursive reads. `decodeResult` remains above them and runs once per operation. No separate decoder per verb, placement or provider.

The exact internal function signatures are for the implementer to choose. The invariant is one semantic decoder language, with preparation amortized at the correct lifetime. A small compiled flat-object specialization is acceptable **only if it is produced by the same visitor and calls the same leaf and object rules**; a separate flat interpreter with a generic fallback is not.

## Work units (run in order)

### CD-00 — Freeze contract and independent baseline

Record the implementation head, Node and lockfile identities. Read `ELEGANCE.md`, `src/query-engine/AGENTS.md`, `src/query-engine/raptor3/AGENTS.md`, the current `query.ts` result code, the prototype diff and report, and the existing result-parser/recursive-carrier tests. Inventory every `decodeProjection`, `decodeQuery`, `decodeValue` and `decodeScalar` call site. For each shape node (`scalar`, `object`, `collection`, `variants`, `recursive`), record the exact carried/physical rule, nullability, error identity and applicable placements. Record which results are decoded through borrowed and prepared execution.

Copy or adapt the prototype's three public-client witnesses into a production-named test; remove `PROTOTYPE` comments. Add only missing falsifiers **before** the refactor. Expected results must come from the established public contract or baseline, not candidate output. Run the focused current tests and a clean baseline benchmark. Do not alter production code in this unit.

**Exit:** a compact behavior matrix, baseline source identity and green focused tests. If existing behavior is ambiguous, preserve it and surface a concrete compatibility choice; do not silently revise it for speed.

### CD-01 — Consolidate the provider and document boundaries

At `Queries`, replace the two provider-chain spellings with a single function that constructs a bound field reader/continuation. Prove the driver and adapter `parseField` middleware order, exact number of calls, transformed values, thrown-error identity/translation, SQL NULL and missing field behavior. Centralize object/null/own-key source reading for all placements, including non-null aggregate and `_count` carriers. Delete the superseded spelling. Do not add a cache, registry, parser-capability flag or stock-SQLite bypass.

**Exit:** focused parser and malformed-provider tests green; one provider-chain owner and one document-source owner remain; no performance claim yet.

### CD-02 — Compile the one projection language

Compile scalar and object readers, then collection, variant and recursive nodes by composition. Use the existing `decodeScalar` and `decodeRecursiveCarrier` semantic code; move only the invariant member/continuation work outside the row loop. Remove the old per-row shape walk when every call site uses the compiled reader. For recursive nodes, do not alter the carrier's graph algorithm or SQL; only replace its calls back into the per-row shape walker with the compiled row/identity readers. Keep the prepared read parser and operation-level `parseResult` wrapper at their present lifecycle boundaries.

Review the final code for two hidden decoders: an `if (flat) ... else decodeValue(...)`, a second scalar switch, duplicated null/own-key checks, or provider parsing reimplemented inside a hot branch. Those are redesign failures even when tests are green. Do not put compiled functions on frozen shared projection objects or cache them across independent driver bindings. Avoid a per-cell `Map`/`WeakMap`; the prototype's purpose is to eliminate that work.

**Exit:** all result shapes and placements run through one compiled visitor; behavior tests for flat, nested, variant, aggregate and recursive results pass. Count the actual deleted decisions and retained production LOC/token growth. Have an independent reviewer challenge the decoder lifetime, parser order, behavior matrix and claimed deletion before the broader gate.

### CD-03 — Adversarial behavior qualification

Use public-client and existing engine suites to challenge:

- Required, nullable and missing scalars; SQL NULL versus JSON `null`; booleans; exact safe/wide integers; scalar and list codecs, JSON output schemas, decimal, DateTime, blob, vector and geo leaves where supported.
- Driver and adapter `parseField`, driver `parseResult`, middleware that transforms values, middleware that throws, and errors already of type `InvalidScalarResult`.
- Own-key absence (`toString`/`constructor`-like names), malformed rows, malformed relation and aggregate carriers, null to-one, empty/reversed collections, variant orphans and mixed variants.
- Recursive projection with omitted compound keys, overlapping paths, cycles, depth, malformed carrier facts and repeated occurrences. Keep its existing refusal sentences and first-failure behavior.
- Flat and nested reads, `select`/`include`/`omit`, aggregation, `RETURNING`, root/nested selected series, terminal reads, prepared arrays, borrowed transactions, cached reads and concurrent clients with distinct parser bindings.

The second applicable placement of each shared rule must be executed, not asserted from code inspection. Run the narrow relevant suites while the source changes. On a stable source, run typecheck, package build, query-engine core, result-parser/parity, recursive-query SQLite/PGlite and native PostgreSQL/MySQL result suites. Use the repository's test lock and resource ceilings; do not compete with other test jobs. Run the broader core gate **once** on the frozen candidate, not after every edit. Report unrelated baseline failures separately.

**Exit:** no new type errors or contract failures; provider evidence is real, not inferred from SQLite. If a provider is unavailable, mark its qualification incomplete rather than claiming it passed.

### CD-04 — Measure, decide and deliver

Fix the prototype benchmark's hard-coded baseline path and `cwd`-selected candidate. Build two immutable task-local source trees (baseline and candidate) with the same lockfile and Node 24.21.0; print source IDs in each result. Keep ordered SQL, data, selected columns, boolean mapping, result checksum and row count equivalent. Run alternating fresh-process A/B passes for 1, 20 and 1,000 rows. Report median wall and CPU per operation, run spread, statements, and at least one allocation measurement using an actual allocation profiler or a clearly labelled heap-growth proxy. Measure flat and representative nested/variant/recursive shapes, including cold or prepare-only cost so the compiler's setup is visible. Drizzle may remain an external reference, **not** the correctness oracle or a hard acceptance target. Do not infer PostgreSQL/MySQL wall time from SQLite; report their statement counts and functional evidence separately.

Report the complete changed production LOC, parser-token count, source bytes and representative client bundle delta against the **same** baseline; include moved code and deletions. Explain each surviving new concept by the old decision/work it deletes. Do not claim retained-RAM improvement from transient allocation numbers.

Accept only if all behavior gates pass, the 1,000-row flat result retains a material CPU/allocation win over the matched baseline (the prototype suggests roughly 13% CPU and 50% short-window heap), small reads and structural results have no reproducible material regression, and the implementation has one decoder/provider-chain authority. Treat a repeatable regression above 5% in a representative full-operation cell as a review trigger, not as noise. If the win disappears under the sound harness, or preserving it needs a second decoder, retain the baseline and report the failed experiment instead of merging a benchmark trick. Correctness always wins over an arbitrary ratio.

Update the Raptor 3 architecture guide with the new decoder lifetime only after it is implemented. Keep the evidence in a small source-bound report. Make one task-scoped local Conventional Commit of audited source, tests and report; do not push unless asked. Preserve unrelated dirty and untracked work.

## Explicit non-goals and stop rules

Do not alter SQL shape, relation construction, selection/recovery, public types, driver parser signatures, cache result policy, raw-result policy or recursive-query semantics. Do not add defensive validation of already admitted input; provider output is a real trust boundary and must still be checked. Do not remove exact-integer transport or special-case the stock SQLite parser by identity. Do not count an optional parser bypass as an architectural improvement when the main compiled decoder already captures the gain.

If a minimized correctness failure survives two bounded repairs, if the design requires a parallel decoder, or if a compatibility decision would change an observable contract, stop and present the failing witness plus the smallest choice to Arnaud. Do not conceal an unresolved native-provider gap under a green SQLite gate.

## Done means

One source-bound production decoder compiles the prepared shape against the current execution's provider parsing rules, then reads rows without rebuilding that structure per cell. Every existing result placement keeps its answer and failure semantics. The repeated work is measurably lower, the implementation's net code and bundle cost are reported honestly, the focused and frozen qualification gates pass, and there is no second decoder to maintain.
