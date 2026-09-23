# T1 — the batch route's half of the FOUND-consumption rule

Repair prompt 2 §1 (`docs/architecture/raptor3-local-closure-repair-2-prompt.md`).
Base `88fe2814b` on `pattern-engine`, worktree `/private/tmp/viborm-te`,
branch `closure-te`. Native PostgreSQL 16 (own database `te_brr_closure`) and
native MySQL 8 for the preserved families. Receipts: [`receipts/`](receipts/).

## 1. The failing witness

U1's note §11 recorded the gap and did not close it: *"The CURRENT-reference
half of the rule is interactive-only on this tree."* On the batch route
`CommandExecution.confirmFound` returns the probe's bytes untouched, and for a
PARENT-held `connectOrCreate` no found command is built
(`RelationBody.association`'s `conditionalParentBinding` is undefined when the
SOURCE owns the reference), so `folded` returned its argument unchanged — the
holder's own statement spent the plan-time literal. What the unit states as
premises is the row's identity, its membership and its matched condition; the
referenced COLUMN is not among them.

The schedule, on two real PostgreSQL connections through the repository's
forced batch profile: `b1(slug: "chosen", code: "G")` is observed; B commits
`b1.code = 'M'` and creates `b2(slug: "unselected", code: "G")`.

| witness | red at base | after |
| --- | --- | --- |
| `pg-batch-reference-reuse` — a key recycled onto another row before the unit cannot move the connection | `badgeCode: "G"` — the holder became a member of **`b2`**, a row its selector never named | `badgeCode: "M"`, a member of `b1` |
| … the COMPOUND key, in either member | `passSerial: "S1"` — a member of `p2` | `passSerial: "S9"`, a member of `p1` |
| … the unit's premise HOLDS the located row through the statement that spends it | B's UPDATE of the located row completed while the unit's write was still to come | B waits on the premise's lock and commits after this operation |
| … a reference nulled before the unit is refused by the relation's own sentence | `Foreign key constraint violation` — the provider refusing a key the ENGINE chose | `Cannot connect relation 'badge': the located target's referenced field 'code' is null.` |

Native: **4 failed / 2 passed** at base
([`receipts/02-red-at-base-pg.log`](receipts/02-red-at-base-pg.log)) →
**6 / 6** after ([`receipts/05-pg-green.log`](receipts/05-pg-green.log)).
Credential-free, on both local forced-batch fixtures: **24 failed / 20 passed**
at base ([`receipts/01-red-at-base-sqlite.log`](receipts/01-red-at-base-sqlite.log),
6 of 11 cells) → **44 / 44** after
([`receipts/04-sqlite-green.log`](receipts/04-sqlite-green.log)).

## 2. The continuing invariant, and its single owner

**Invariant.** A value a located row supplies to the HOLDER's own statement is
read WHERE IT IS SPENT, and read at the row this operation LOCATED. On the
interactive route the confirmation's lock makes the bytes it re-bound that row's
own (U1); on the batch route, which takes no read here, the statement itself
reads them — as a scalar sub-select pinned to the captured complete identity,
never to the arm's public selector, because a probe that read unlocked cannot
vouch for a selector a replacement row may since have acquired.

**Owner.** One method, `CommandExecution.folded`
(`src/query-engine/raptor3/commands/execution.ts`) — the engine's existing owner
of "the value a parent-held arm writes into its holder's own SET, read where it
is spent", and the only reason the representability requirement is stated from
two places. It gains ONE arm: where the probe read unlocked
(`Selection.insertsWhenAbsent`) and the route is the batch one, the selector it
reads at is `Queries.includeIdentities` over the located row's own key instead
of `lookup.selector`. The operand is unchanged (`Queries.locatedValue`). There
is no second interpreter, no per-verb switch and no concurrency manager; the
interactive route is untouched.

Two facts stand beside it, each with its own coverage, and each falsified:

- **The selection's retained premise is HELD** wherever the probe read unlocked
  (`Selection.captured`'s existing `held` argument, `runSelection`). A premise
  and the effect it protects are two statements; where the provider has a lock
  to take, this one keeps the located row through the statement that spends it.
  Addressed by the identity of a row that EXISTS, so it locks no absence and
  R2c is untouched. This is the mechanism D-65 already decided for a captured
  member (`holdMember`), used at the boundary that now needs it.
- **The representability requirement is stated of the row the sub-select will
  read.** Once the value is folded it IS a sub-select, so
  `requireRepresentable` can only be asked of the CAPTURE — the literal is gone.
  The same requirement is therefore stated as an ABSENCE premise of the same
  unit (`Selection.unrepresentable`): *no row with this identity holds NULL in
  this component*. One premise per NULLABLE component, each carrying that
  component's own sentence, and **none at all** for a component no schema admits
  a NULL in. An absence, so a row that has GONE satisfies it and that loss stays
  the presence premise's, with the sentence that premise owns — the attribution
  is exact without a second round trip.

## 3. The hunk

```
 src/query-engine/raptor3/commands/execution.ts          | 130 ++++---   (+115 net)
 src/query-engine/raptor3/commands/selection.ts          |  29 +         (+29  net)
 src/query-engine/raptor3/AGENTS.md                      |  38 +         (guide addendum)
 tests/raptor3/g4/parity/batch-only-drivers.ts           |  34 +/-2      (the between-statements hook)
 tests/raptor3/transport/world.ts                        |  13 +/-1      (§7, re-expressed by derivation)
 tests/providers/local/sqlite3-batch-reference-reuse.test.ts | new (11 cells)
 tests/providers/docker/pg-batch-reference-reuse.test.ts     | new (6 cells)
```

- `execution.ts`: `folded` becomes `async` and chooses its selector — the arm's
  own for a parent-held `connect` (byte-identical to base, every pin preserved),
  the located identity for the new arm (`locatedAt`, which also states the
  representability premises). `spentByHolder` is the gate: the components the
  ENCLOSING record's own write reads out of this choice, which is
  `Commands.assignMembership`'s own contribution read back — true for the
  parent-held direction, false for a junction's captured pair and for a
  child-held arm's value. `requireRepresentable` keeps its sentence and gains a
  sibling that BUILDS it (`unrepresentable`), so one sentence has one builder
  and two askers. `runSelection`'s retained premise passes `held`.
- `selection.ts`: `unrepresentable(field)` — this located row with one spent
  component reading NULL, the complement premise of the fold. Same
  `identityProjection`, same identity addressing; no new query owner.
- `batch-only-drivers.ts`: `BatchOnlyDriver.plantBeforeFirstWrite`, the
  between-statements hook, splitting the batch at the boundary
  `PgWindowedBatchDriver` already splits. Unset, the batch runs exactly as
  before (one `super.executeBatch`), so no existing pin's round-trip count
  moves.

## 4. What disappears

**No deletion.** The base's `folded` gate
(`origin.operation !== "connect" || membershipOnly !== false → return captured`)
is not removed but re-expressed as the first of two selector arms, and its
answer for every `connect` is the same object it returned before. No branch,
check or method is deleted by this unit.

**Not deleted, with its unique coverage named.** The presence premise
(`Selection.retained`) stays, and it is what answers for a DISAPPEARED row —
the new absence premise deliberately cannot, which is what keeps the two
sentences apart. The interactive confirmation stays; on that route no fold is
taken at all.

## 5. A second applicable consumer

Beyond the recycled-key schedule, the same rule answers for:

- a **ROOT create's own INSERT** spending the located reference, and a **NESTED
  placement** where the holder is itself a nested `create` — same rule, no
  placement fact anywhere in it (two cells).
- a **COMPOUND, column-mapped reference**: both members are folded and both are
  read at the same identity (`pass.zone`/`serial` → `gate`), natively and
  credential-free.
- the **SESSIONLESS** batch transport (D-53), which discards its batch-reference
  scratch between dispatches: the folded value is a sub-select inside the
  consuming statement and not a scratch value, so both fixtures answer alike —
  every cell runs on both.
- the **representability** requirement itself, which now holds on the batch
  route in the window it could not reach before (the NULL-transition cell),
  without a new sentence.

## 6. Capability change

**None.** No valid uncontended operation becomes a refusal: "commits its
ordinary result when nothing interferes" (both local fixtures) and "an
uncontended found consumption commits its ordinary result on the forced batch
profile" (native) exercise the found consumption AND the create arm of a missing
target and pin the ordinary results. Missing-key probes still read unlocked and
take no premise of this kind; the interactive route is unchanged
(`mysql2-found-consumption` 12 / 12); the unique-key race still converges
(`mysql2-concurrency-policy` 11 / 11). No error sentence is added, changed or
removed.

The cost on the batch route, for a parent-held `connectOrCreate` whose probe
FOUND its target: the consuming statement binds a scalar sub-select instead of a
literal (no extra round trip — it is inside the statement that was already going
out), the existing presence premise gains `FOR UPDATE`, and ONE additional
premise statement is queued **per nullable referenced component** — zero for a
reference that points at a non-nullable unique, which is the ordinary shape.

The FOLD is the parent-held placement's alone. The HELD premise is wider: every
`connectOrCreate` probe that FOUND its row on the batch route now states its
retained premise as a locking read — junction and child-held placements
included, where nothing is folded — which no cell can observe on SQLite, whose
select assembly omits `FOR UPDATE`. Nothing else on any route, verb or placement
pays anything.

## 7. Registrations

| file | cells | project(s) |
| --- | --- | --- |
| `tests/providers/local/sqlite3-batch-reference-reuse.test.ts` (new) | **11** | `provider-sqlite3` (glob `tests/providers/local/sqlite3*.test.ts`) and `coverage-drivers` (directory scan, `scripts/driver-test-manifest.mjs`) — 44 executions |
| `tests/providers/docker/pg-batch-reference-reuse.test.ts` (new) | **6** | `provider-pg` (glob `tests/providers/docker/pg*.test.ts`) |
| `tests/raptor3/g4/parity/batch-only-drivers.ts` | — (fixture) | — |
| `tests/raptor3/transport/world.ts` | — (scripted world) | `raptor3`, `coverage-raptor3` |

`scripts/raptor3-manifest.mjs` is **NOT** edited: neither new file is in a
manifest-enumerated project, both reach their lanes by glob or directory scan.

### The re-expressed pin, and why

`tests/raptor3/transport/world.ts`, the `coc-found` consumer's INSERT. The
repaired contract changed the answer (repair prompt 2 §1, named at the script):
a FOUND supplier's reference is now read at the located identity inside that
statement, so its parameters are `[tokenId, accountId, 1]` — the identity and
the sub-select's limit — where they were `[tokenId, code]`. Nothing else in the
script moves: the premise SELECT's parameters are unchanged, the statement COUNT
is unchanged, and a PRODUCED supplier still carries its own value.

It is re-expressed **by derivation, not by relaxation**: with the repaired
production files restored to base, the re-expressed script is RED — 8 failed /
80 passed, the four `coc-found` and `wrong-publication` cells of both scripted
profiles ([`receipts/03-red-at-base-transport.log`](receipts/03-red-at-base-transport.log))
— and green on this tree. No assertion is weakened, deleted or skipped.

## 8. Runs

One Vitest at a time; one docker file per invocation; each connection string was
substituted into its own command from its file and never printed.

| run | result | receipt |
| --- | --- | --- |
| `pg-batch-reference-reuse.test.ts`, production source at BASE (native pg) | **4 failed / 2 passed** — the four defects | `02-…` |
| `sqlite3-batch-reference-reuse.test.ts`, production source at BASE | **24 failed / 20 passed** — 6 of 11 cells | `01-…` |
| `transport.test.ts` with the re-expressed script, source at BASE | **8 failed / 80 passed** | `03-…` |
| `sqlite3-batch-reference-reuse.test.ts` (credential-free) | **44 / 44** (11 cells × 2 fixtures × 2 projects) | `04-…` |
| `pg-batch-reference-reuse.test.ts` (native PostgreSQL) | **6 / 6** | `05-…` |
| `mysql2-found-consumption.test.ts` (native MySQL) | **12 / 12** | `06-…` |
| `mysql2-concurrency-policy.test.ts` (native MySQL) | **11 / 11** | `07-…` |
| `pg-captured-set-concurrency.test.ts` + `pg-reference-representability.test.ts` (native pg) | **28 / 28**, **5 / 5** | `08-…` |
| `reference-representability` + `transport` + `transport-campaign` | **142 / 142** | `10-…` |
| the statement-count pins: `member-boundary-packaging`, `published-key`, `batch-observed-publication`, `generated-key-reach`, `fresh-member-placement` | **100 / 100** | `10-…` |
| `exclusive-member-cardinality`, `suppressed-membership-target`, `transport-witnesses`, `sqlite3-found-consumption`, `sqlite3-captured-answer-settlement` | **74 / 74** | `10-…` |
| write contracts: `parent-held-lookup`, `shared-pk-connect-or-create`, `upsert-arm-referenced-edge`, `parent-held-compound-edge`, conformance `fk` / `to-one` | **56 / 29 / 18 / 16 / 28 / 19** | `11-…` |
| `pglite-nested-writes.test.ts`, `ordered-observation.test.ts` | **126 / 126**, **39 / 39** | `11-…` |

### Falsifications ([`receipts/09-falsifications.log`](receipts/09-falsifications.log))

Each applied to a backup copy in `$TMPDIR` and restored by `cp`; `git checkout`
was not used and nothing was staged.

| mutation | red — and ONLY this |
| --- | --- |
| the identity pin replaced by the arm's own selector | "does not adopt a replacement row that acquires the SELECTOR after the premise" (4 / 44) |
| the representability ABSENCE premise deleted | "never writes the NULL a reference transitions to" (4 / 44) — and it fails by **resolving**: `Missing expected rejection`, the NULL silently written |
| the holder-spends gate widened to every demand | "asks nothing of a JUNCTION choice, whose captured pair is not the holder's own field" (4 / 44) |
| the retained premise's hold dropped (native PostgreSQL) | "the unit's premise HOLDS the located row through the statement that spends it" (1 / 6) |

The lock is proved by a SCHEDULE, not by a hook moved ahead of the race: a
second connection's `UPDATE` of the located row is started after the unit's
premise has answered, is observed still pending one second later when the unit's
own write goes out, and completes only once this operation has committed — with
the serialized final state.

## 9. Typecheck, census, Biome

- **Typecheck**: `node scripts/run-typecheck.mjs` — **0 diagnostics, exit 0**
  ([`receipts/12-typecheck.log`](receipts/12-typecheck.log)).
- **Census**: `node scripts/raptor3-refusal-census.mjs`, exit 0
  ([`receipts/10-refusal-census.md`](receipts/10-refusal-census.md)) — **identical
  to the same script's output on the CLEAN base tree**
  ([`receipts/10-census-base.md`](receipts/10-census-base.md)): invariant 22 / 21,
  internal 11 / 11, inherited refusals 75 / 75, candidate refusals 30 sites / 23
  distinct, rethrow 56, **194 total sites**. The two files differ only in the
  header and in `execution.ts` line anchors. No sentence is added, changed or
  removed: the representability premise raises the sentence
  `requireRepresentable` already owned, built by its one builder.
- **Biome**: per changed file, against the base copies
  ([`receipts/13-biome-after.log`](receipts/13-biome-after.log),
  [`receipts/14-biome-base.log`](receipts/14-biome-base.log)). The result is
  **identical**: 46 errors over the same rules, per file `execution.ts` 4,
  `selection.ts` 4, `world.ts` 37, and `batch-only-drivers.ts` clean. Formatting:
  `execution.ts` was format-clean at base and is format-clean now (it was
  formatted, which its base copy permits); both new files are formatted;
  `selection.ts` carries a `format` diagnostic in its BASE copy, so the formatter
  was NOT run on it and the lines this unit added to it are written the way
  Biome wants.

## 10. Cost

| perimeter | reference | after | delta |
| --- | --- | --- | --- |
| engine token lines (`scripts/query-engine-structure.mjs`) | 16,182 | **16,247** | **+65** |
| like-for-like | 20,040 | 20,105 (derived) | +65 |
| charged perimeter | 23,975 | 24,040 (derived) | +65 |

Both perimeter rows are DERIVED, not measured: every `src/` file this unit
touches is an engine file inside both perimeters, so the same +65 applies. The
base figure was re-measured on this worktree with the base copies restored.

`git diff --numstat` (tracked files):

```
17	0	docs/architecture/raptor3-evidence/g4/release/closure-repair/u1/note.md
38	0	src/query-engine/raptor3/AGENTS.md
130	15	src/query-engine/raptor3/commands/execution.ts
29	0	src/query-engine/raptor3/commands/selection.ts
34	2	tests/raptor3/g4/parity/batch-only-drivers.ts
13	1	tests/raptor3/transport/world.ts
```

plus two new test files (539 + 555 lines), this note and its receipts, and the
ledger record. No `src/` file outside the two engine files this lane owns is
touched; `scripts/`, `benchmarks/` and `vitest.workspace.ts` are untouched.

## 11. Unverified

- **The window between the unit's last premise and its first write is held only
  where the provider has a lock to take.** On PostgreSQL and MySQL the held
  premise closes it (measured). On SQLite the select assembly omits `FOR UPDATE`
  (`sqlite-adapter.ts`), so a change landing in that window is still visible to
  the consuming statement; what the fold guarantees THERE is that the value the
  statement spends is the intended row's own, so the holder can never point at
  another row — the two credential-free `plantBeforeFirstWrite` cells measure
  exactly that and nothing more. A row DELETED in that window on such a
  substrate would leave the sub-select reading NULL; no schedule in this tree
  reaches it, and closing it would need a lock the batch route does not take.
- **The credential-free file is not a concurrency suite.** SQLite carries one
  connection, so its drift is applied from the transport's own hook on the
  operation's own connection, at the two positions that name the windows. The
  concurrency claims are the native PostgreSQL file's.
- **The `held` premise's effect on lock contention is measured, not modelled.**
  It is stated only for a probe that FOUND a row and is addressed by that row's
  identity; `mysql2-concurrency-policy`'s 11 cells (the unique-key race,
  convergence, the deadlock policy) are green, and R2c's own file was not
  re-run — no missing-key probe's read changed.
- **Not measured here**: the performance cells, the bundle footprint, the full
  native MySQL and PostgreSQL inventories, and every other registered project.
  This unit ran only what discriminates; the frozen gate is the integrator's.
- **The two new files need a manifest entry from the integrator** only if the
  gate is to count them by name; both already run in their globbed projects.
  Reported at §7 rather than edited, per the lane rules.

## 12. Blockers

None.

## 13. Repair round (2026-09-22)

The independent review returned ONE finding on this unit, MINOR, and it is about
what the note SAID rather than what the unit does: **§6's closing sentence, "No
other route, verb or placement pays anything," was false.** No production file is
touched by this round — `src/**`, `tests/**` and the ledger are byte-identical to
the reviewed copy; the only edit is the paragraph below and the structured
report's `capability_change` field, which now carries the same words.

**What was wrong.** The sentence read the whole cost off the FOLD, which is the
parent-held placement's alone (`spentByHolder` is its only gate,
`commands/execution.ts:311`, `:335`). The second fact of this unit is not gated
there at all: the held premise is taken when `this.context.usesBatch &&
selection.retained` and asks for the lock when `selection.insertsWhenAbsent ===
true` (`commands/execution.ts:557-566`), and BOTH flags are set in the generic
verb handler with no `edge.kind` or `edge.owner` test —
`if (missing) lookup.insertsWhenAbsent = true` and
`if (verb === "connectOrCreate") lookup.retained = …`
(`commands/relation-body.ts:594-601`). So every `connectOrCreate` probe that
FOUND its row on the batch route now states its retained premise as a LOCKING
read, junction and child-held placements included — placements where this unit
folds nothing. The review measured it on this unit's own junction cell; no cell
in the tree can observe it, because SQLite's select assembly omits `FOR UPDATE`
(`src/adapters/databases/sqlite/sqlite-adapter.ts:702`, `forUpdate: "omit"`,
against `src/adapters/shared/select-assembly.ts:20`), which is where the
credential-free fixtures run, and the native cells of this unit do not schedule
a junction against a competing writer.

**What §6 says now** (the last paragraph of §6, and the report's
`capability_change`): *"The FOLD is the parent-held placement's alone. The HELD
premise is wider: every `connectOrCreate` probe that FOUND its row on the batch
route now states its retained premise as a locking read — junction and
child-held placements included, where nothing is folded — which no cell can
observe on SQLite, whose select assembly omits `FOR UPDATE`. Nothing else on any
route, verb or placement pays anything."* That is the scope the guide addendum
(`src/query-engine/raptor3/AGENTS.md`, "a HELD read wherever the probe read
unlocked") and the ledger record (`g4.md`, same sentence, plus the accepted
limit) already stated, so neither is edited: the integrator's three copies now
agree with each other and with the code.

**Runs, typecheck (repair round).** No test file is affected — the change is one
paragraph of a note, and no `src/**` or `tests/**` byte moved — so no cell was
re-run and nothing was re-registered. `node scripts/run-typecheck.mjs` once:
**0 diagnostics, exit 0**
([`receipts/15-typecheck-repair-round.log`](receipts/15-typecheck-repair-round.log)).
The census is not re-run for the same reason: no sentence, class or throw site
moved. Biome is not re-run: no source file changed.

**Unverified, this round.** The wider HELD scope stays unpinned by a cell, which
is why it is now STATED: on SQLite a `FOR UPDATE` cannot be observed at all, and
pinning it natively would mean a junction-placement lock schedule on the pg
forced batch profile — coverage this unit did not buy. §11's limits are
otherwise unchanged.

## 14. Commit message draft

```
fix(raptor3): on the batch route a located reference is read where it is spent, at the row this operation located

U1 closed the shared FOUND-consumption rule on the interactive route and
recorded the other half as open: `confirmFound` returns the probe's bytes
untouched when `ctx.usesBatch`, and for a PARENT-held `connectOrCreate` no
found command is built at all, so the holder's own statement spent a plan-time
literal. What that route states as premises is the located row's identity, its
membership and its matched condition — never the referenced COLUMN — so a key
recycled onto another row between the probe and the batch moved the connection
with it: measured on two real PostgreSQL connections through the repository's
forced batch profile, a holder connected to `b2` after `b1.code` became `M` and
`b2` acquired `G`.

The answer is the doctrine this engine already spells for a parent-held
`connect`, at the owner that already spells it. `CommandExecution.folded` gains
one arm: where the probe read UNLOCKED (`Selection.insertsWhenAbsent`) and the
route takes no confirmation, the value the HOLDER's own write spends is read
inside that statement (`Queries.locatedValue`) at the CAPTURED COMPLETE IDENTITY
(`Queries.includeIdentities` over the located row's key) and never at the arm's
public selector, which a replacement row may since have acquired. Only the
components the holder actually spends are folded — `Commands.assignMembership`'s
own contribution read back — so a junction's captured pair and a child-held
arm's value are untouched, and the interactive route is unchanged.

Two facts stand beside it. The selection's retained premise is now a HELD read
wherever the probe read unlocked (`Selection.captured`'s `held`, the mechanism
D-65 already decided for a captured member), so on a provider with a lock to
take the located row cannot be deleted, moved or nulled between that premise and
the statement that spends it — proved by a schedule, with a second connection's
UPDATE waiting on the lock while the unit writes. And because a folded value is
a sub-select, the representability requirement can only be asked of the capture,
so the same requirement is stated of the row the sub-select will read, as an
ABSENCE premise of the same unit, one per NULLABLE component and none at all
otherwise; an absence, so a row that has GONE still belongs to the presence
premise and each sentence stays true.

Witnesses: `tests/providers/docker/pg-batch-reference-reuse.test.ts` (6 cells on
two real connections: the recycled key, the compound pair, the lock-HELD
schedule, the disappearance, the NULL transition and the uncontended control)
and a credential-free counterpart on both local forced-batch fixtures
(11 cells × 2, with a between-statements hook added to `BatchOnlyDriver`:
root and nested placements, the sessionless transport, the selector-adoption
falsifier and the junction control). The `coc-found` consumer INSERT in the
scripted transport world is re-expressed by derivation — red at base, green here.
No sentence is added: the census is byte-identical to the clean base tree
(194 sites). Engine 16,182 → 16,247 token lines.

Repair prompt 2 §1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
