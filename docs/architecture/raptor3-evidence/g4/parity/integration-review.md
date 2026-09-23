# Integration unit — independent review

Reviewer: independent review agent, 2026-09-17. Worktree
`/private/tmp/viborm-parity-merge` (branch `parity`, HEAD `395b9dd4`),
`TMPDIR=/private/tmp/viborm-parity-tmp-merge`. Read in full before the first
command: the parity plan, `g4/briefs/common.md`, the merged
`src/query-engine/raptor3/AGENTS.md`, both lane notes, both lane reviews and
both re-checks, the ledger's D-17..D-27, and the author's `integration-note.md`.

Nothing was committed, staged, reset, stashed or pushed. The only file this
review wrote outside the worktree is this one. Every falsification mutation was
taken against a scratchpad backup and restored byte-for-byte; the worktree ends
at the author's exact state (`query.ts` `1250f8e9…`, `execution.ts`
`b5a876ce…`, `operation-context.ts` `feecdc4b…`, `git status` identical to
arrival).

## Verdict: **REVISE**

Three small, local, behaviour-free resolutions (§A). Everything else is
accepted: the five pieces are real, each invariant is at one owner, the
falsifiers genuinely falsify, the registered sentences are byte-exact, no test
was deleted or weakened, no `.skip`/`.only`/`todo(`, and the whole-estate
typecheck is zero at exit 0.

---

## 1. What I ran (all through the bounded runner, one file per call, serial)

| target | project | result |
| --- | --- | --- |
| `tests/providers/docker/pg-polymorphism-ddl.test.ts` | `provider-pg` (55729) | **60/60** — the dialect the author did NOT run; both D-26 cells green |
| `tests/providers/local/sqlite3-polymorphic-batch.test.ts` | `provider-sqlite3` | 149 passed / 1 skipped |
| `tests/raptor3/g4/parity/integration-staleness.test.ts` | `extended-local` | 3/3 |
| `tests/raptor3/transitions/recovery-boundaries-live-commands.test.ts` | `raptor3-live-provider` (pg) | 2/2 |
| `tests/contracts/engine/query/parity-admission.core.test.ts` | `layer-query-engine` | 75/75 |
| `tests/contracts/engine/query/bulk-insert-row-shapes.core.test.ts` | `layer-query-engine` | 2/2 |
| `tests/providers/local/sqlite3-nested-write.test.ts` | `provider-sqlite3` | 85/85 |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` | `extended-local` | 9/9 |
| `tests/raptor3/g4/unit02/physical-envelope.test.ts` | `raptor3` | 10/10 (the envelope restart now re-plans — see F2) |
| `node scripts/run-typecheck.mjs` | — | **0 diagnostics, exit 0** |
| `npx biome check` on all eight touched files | — | 26 errors, **none on a line this unit wrote** (verified per hunk) |

Plus the coverage sweep of §A.1: `suppression-replay` 5/5,
`suppression-retry-contract` 2/2, `bulk-series-contract` 6/6,
`g29-dependency-boundaries` 4/4, `unique-races-live-commands` 3/3,
`junction-races-live-commands` 3/3.

### The falsifiers actually falsify (6 independent mutations, each restored)

| mutation | effect |
| --- | --- |
| `prepareProjection`'s `memberships` forced empty (D-26 orphan probe off) | `sqlite3-polymorphic-batch` 1 red: *an owner-scoped orphan fails the read, even hidden behind only*; 148 others green |
| `duplicateMembershipGuard` returns `projected` unconditionally | `pg-polymorphism-ddl` 1 red: *a singular-inverse duplicate fails BEFORE the LIMIT*; 59 others green |
| `captureSeries`'s `requireNoAddedMember` call short-circuited | `integration-staleness` **3/3 red** |
| `batchAttempt`'s assertion arm short-circuited (guard kept) | `integration-staleness` 2/3 red — cell 1 (the guard rides the batch) stays green, so guard and recovery are covered independently |
| `refuse: refuseDefaultOnlySkipDuplicates` dropped from `relations/create.ts` + `relations/update.ts` | `sqlite3-nested-write` 1 red: *rejects nested default-only duplicate skipping before the parent write* — admission, not a leftover physical guard, owns the nested spelling |
| the `batch-preparation` arm of the empty `createMany` removed | `bulk-insert-row-shapes` 1 red: *empty createMany rejects during batch preparation* |

### Registered sentences, byte for byte

- `No data to insert for createMany.` — one owner, `operation-context.ts:1623`.
- `createMany with skipDuplicates cannot include a row with no explicit scalar values; no portable duplicate-only DEFAULT VALUES primitive exists.` — one owner, `validation/model/args/mutation.ts:80`, consumed by all four admission spellings (`mutation.ts:128`, `relations/create.ts:173`, `relations/update.ts:433`, `relations/polymorphic/collection-mutation.ts:294`, the last reached from both the create- and update-context verb maps). The physical copy is gone and nothing else raises it.
- `Polymorphic relation '<slot>' references a missing '<type>' record.` — one decoder arm (`query.ts:4249`), matching `polymorphic-collection-read-behavior.ts:455/466/474` and `polymorphic-relation-behavior.ts:560/568`.
- The `membership` command's sole construction site (`relation-body.ts:146-150`) does place it `"before"`, so the arm Piece 4 removed was genuinely unreachable.
- `POLYMORPHIC_COLLECTION_ORPHANS_KEY` has exactly three consumers (the constant, the lowering, the decode); no pin asserted the old `"orphans"` spelling.

---

## A. Resolutions required (exact, minimal, behaviour-free)

### A.1 — `recoveryRejection`'s `memberAdmissionStarted` conjunct has no unique coverage, and the guide's rationale for it is not what the estate measures

`src/query-engine/raptor3/shared/operation-context.ts:1200-1204`.

Measured, not argued. Removing **only** that line leaves every suite that could
plausibly cover it green:

```
recovery-boundaries-live-commands  2/2    unique-races-live-commands   3/3
junction-races-live-commands       3/3    suppression-replay           5/5
suppression-retry-contract         2/2    bulk-series-contract         6/6
g29-dependency-boundaries          4/4    integration-staleness        3/3
sqlite3-nested-write             85/85
```

The registered pin only reddens — with exactly the author's observable,
`'Error'` where `'UniqueConstraintError'` is owed — when the **same conjunct is
also removed from `submit`'s attribution site at `:1075`**. That site is the
only place `attempt.rejectedInsert` is ever assigned (`:1085`), and
`rejectedProducer` (`:1179-1182`) is its only reader, so the insert arm of
`recoveryRejection` can never be reached with `memberAdmissionStarted === true`:
its copy cannot change an answer.

So the fact is real and load-bearing, but it has **one** owner — `submit` — and
this unit ships a second reader of it at the decision point. That is the
"guard whose unique coverage cannot be named" rule the unit itself applied in
Piece 4 to delete `adoptSuppressed`'s `membership` arm. It also makes the note's
"the one place the rule had to be split" and `AGENTS.md:945-951` ("So
`memberAdmissionStarted` still bounds THAT arm, and … still pins the original
`UniqueConstraintError`") untrue as written: the estate forces the bound at the
attribution site, not at the rejection classifier. Arnaud is being asked to
ratify a split at the wrong owner.

Resolution:

1. Delete `operation-context.ts:1200-1204` (the four comment lines and
   `if (this.memberAdmissionStarted) return undefined;`).
2. Move that paragraph onto the `!this.memberAdmissionStarted` conjunct at
   `:1075`, beside the existing "Atomic rejection is retryable only with exact
   effect attribution" comment — the owner that actually refuses to record a
   producer once a dynamic member was admitted.
3. Rewrite the `AGENTS.md:945-951` bullet to state the bound at that owner:
   a rejected INSERT is attributed only while no dynamic member has been
   admitted, because its defaults and transforms already ran once (rule 10);
   `recoveryRejection` then asks about attribution and progress only.
4. Re-run `recovery-boundaries-live-commands` (`raptor3-live-provider`, pg): it
   must stay 2/2. I measured that it does.

### A.2 — the guide's INSERT/ASSERTION split misdescribes the region route

`commands/index.ts:183-205` now builds a **fresh plan for every attempt after
the first**, and `regionAttempt` (`operation-context.ts:826-841`) re-enters that
same body. So on a transaction-capable provider the INSERT recovery **re-plans**;
only `CommandExecution.recover`'s in-place path replays. The guide's second
bullet ("a rejected INSERT is answered by a REPLAY of the tree that ran") is
therefore false for the route that has a region. The behaviour is right — it is
what the shipped `routing.ts:180-208` did, and `unique-races-live-commands` 3/3
confirms convergence — but the sentence is not.

The same commit also makes the **envelope restart** re-plan (`run`'s deferred
arm calls `body()` twice). `physical-envelope.test.ts` 10/10 confirms no double
write and `restarts === 1`, but the guide does not record that the restart is
now a re-plan.

Resolution: in the same `AGENTS.md` edit as A.1, say which recovery replays
(the in-place one, where this operation opened no region) and which re-plan (the
region re-entry, the batch re-entry and the envelope restart), and add one
sentence that a re-plan is safe because `EngineSchema.admit` is memoised in
`commands/index.ts` (`admitted ??=`) so no default or transform runs twice.

### A.3 — debug scaffolding in the shipped test

`tests/raptor3/g4/parity/integration-staleness.test.ts:176-187`: `createWorld`
wraps the seeding `board.update` in a `try { … } catch { console.error("PROBE-setup", …); throw error; }`.
It is a catch that only logs and rethrows — both banned by the repo's
`CLAUDE.md` ("remove `console.log` …", "don't catch errors just to rethrow
them"). Resolution: delete the try/catch and keep the bare
`await client.board.update({ … })`; re-run the file (3/3).

---

## B. Nits (take or leave; no re-run needed)

- **B.1** `query.ts:3866-3867`'s `throw new Error("Raptor 3 variant integrity requires junction storage")` is unreachable: `memberships` is populated only when `many`, `many` is `resolved.edge.kind === "variantJunctionCarrier"` (`query.ts:3482`), and `bindMembership` returns `kind: "junction"` for exactly that edge (`storage.ts:110-133`). It exists to narrow the type. If you want the same rule applied as in Piece 4, type `PreparedProjectionField`'s `memberships[].edge` as `Extract<Membership, { kind: "junction" }>` and drop the throw.
- **B.2** The D-26 decode fails **open** on one representation: `query.ts:4244-4245` acts only when the carrier is an object, while every other carrier in that decoder is re-parsed (`typeof value === "string" ? JSON.parse(value)`). No live provider hits it — SQLite, PostgreSQL (mine, 60/60) and MySQL (author's receipt) all hand back an object — but a provider that returns the nested document as text would make the integrity probe a silent no-op. One-line hardening: decode the carrier with the same string rule the arms use, or refuse a carrier that is neither absent nor an object.

## C. Accepted as reported

- **Piece 1a/1b/1d** — verified by falsification; the two D-17 constructor lines are present (`operation-context.ts:345`, `commands/index.ts:144`).
- **Piece 1c, refused with evidence** — I re-measured the load-bearing half: `DriverResultParser.parseResult` is declared and implemented by every driver and has **no consumer under `src/`**. The refusal is correct; it is a decision (the other half of D-17), not a repair, and the author made no speculative edit.
- **Piece 2 (U6.5 under D-25)** — the complement guard and the one-recovery re-plan are independently covered (falsifications 3 and 4). The allowance is spent in one place (`OperationContext.spendRecovery`), `CommandExecution.replaceRegions` is its only callee and carries no second counter, and a re-planned operation's new interpreter brings none.
- **Piece 3 (D-26)** — now verified on **three** dialects: SQLite (149/1), PostgreSQL (60/60, this review), MySQL (author's receipt, both cells named green). An ordinary pair table's bytes are unchanged (`duplicateMembershipGuard` returns `projected` for every non-`variantJunctionCarrier` edge, and the integrity entry is emitted only for `many`).
- **Piece 4** — all five re-check items applied; the `membership` arm removal is structurally sound (one construction site, always `"before"`).
- **Piece 5** — the `parity-admission` re-pin is a re-pin, not a weakening: the cell still proves admission let the default-only row through, and now names the driver's U5.5 shortfall as the refusal that answers it. Disclosed in the note.
- The two stay-red cells (cache-SWR, pg staleness) are measured, written, and not hidden.

## D. Unverified by this review

- **PGlite** is unverified for D-26. `tests/providers/local/pglite.test.ts` registers `polymorphicCollectionReadContract`, but the bounded runner hard-caps `--rss-limit-mb` at 1536 and that file peaks at ~1589 MiB (the credential-free manifest documents a 1294 MiB PGlite floor and a 1747 MiB heaviest file). The real `pg` driver over the same `PostgresAdapter` SQL is green, so the risk is confined to the driver's own row/JSON handling (see B.2).
- The D-26 probe's **cost** against the D-9 budget: a polymorphic collection read now carries one correlated `COUNT(*)` per configured member and a singular polymorphic inverse one more. No A/B taken here either; the author disclosed the same.
- The whole `provider-pg` / `provider-mysql2` projects beyond the files named above, `mysql2-relations-ddl`, the `raptor3` project's other files, and every campaign/replay — out of scope under the "minimum tests" instruction. The author's `final-local-providers.txt` (764 passed / 0 failed, 664 env-skipped libsql) and `final-mysql2.txt` (4 failed, all namespace-containment) were read and are consistent with their note.
- **Pre-existing, not this unit's**: `tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior.ts:534-541` cites `polymorphic-inverse-read-sql.core.test.ts` for the bytes pin of "both integrity branches sit outside the row subquery"; that file does not exist in the tree and did not at `356254a2`. The `LIMIT` half is nonetheless behaviourally proven (falsification 2); the "target filter" half is unreachable by construction, as the same comment says.
