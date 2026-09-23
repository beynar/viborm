# Raptor 3 — G2.5 foundation consolidation

Date: 2026-09-08. Status: **complete; G3 not started**.

The [central plan](../raptor3-implementation-plan.md) owns this checkpoint.
G2's completed closure and archive remain unchanged. No public routing, new
feature, diagnostic-policy change or expanded retry eligibility is authorized.

## Baseline

Before edits, the production/harness/runtime identity exactly matched the frozen
G2 closure. The production baseline is 4,342 charged code-bearing LOC.
Baseline fixed candidate contracts passed 216/216 with verified teardown:
`viborm-raptor3-g0-wQCmvc` (14.93s wall, 772.8 MiB sampled process-group RSS).
This receipt precedes G2.5 implementation and is not final-source qualification.
The retained representation comparison also passed 66/66 with verified teardown:
`viborm-raptor3-g0-pY3mAS` (14.21s wall, 708.6 MiB sampled process-group RSS).

The new falsifiers were first run against the archived G2 engine, with only
their new test harness overlaid in an isolated directory. Four SQLite contracts
and twelve exact replays passed (`viborm-raptor3-g0-9OijKH`); two native
PostgreSQL contracts passed (`viborm-raptor3-g0-lUrlSU`). These receipts pin
private G2 behavior, not the shipped engine and not final G2.5 source.

That distinction was measured before changing an oracle: the shipped engine
observes the missing connect-or-create target inside its transaction, does not
expose the same supplier prefix, emits a different nested-upsert membership
failure, and can issue another INSERT after its recovery winner disappears.
The initial differential fixtures therefore failed against shipped behavior.
The final additions explicitly test private G2, preserving all causal cuts,
exact expected states and private failures. G2.5 introduces no new compatibility
waiver and makes no new claim of complete shipped-engine parity.

## Ownership and deletion contract

| Necessary fact | New single owner | Machinery to remove | Decisive witnesses |
|---|---|---|---|
| One relation body's ordered composition | Lexical `RelationBody` with parent and resolved slot | Eight-argument cascade, returned-supplier threading and downstream supplier reclassification | Supplier continuation, singular lattice and variant removal contracts |
| How a record is selected versus what was observed | Stable selection; command-attempt observation | Mutable lookup results/selector rewrites, fake row lookup modes | Foreign/missing target, optional absence re-observation, conditional skip |
| Captured identity/membership must survive until use | Explicit retained requirement | Second found-guard lookup and repeated captured-predicate construction | Membership staleness, complete-key decoys, conditional and junction races |
| Field equation versus execution value | Symbolic Assignments; execution binding owner | Assignments transport/unbind and visited-command publication scan | Generated parent/supplier outputs, transitions and failed prefix continuation |
| Unsuccessful attempt can be replaced | One synchronous command/transport recovery handoff | Snapshot/restore journal, per-command reset and per-field transport reset | Exact failed INSERT, wrong constraint/producer, winner lost, once-only transforms |
| Repetition instantiates ordinary selected bodies | One selected-series construction/execution path | Separate root/nested preparation and execution loops | Admission ordering, collection-filter observation, member loss and acknowledged progress |

Prepared inputs, confirmed/uncertain progress, committed continuations,
transaction ownership and admission history stay outside disposable state.
An absent observation must preserve existing re-entry timing; a successful
submission does not finish the whole progressive command attempt.

## Work and qualification

- G2.5-01: complete. Frozen-G2 baseline and six independent additional contracts
  verified before candidate acceptance.
- G2.5-02: complete. Selection and attempt ownership passed focused contracts
  and independent review.
- G2.5-03: complete. Relation composition and one selected-series mechanism
  passed focused contracts and independent review.
- G2.5-04: complete. Final fixed/native/generated/transport checks, both complete
  G2 campaigns and fresh saved replays pass on frozen source. Independent review
  covered all eight authored production files and the final deduplications,
  with no blocking findings. The whole-estate typecheck exits 1 with only the two
  existing Pattern TS2345 failures at `src/query-engine/pattern/pack.ts:1443`
  and `:2633`; there are no new errors. The source archive is verified.

## Final-source evidence

The [closure index](g25-closure-index.json) owns the exact commands, receipts,
runtime identity, provider metadata and resource measurements; the
[run log](g25-closure-runs.log) retains their execution record. Final identities:

- Production: `ad7f2f282a341a092ab6397f44f40aeb3cf24edf3a672a15def807c9fb46717c`.
- Harness: `52c86fab14e16a2f1ed2562364651c6c14d6c9c9c4c542a9f76ca4aec2eb299a`.

G0, G1 baseline/contracts/comparison/generated/transport, G2
baseline/contracts/generated/transport, native PostgreSQL and MySQL checks,
the six additional private-G2 contracts, fresh polish/conditional corpus replay,
and all seven checkpoint-runner checks passed without skips. The diagnostic
reproduction also passed, but remains non-qualifying evidence of the inherited
policy. It does not approve that policy.

Both existing G2 campaigns were rerun in full: 5,000 seeds per profile across
SQLite interactive, SQLite atomic batch, scripted returning weak and scripted
returning acknowledged transport. This is **20,000 seed/profile cells and
60,000 exact candidate replays, with zero skips**. The SQLite receipt is
`viborm-raptor3-g2-seeds-Cp2szA`; the transport receipt is
`viborm-raptor3-g2-transport-seeds-g2kLsE`. All 100 campaign children have verified
teardown. Runtime checks ran serially within the recorded ceilings. The
whole-estate typecheck is a separate measurement, with 5,261.5 MiB sampled RSS;
it is not a passing runtime resource gate.

Native checks used PostgreSQL 16.14 and MySQL 8.4.11. Both disposable provider
containers were stopped and auto-removed, with no host mounts, OOM or restart.
Only disposable test data was removed; evidence was retained. Scripted transport
campaigns establish their modeled contract, not additional native-provider or
performance qualification.

The [G2.5 evidence archive](g25-closure-evidence.tar.gz) contains source/config,
census, index, log, 127 receipt directories and its assembly recipe: 1,462 exact
verified entries, 29,879,500 bytes, SHA-256
`acad0d87c4c61e809531d34ef251f40383f8f6d4f8b5753dfbac81c16932717c`.
Assembly verified exact membership, safe relative paths and unchanged source
identity before/after; dependencies, environment files and credentials were
excluded. It took 5.00s and 79.7 MiB with verified teardown. This is an evidence
snapshot, not a standalone repository: the global Vitest configuration still
requires the existing unchanged test estate. The original G2 archive remains
unchanged at SHA-256
`453d4166e1e0f679479d077414450cb9e9c00da90b9778bb1e8ba731f966e5e3`.

## Explicit whole-cost review

The [fresh census](g25-cost.json) charges every moved or retained production
owner in full, using the unchanged token-line counter. It is not bundle size.

| Charged component | G2 code-bearing LOC | G2.5 code-bearing LOC |
|---|---:|---:|
| Selected command language | 1,886 | 2,124 |
| Shared owners, charged whole | 2,007 | 2,010 |
| Retained boundaries, charged whole | 449 | 449 |
| **Total** | **4,342** | **4,583** |

The result is **+241 LOC (+5.55%)**, not a reduction. Physical lines rise from
4,748 to 5,000; source bytes from 157,234 to 164,954; charged files from 12 to 17.
No code was moved outside the charged scope. The earlier intermediate census
was 4,590 LOC; sharing full-row query construction and lazy scratch setup
removed seven more lines without changing their semantics.

Root integration accepts this bounded increase for this foundation checkpoint:

- `RelationBody` removes ownership conflicts between a relation's lexical parent,
  variant/raw input pairing, order and supplier continuation. The builder no
  longer carries these through the old relation argument/return cascade.
- `Selection` separates stable query/producer instructions from observations;
  junction and absence commands no longer impersonate model-row lookups.
  A retained membership check still requires a real observation and an atomic
  consuming-write assertion. Removing the second mutable `foundGuard` node does
  not justify deleting either of those distinct obligations.
- `CommandExecution` removes interpretation and upsert-policy construction from
  the same owner. Its two composed attempts replace runtime journals and field
  resets while preserving stable admission, progress and recovery allowance.
- Symbolic assignments no longer contain transport values. One binding map
  supplies every field consumer and every demanded prefix publication.
- One selected-series mechanism removes duplicated preparation/execution rules
  while retaining the two distinct public admission boundaries.

The additional owners encode demonstrated conflicts, not future extensibility.
Both independent review and root inspection found the claimed machinery absent.
This does not establish lower runtime branch count, a smaller package, or future
G3 compression; those claims require their own evidence. The checkpoint's
no-arbitrary-percentage rule applies, and G3 has not started.
