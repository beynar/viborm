# Nested-conformance family — gate triage note

Repository `/Users/arnaud/code/viborm`, branch `pattern-engine`, head `7bc08ebd9`
(plus the uncommitted decimal seam, not touched). Read-only: nothing under the
repository was edited. Family files (from
`scratchpad/triage/nested-conformance.files`):

- `tests/contracts/engine/query/nested-write-conformance-fk.test.ts`
- `tests/contracts/engine/query/nested-write-conformance-m2m.test.ts`
- `tests/contracts/engine/query/nested-write-conformance-membership.test.ts`
- `tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts`
- `tests/contracts/engine/query/nested-write-conformance-to-one.test.ts`
- `tests/contracts/engine/query/nested-write-conformance-transitive.test.ts`
- `tests/contracts/engine/query/nested-m2m-parent-pk-dataflow.test.ts`
- `tests/contracts/engine/query/m8-race-retry.test.ts`

Read first, per the brief: `docs/architecture/raptor3-evidence/g4/briefs/common.md`
(the twelve rules). `docs/architecture/raptor3-evidence/g4.md` (2,731 lines) was
grepped for every candidate ruling keyword found below (`D-25`, `D-46`,
`D-47`, "before-parent", "membership write", "disjoint", "Unique constraint
violation", "conflicting final assignments", "cross-scope", "shared
junction", "alternative branch", "predicate dependenc"); only `D-25` and
`D-46`/`D-47` returned hits, both quoted below.

## Method note — the RSS ceiling and how these files were actually run

`node scripts/run-vitest-safe.mjs --project extended-local <file>`, the exact
command the brief specifies, **structurally cannot run six of the eight
family files**: `run-vitest-safe.mjs`'s own `--rss-limit-mb` parser refuses
any value greater than `DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB` (1536 MiB —
`scripts/bounded-process.mjs:158-183`), and a single live PGlite instance
floors at a measured ~1.3 GiB on its own
(`tests/fixtures/drivers/pglite.ts:96-98`: "A PGlite instance is a whole
Postgres compiled to Wasm and costs a measured ~1.3 GiB... which is why the
credential-free estate ran as ~209 single-file processes"). All eight family
files reach `usePGliteSchemaFamily` (six directly, two — `to-one` and
`m8-race-retry` — through the shared fixtures module), so every one of them
pays that floor plus transform/collection overhead. Four files fit under
1536 MiB standalone (`m8-race-retry.test.ts`, `nested-m2m-parent-pk-dataflow.test.ts`,
and `to-one.test.ts` once `-t "is a no-op"` narrowed the run); five did not —
`nested-write-conformance-fk/m2m/membership/root-dependency/transitive.test.ts`
each measured 1552–1616 MiB just to **collect**, before any test ran, and
`-t` filtering does not help because Vitest collection evaluates every
`describe()` body (and therefore every `registerGroup`/`usePGliteSchemaFamily`
call) regardless of which tests a name pattern will later select.

`scripts/credential-free-test-manifest.mjs:255-268` documents exactly this
tension and the sanctioned fix: files that boot a live PGlite and share the
worker's one database run their own **"extended-local shared-family"**
stage (the same stage the brief's own finding says the gate never reached)
under the allowlisted `ISOLATED_PGLITE_PROVIDER_RSS_CEILING` (2560 MiB,
`scripts/bounded-process.mjs:43-45`), selected in code (not via the CLI,
which the ceiling module deliberately keeps capped at 1536 so "no caller can
type its way to one"). `scripts/run-credential-free-tests.mjs:189-199` is the
concrete stage. Rather than run the whole `pnpm test:all` aggregate (banned —
"no whole-project runs"), a small read-only launcher
(`/private/tmp/viborm-triage-nested-tmp/run-shared-family.mjs`, saved in this
family's own TMPDIR, not the repository) was written that imports the exact
same `startBoundedProcess` / `ISOLATED_PGLITE_PROVIDER_RSS_CEILING` /
`acquireTestRunLock` primitives `run-credential-free-tests.mjs` uses for that
stage, narrowed to one family file per invocation. It does not modify,
weaken, skip, or bypass anything in the repository, and it still goes through
`acquireTestRunLock`. All five large files then ran clean under the raised
ceiling (peaks 1537–1628 MiB, well inside 2560). Raw logs for every run are
under `/private/tmp/viborm-triage-nested-tmp/*.log` (`fk-full.log`,
`m2m-full.log`, `membership-full.log`, `root-dep-full.log`,
`transitive-full.log`, `to-one.log` + `to-one-noop.log`, `m8.log`,
`m2m-pk.log`).

`scratchpad/gate-inventory/*.log`, cited in the brief as tonight's measured
red-cell logs, does not exist anywhere in the repository or the scratchpad
(`find` from repo root and from the scratchpad root both came back empty) —
see Blockers.

## Table — one row per red cell (37 cells, 8 files, all red)

| file | cell | class | reason | ruling / registration / engine site |
|---|---|---|---|---|
| fk | createMany duplicate PK rolls back parent and prior children | C | both modes reject (agree, same error), but `batch.state` keeps the parent row and the first child row while `transaction.state` is empty — a batch-only-transport atomicity gap, not a wording gap | no registration; site: `src/query-engine/raptor3/shared/operation-context.ts:1038` (`flush`), called from `src/query-engine/raptor3/commands/execution.ts:397` |
| m2m | connectOrCreate string-selector array rejects unknown overlap | C | `expectReject: true` but `transaction.rejected` is `false` — the dependency detector misses this shape entirely, so the write executes | not in `refusals.json`/`refusal-census.txt`; site: `src/query-engine/raptor3/commands/commands.ts` dependency pass (`checkPair`/`readTarget`, ~L560-690) |
| m2m | overlapping set and deleteMany reject membership dependency | C | same signature (expectReject true, transaction.rejected false) | same site |
| m2m | disconnect then deleteMany rejects membership dependency | C | same signature | same site |
| m2m | multiple deleteMany filters reject internal dependency | C | same signature | same site |
| m2m | self m2m connect then inverse upsert rejects shared junction dependency | C | `batch.rejected` (true) ≠ `transaction.rejected` (false) — tx/batch parity break on a self-referential m2m | same dependency pass; self-referential edge binding likely double-counts or under-counts depending on transport |
| membership | nested create membership rejects a later cross-scope to-one upsert | C | error text is `"Unique constraint violation"` (`UniqueConstraintError`, `src/drivers/error-mapping.ts:244/306/529`), not the planned `NestedWriteError` "depends on an earlier 'create' membership write" — the plan-time detector missed it and the DB caught it instead | membership refusal at `commands.ts:574` never registered (see B/C discussion below); driver decode site `src/drivers/error-mapping.ts` |
| membership | connectOrCreate membership rejects a later cross-scope to-one upsert | C | same signature (`Unique constraint violation` vs "...'connectOrCreate' membership write") | same sites |
| membership | found connect membership rejects a later cross-scope to-one upsert | C | same signature (`Unique constraint violation` vs "...'connect' membership write") | same sites |
| membership | self to-one inverse upsert rejects a current-row FK membership move | C | `batch.rejected` ≠ `transaction.rejected` (mode-parity break) | dependency pass, self-referential-edge case |
| membership | non-self child-holds cascade keeps membership through a key transition | C | same mode-parity break, grouped with the above in the reporter's shared-diff output | same |
| membership | nested physical membership rejects a later same-edge root upsert | C | same mode-parity break, grouped with the above | same |
| membership | self to-many inverse update rejects the moved current row | C | `batch.error` is `NestedWriteAssertionError` code `V7006` ("a batch precondition... did not hold") where `transaction.error` is the typed `NestedWriteError` code `V7001` ("target record was not found for this parent") — an internal assertion leaking past the public floor in batch mode only | `src/query-engine/raptor3/commands/execution.ts:180-206` `recover()` / `recoveryRejection` (see m8 below — same defect family) |
| membership | nested to-many child update carries its selector into inverse membership | C | received `"Nested operation 'upsert' on relation 'partnerOf' depends on an earlier 'update' **target** write..."`, expected the **membership**-write wording — the target-write check (`commands.ts:676`/`program.ts:397`) fires ahead of the membership check (`commands.ts:608`), which never gets a chance to run | `commands.ts:676` (target) pre-empts `commands.ts:608` (membership) |
| membership | non-self nested FK rebind rejects a later inverse read of the same holder | C | same target-vs-membership wording swap, grouped with the two below | `commands.ts:676` vs `:608` |
| membership | nested scalar FK rebind rejects a later inverse read of the same holder | C | same signature, same group | `commands.ts:676` vs `:608` |
| membership | nested scalar FK rebind rejects a later inverse upsert of the same holder | C | same signature, same group | `commands.ts:676` vs `:608` |
| membership | nested physical membership rejects a later same-edge root update | C | received `"Cannot update relation 'friends': target record was not found for this parent."` (the `relation-body.ts:238` lax lookup refusal), expected `"depends on an earlier 'connect' membership write"` — a third refusal family pre-empting the membership one | `relation-body.ts:218-240` vs `commands.ts:574` |
| membership | nested identity transition exports the exact final membership source | C | `expectReject: false` but `transaction.rejected` is `true` (both modes agree — over-rejection, not a parity break) | dependency pass, false positive |
| root-dependency | before-parent self connect is unaffected by the future insert | C | received the **target**-write dependency refusal (`"...depends on an earlier 'create' target write..."`), expected the lax `"target record was not found"` — both modes reject, wrong refusal fires | `commands.ts:676`/`program.ts:397` vs `relation-body.ts:238` |
| root-dependency | nested create keeps its before-parent decision ahead of its insert | C | received `"query-engine-v2 create has conflicting final assignments for column 'parentId' on relation 'parent'."` — this string is raptor3's OWN code (`commands.ts:456`, `assignMembership`), the "query-engine-v2" text is an inherited cosmetic label, not a reach into retired code (ruled out as Class D — see below); expected `"target record was not found"` | `commands.ts:456` |
| root-dependency | root id transition allows a disjoint numeric self decision | C | `transaction.rejected` is `true`, `expectReject` is `false` (both modes agree — over-rejection), grouped with the three below in the reporter | dependency pass, false positive |
| root-dependency | nested payload update does not taint a sibling target decision | C | same group, over-rejection | same |
| root-dependency | nested to-many update allows a disjoint child decision | C | same group, over-rejection | same |
| root-dependency | existing top-level upsert uses its exact pk for disjointness | C | same group, over-rejection | same |
| to-one | to-one disconnect true (FK-holder side) with nothing connected is a no-op | C | both modes now **reject** `disconnect: true` with nothing connected; DESIGN §5.3 requires `requireAffected: false` (lax, silent no-op) for `disconnect: true`/`delete: true` | `src/query-engine/raptor3/commands/relation-body.ts:218-240` — the `required` error factory is passed unconditionally for both `payload === true` and an explicit selector, never differentiated |
| to-one | to-one disconnect true (inverse side) with no related row is a no-op | C | same defect, inverse-side edge | same site |
| to-one | to-one delete true (inverse side) with no related row is a no-op (DESIGN §5.3; Prisma would throw P2025) | C | same defect; the test's own name cites the normative section | same site |
| transitive | create-family sibling create then connect observes the earlier insert | C | `transaction.rejected` true, `expectReject` false (over-rejection), grouped with the two below | dependency pass, false positive |
| transitive | nested predicate update allows a later identity-only root filter | C | same group, over-rejection | same |
| transitive | upsert update alternative predicate delta ignores an id-only filter | C | same group, over-rejection | same |
| transitive | outer create then nested connectOrCreate rejects | C | received `"Unique constraint violation"`, expected `"...depends on an earlier 'create' target write..."` — plan-time miss, DB catches it instead | `commands.ts` dependency pass vs `src/drivers/error-mapping.ts` |
| transitive | a connectOrCreate create alternative inherits earlier sibling writes | C | `transaction.rejected` false, `expectReject` true (under-rejection — the missing-refusal direction), grouped with the row below | dependency pass, missed detection |
| transitive | upsert array keeps the found branch membership on its selector | C | same group, under-rejection | same |
| nested-m2m-parent-pk-dataflow | deleteMany retries when a member is added to a nonempty planned set | C | the typed, `meta.raceable = true` `NestedWriteError` ("a member was added after the plan-time read; retry to converge") surfaces to the caller instead of triggering the documented one-shot re-plan | `recover()` at `execution.ts:180-206` has no dispatch branch for a membership `requireAbsent` rejection — only `{kind:"insert"}` and `{kind:"assertion"}` + a `conditionalSkips` hit recover; `recoveryRejection` (`operation-context.ts:1338-1359`) never returns anything a membership guard's rejection would match |
| nested-m2m-parent-pk-dataflow | deleteMany retries without deleting a member removed after planning | C | the opposite gap: when a member is removed from the junction after the plan-time read, `requireNoAddedMember` only guards **additions** (`NOT (OR ...captured keys)`), so the stale-but-now-absent member is deleted anyway instead of being left alone | `execution.ts:715-745` `requireNoAddedMember` |
| m8-race-retry | an un-attributable planned abort surfaces the typed non-raceable floor, not retried | C | same defect family as membership's "self to-many inverse update" row: a bare `NestedWriteAssertionError` reaches the caller where the test's own comment pins a typed `NestedWriteError` code `V7006` floor ("Step-4 floor... never a bare `NestedWriteAssertionError` leaking") | `execution.ts:180-206` `recover()` / `recoveryRejection` |

## Class A — physical-plan pins

**None found.** No cell in this family pins SQL text, statement count, CTE
fold shape, batch segmentation, or an alias with the same observable result
under both engines. `docs/architecture/raptor3-evidence/g4.md` was grepped
for every candidate keyword these scenarios raised (see header) with no
rulings surfacing that describe a deliberate physical-plan change for any of
these 37 shapes.

## Class B — registered refusal replaces retired behavior

**None ruled; one registration exists but does not cover these shapes.**
`refusals.json`/`refusal-census.txt` (root-review-C-receipts) register exactly
one of the four sibling "depends on an earlier ... write" refusal
constructors: the **target**-write flavor at `program.ts:397`
(class `NestedWriteError`, `inherited`, needle `"' target write in the same
nested write. Split these operations into separate queries."`). The other
three constructors that build the same family of `NestedWriteError` —
`commands.ts:574` and `:608` (membership-write flavor) and the `relation-
body.ts:238` "target record was not found for this parent" refusal — are
**not** in the census at all. Reading them shows why: the census's
`extract-throws.mjs` matches literal `throw new X(...)` sites
(`throw-sites.json` has 156 entries, none at these three lines); these three
instead build `owner.refusal ??= new NestedWriteError(...)` and are thrown
later, indirectly, from `execution.ts:276`/`:422` (`if (occurrence.refusal)
throw occurrence.refusal`). The census's methodology has a real blind spot
here — three of the four dependency-refusal constructors, plus the
`requireNoAddedMember` membership-race refusal at `execution.ts:740`
(also built as `const failure = new NestedWriteError(...)` and thrown via
`ctx.requireAbsent`), are absent from the registration set even though they
are genuine, deliberate raptor3 behavior.

Even where the one registered refusal (`program.ts:397`) is the one that
actually fires (root-dependency's "before-parent self connect", transitive's
"outer create then nested connectOrCreate"), no cell in this family is
classified B: in every such case the retired engine's expected behavior
(per the test's own pin) was **also** a refusal — a different one (the lax
"target record was not found", or the register never reached because a raw
DB `Unique constraint violation` won the race) — so this isn't "the shipped
engine refuses where the retired engine executed," it's the shipped engine
choosing the wrong one of several registered-and-unregistered refusal
families for the shape. That is a detection-logic defect (Class C), not a
new, deliberate refusal substituting for prior execution.

One specific near-miss for D, ruled out: root-dependency's "nested create
keeps its before-parent decision ahead of its insert" cell receives the
message `"query-engine-v2 create has conflicting final assignments for
column 'parentId' on relation 'parent'."`. The string literally names
`query-engine-v2`, but `commands.ts:456` (`assignMembership`) shows this is
raptor3's own, currently-live code — the label is an inherited/copy-pasted
piece of message text, not a call into retired-engine internals. It is filed
above as Class C, not D.

D-25 (membership race-retry, "the one-recovery allowance uses the shipped
gate... a recovery re-plans from the ADMITTED values... so a series
occurrence is never expanded twice") and D-46/D-47 (upsert on the array
route of a batch-only transport) are both real, named, ACCEPTED rulings —
quoted in full below — but neither one covers the specific gap this family
measured: D-25 rules on the *shape* of the one allowed recovery, not on
whether `recover()` actually dispatches a membership-set rejection into it
at all (it does not — see the table); D-46/D-47 is scoped to `rootUpsert`'s
array route specifically, not to `createMany` duplicate-PK rollback
atomicity (the fk.test.ts cell) or to any of the dependency/membership
refusal-family cells.

## Class C — defect in the shipped engine

All 37 cells above are filed C. They cluster into six distinct, independently
reproducible defects, each with no ruling found covering it:

**1. Dependency-refusal family confusion (16 cells: m2m ×5, membership ×9,
root-dependency ×2, transitive ×2 — some cells double-count across sibling
groups printed together by the reporter).** Four different refusal
mechanisms compete for overlapping nested-write shapes — the target-write
`NestedWriteError` (`program.ts:397`, `commands.ts:676`), the membership-
write `NestedWriteError` (`commands.ts:574`, `:608`), the lax "target record
was not found" `NestedWriteError` (`relation-body.ts:238`), and — when the
plan-time detector misses the shape entirely — a raw `UniqueConstraintError`
("Unique constraint violation", `src/drivers/error-mapping.ts:244/306/529`)
surfacing from the database with no `NestedWriteError` wrapper at all.
Smallest reproduction: `nested-write-conformance-membership.test.ts`, the
"nested create membership rejects a later cross-scope to-one upsert" group
— a to-one `create` inside a nested write followed by a cross-scope
`upsert` that should be caught at plan time by the membership check
(`commands.ts:574`) but instead reaches PGlite and is caught by its own
unique index. Suspected owner: the dependency-pass ordering in
`src/query-engine/raptor3/commands/commands.ts` (`checkPair`/`readTarget`,
roughly lines 560-690) — the target-write check appears to run (and win)
ahead of the membership-write check for shapes that should hit membership
first, and neither check reliably fires before some DB-enforced-unique
shapes reach execution at all.

**2. Symmetric over/under-rejection on `tx` (and, since `batch.rejected ===
transaction.rejected` holds in these cells, on `batch` too) (9 cells:
membership ×1, root-dependency ×4, transitive ×5).** Both substrates agree
with each other but disagree with the test's `expectReject` pin — six cells
reject where the design says a "disjoint"/"unaffected"/"allows" decision
should proceed, three reject where an "inherits"/"keeps... membership" case
should also proceed, and two under-reject where a dependency (`connectOrCreate
create alternative`, `upsert array... found branch`) should be caught.
Smallest reproduction: `nested-write-conformance-root-dependency.test.ts`,
"root id transition allows a disjoint numeric self decision" — same suspected
owner (the `commands.ts` dependency pass), since these are the same
detector producing false positives and false negatives on either side of the
same disjointness test it runs for the class-1 cells.

**3. `tx`/`batch` mode-parity breaks (5 cells: m2m ×1, membership ×4).**
`batch.rejected !== transaction.rejected` on self-referential and cascading
membership shapes. Smallest reproduction:
`nested-write-conformance-m2m.test.ts`, "self m2m connect then inverse
upsert rejects shared junction dependency." Suspected owner: same dependency
pass, self-referential-edge binding (`membership(variant?)` in
`relation-body.ts` binds edges per-variant and may resolve the self-edge
differently depending on which transport's plan shape it observes).

**4. `NestedWriteAssertionError` (internal, code `V7006`) leaking past the
typed public floor (2 cells: membership ×1, m8-race-retry ×1).** m8's own
test comment names this exactly: "Step-4 floor: a typed `NestedWriteError`
with the assertion code... silent success, never a bare
`NestedWriteAssertionError` leaking." `execution.ts:180-206` (`recover()`)
only recognizes `recoveryRejection` outcomes of kind `"insert"` (a lost
unique-constraint race on a missing choice) or `"assertion"` **combined
with** a `conditionalSkips` hit (the Pin Rule's conditional-upsert-skip
case, §5.5 item 2 of `docs/architecture/engine-unification/DESIGN.md`).
Neither branch matches the un-attributable planned-abort shape these two
cells exercise, so `recover()` returns `false` and the raw internal
assertion error propagates. Smallest reproduction:
`tests/contracts/engine/query/m8-race-retry.test.ts` — "an un-attributable
planned abort surfaces the typed non-raceable floor, not retried." Suspected
owner: `execution.ts:180-206` `recover()`, and/or `recoveryRejection` at
`operation-context.ts:1338-1359`, which has no `"membership"`/raceable-guard
kind at all.

**5. The membership race-retry recovery never actually recovers (2 cells,
nested-m2m-parent-pk-dataflow).** Same root cause as defect 4, isolated
further: `requireNoAddedMember` (`execution.ts:715-745`) builds a `const
failure = new NestedWriteError(...)` with `failure.meta.raceable = true` and
submits it through `ctx.requireAbsent`, exactly matching AGENTS.md's own
description of the mechanism ("...a member committed between the plan-time
read and the atomic unit ABORTS that unit instead of being silently missed
... the one recovery above then re-plans against the larger set and
converges" — `src/query-engine/raptor3/AGENTS.md:1054-1057`, and D-25,
quoted below). But `recover()` has no dispatch path that matches this
rejection (see defect 4), so the typed, explicitly-raceable error reaches
the caller instead of converging silently, contradicting both the guide text
and the accepted D-25 ruling's own framing of "the one recovery." The
sibling cell ("deleteMany retries without deleting a member removed after
planning") is a distinct, second gap in the same mechanism: `requireNoAddedMember`
only asserts against **additions** to the captured set (`NOT (OR
...captured keys)`); nothing re-verifies that a captured member is **still**
connected, so a membership row deleted directly (outside the plan) between
read and execution is deleted anyway instead of being excluded. Smallest
reproduction: `tests/contracts/engine/query/nested-m2m-parent-pk-dataflow.test.ts`,
both "deleteMany retries..." tests using `StaleMembershipBatchDriver`.

**6. `disconnect: true` / `delete: true` on a to-one edge no longer honors
DESIGN §5.3's lax contract (3 cells, to-one).** `relation-body.ts:218-240`
(the `case "disconnect": case "delete":` block) constructs the same
`required`-error-factory lookup — `() => new NestedWriteError("Cannot
${verb} relation '${edge.name}': target record was not found for this
parent.", edge.name)` — for both `payload === true` (which
`docs/architecture/engine-unification/DESIGN.md:770-776`, §5.3, pins as
`requireAffected: false`, i.e. a silent no-op) and an explicit `{where}`
selector (which the same table pins as `GuardFailure(kind: correlated)`,
i.e. strict). Nothing in the block branches on `payload === true`. Smallest
reproduction: `tests/contracts/engine/query/nested-write-conformance-to-one.test.ts`,
"to-one disconnect true (FK-holder side) with nothing connected is a no-op"
— `client.post.update({ where: {id: "po1"}, data: { author: { disconnect:
true } } })` against a `post` row whose `userId` is already `null`; expected
a silent no-op (`post` unchanged), both `transaction` and `batch` modes
instead reject with the "not found" message. One of the three cells' own
test name cites the normative section directly: "to-one delete true
(inverse side) with no related row is a no-op (DESIGN §5.3; Prisma would
throw P2025)."

**Rulings quoted (found, read, and confirmed not to cover any of the above):**

> **D-25** (U6.5): the one-recovery allowance uses the shipped gate —
> refused only after COMMITTED record-series progress (`routing.ts:197`
> `hasCommittedRecordSeriesProgress`), superseding the guide's narrower
> "or dynamic member admission"; a recovery re-plans from the ADMITTED
> values (a fresh occurrence tree, no re-validation, no transforms — rule
> 10), so a series occurrence is never expanded twice.
> — `docs/architecture/raptor3-evidence/g4.md:1864-1869`

> **D-25 as shipped:** the committed-progress gate applies to the arm that
> RE-PLANS (the raceable assertion); the arm that REPLAYS keeps
> `memberAdmissionStarted`, because the literal reading reddens a registered
> raptor3 pin and degrades a public error to a raw `Error`. Accepted by the
> integrator as the rule-compliant reading; Arnaud may overturn.
> — `docs/architecture/raptor3-evidence/g4.md:1967-1971`

> **D-46** (integrator, 18:35) — an upsert on the array route of a
> batch-only transport... `CommandPlanner.rootUpsert`, for the array route
> only, restates the shipped engine's two upsert paths at one owner...
> — `docs/architecture/raptor3-evidence/g4.md:2504-2523`, commit `710e882f2`

Neither ruling names `createMany`, dependency-refusal wording, mode parity,
or to-one `disconnect`/`delete` laxness; both are scoped to the membership
race-retry mechanism and the upsert array route respectively, which the
table above shows are necessary but not sufficient to explain these 37
cells.

## Class D — the test's premise is gone

**None found.** No cell in this family reaches `write-engine`,
`query-engine-v2` internals, a retired-engine instrumentation attribute, or a
runner-only replay/specimen environment. The one cell whose message text
contains the literal string "query-engine-v2" (root-dependency, "nested
create keeps its before-parent decision ahead of its insert") was traced to
`commands.ts:456`, confirmed to be raptor3's own live code with an inherited
cosmetic label in the message string, not a reach into retired code — filed
as Class C (see above), not D.

## Unverified

- The precise mechanism behind defect cluster 1 (which of the four refusal
  paths "wins" for a given shape) was not traced statement-by-statement
  through `commands.ts`'s dependency pass for all 16 cells — the pattern
  (four competing refusal families, no stable ordering rule) is established
  from the failure messages and the source reachable from each, but a full
  call-graph trace per cell was out of scope for triage speed ("the minimum
  that discriminates").
- Cluster 2's false-positive/false-negative split (which specific predicate
  in the disjointness check misfires for each of the 9 cells) was not
  individually traced; only the shared symptom (agreement between `tx` and
  `batch`, disagreement with `expectReject`) and the shared suspected owner
  are established.
- `scratchpad/gate-inventory/*.log`, the brief's cited source for "184 red
  cells in 41 files," could not be located (see Blockers) — this note's cell
  count (37) and classes are independently measured from live runs, not
  cross-checked against that inventory.
- Whether any OTHER triage family's files share defect clusters 1-6 (the
  dependency-refusal-family confusion and the `recover()` gap look like they
  would also reach FK-relation and non-nested-write suites) was not checked;
  out of this family's scope.

## Blockers

- `scripts/run-vitest-safe.mjs --project extended-local <file>` — the exact
  command the brief specifies — fails on 5 of 8 family files with "Vitest
  exceeded its 1536 MiB sampled process-group RSS ceiling," a hard, allow-
  listed cap the script itself refuses to raise past. This is a structural
  property of these files (documented in
  `scripts/credential-free-test-manifest.mjs:255-268`), not a flake — two
  consecutive attempts on the same file (`nested-write-conformance-fk.test.ts`)
  both failed within 25 MiB of each other. Worked around, read-only, using
  the same bounded-process library the sanctioned "extended-local
  shared-family" stage uses (see Method note); flagging in case another
  family hits the same wall without noticing the manifest already names the
  fix.
- `scratchpad/gate-inventory/*.log` (the brief's cited receipts for the "184
  red cells in 41 files" claim) does not exist under the repository root or
  under either scratchpad directory this session can see. Not a blocker for
  this note's own findings (all 37 cells here were independently reproduced
  live), but it means this note's numbers cannot be cross-checked against
  whatever produced that count.

## Summary

- **Class A:** 0
- **Class B:** 0 (one relevant registration exists — `program.ts:397` — but
  no cell qualifies; see Class B discussion)
- **Class C:** 37
- **Class D:** 0

**Three most consequential findings:**

1. Four different, mostly-unregistered "nested write depends on an earlier
   write" refusal mechanisms (`program.ts:397`, `commands.ts:574`, `:608`,
   `:676`, `relation-body.ts:238`) compete without a stable ordering rule,
   so 16+ cells get the wrong refusal family, no refusal at all (falling
   through to a raw DB unique-constraint error), or a refusal where none
   should fire — this is the majority of this family's reds and looks like
   it would also affect FK-relation conformance outside this family.
2. `disconnect: true` / `delete: true` on a to-one edge has silently gone
   from DESIGN §5.3's lax no-op to a hard reject in both transaction and
   batch modes (`relation-body.ts:218-240` never branches on `payload ===
   true` vs an explicit selector) — a clear, narrow, single-site defect.
3. The membership race-retry mechanism the guide and D-25 describe
   ("the one recovery... converges") never actually recovers anything:
   `recover()` (`execution.ts:180-206`) has no dispatch path for a
   membership `requireAbsent` rejection, so the typed, explicitly-raceable
   `NestedWriteError` always reaches the caller instead of retrying —
   the same gap also explains the `NestedWriteAssertionError`-leak cells in
   `m8-race-retry.test.ts` and `nested-write-conformance-membership.test.ts`.

Note path: `/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/triage/nested-conformance.md`
