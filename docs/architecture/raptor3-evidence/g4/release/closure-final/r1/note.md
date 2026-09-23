# R1 — the shared reference requirement, asked where the tuple becomes the row

The decided handoff §3, closed at one owner. FC-02C moved the located-NULL
refusal out of the one arm Raptor 3 had narrowed it to and RECORDED two
placements its owner could not reach; this unit is the requirement those two
placements share with the one FC-02C repaired, stated once, at the boundary
that holds the actual value of every component.

Branch `closure-r13` from `cdd787ac8`, worktree `/private/tmp/viborm-r13`.
Nothing committed, staged, checked out or pushed; no existing file formatted
(the two new test files were formatted, as the rules allow).

## The failing witness

FC-02C's retained residual probe
(`closure/fc02c/receipts/residual-probe.test.ts.txt`, `residual-probe.log`),
executed on the repaired tree and recorded as unrepaired:

1. **The CREATE arm.** `holder.update({ where: { id: "h1" }, data: { name:
   "renamed", badge: { connectOrCreate: { where: { slug: "fresh" }, create: {
   id: "b9", slug: "fresh", code: null } } } } })` on a parent-held edge onto a
   NULLABLE unique — `b9` is created, `h1.badgeCode` becomes NULL, and the
   holder the payload asked to CONNECT is disconnected from `b2`.
2. **The CHILD-held direction.** `badge.update({ where: { id: "b1" }, data: {
   holders: { connect: { id: "h1" } } } })` with `b1.code` NULL — `h1.badgeCode`
   becomes NULL: `h1` is not made a member of `b1`, it is disconnected from
   `b2`, and the parent's sibling scalar is written beside it.

**At the base (`cdd787ac8`):** both resolve. Also red at the base, from the
same fact: a child-held nested `create` under a NULL-referenced parent, a
compound reference with one member NULL in either direction, the same CREATE
arm at a NESTED placement, and the segmented transports' progress cell.
Receipt: `receipts/base-red-reference-representability.log` — **24 of 52 red,
exit 1**.

**After:** `NestedWriteError: Cannot connect relation '<relation>': the located
target's referenced field '<field>' is null.` in every one of them, with the
holder unchanged, the sibling scalar unwritten and the create arm's row absent.
Receipt: `receipts/after-green-reference-representability.log` — **52 / 52,
exit 0**.

## The fact, and who owns it

**The fact.** *A concrete tuple that becomes an explicit relation must be able
to REPRESENT it: every component that represents the connection is present and
non-NULL.* A nullable referenced unique can read NULL on the row a probe FOUND,
on a row this operation itself PRODUCED, and on the PARENT whose own value a
member's statement spends. Writing that NULL does not connect the relation — it
disconnects the holder — and no provider reports it, because NULL in a nullable
foreign key is a legal absence.

**Its owner — the record that stores the tuple, not the choice that supplied
it.** FC-02C's placement (`CommandExecution.suppliedValues`) asks what a CHOICE
supplies out of a located row. That is one supplier of three. The other two are
a row this operation created (the create arm's own INSERT) and the parent's own
current value; neither is a choice's supply, and FC-02C's note names both as
unreachable from that owner. All three meet at one boundary: the values a
record's statement STORES. So the requirement is asked there —
`CommandExecution.stored`, wrapping the `attempt.values(command.fields)` the
record case already computed — where every component's ACTUAL value is known,
whatever supplied it (`CommandAttempt.read`, FC-02A's one reader of a row's
current values; a value this unit produced into its batch scratch once D-58's
boundary has carried it back, and not before). Nothing is admitted, defaulted
or transformed a second time to obtain one.

**Which components.** Not every field the row demands — the handoff forbids
that, and it is also what made the old check ask a junction about row keys no
schema can make nullable. The components are the RESOLVED EDGE's, and
`Commands.assignMembership` is that edge's one reader: it already loops
`edge.pairs` computing the owner-side field and the referenced field, so it now
says what the value it contributes has to represent (`FieldValue.relation`).
That marker replaces `FieldValue.membership`, a `MembershipContribution` the
code SET on every contribution and never read — so the requirement's marker
costs no new state, and an explicit `disconnect`'s own NULL stays legal by
construction: it is a literal this row asked for, contributed by
`relation-body.ts` directly and carrying no relation.

## The hunk

Four files, all named in this unit's brief.

- **`commands/assignments.ts`** — `FieldValue.membership?: MembershipContribution`
  (written, never read) becomes `FieldValue.relation?: string`;
  `Assignments.contribute` loses its dead fourth parameter.
- **`commands/commands.ts`** — `Commands.assignMembership` loses its now-dead
  `contribution` parameter (it only ever fed that dead field; `publishMembership`
  takes its own, unchanged) and attaches `relation: edge.name` to the value it
  contributes. `assignMembership` drops from five parameters to four, which is
  why the estate's five-parameter-function count falls 36 → 35.
- **`commands/relation-body.ts`** — the four call sites drop the argument. The
  two `disconnect` sites keep their `contribution` for `publishMembership`.
- **`commands/execution.ts`** — `requireRepresentable` (the one sentence, the
  one `throw`); `stored` (the record's consumer); `suppliedValues` becomes
  `folded` again, with the requirement's broad loop DELETED and the fold's own
  gate unchanged and hoisted to the top.

The record case composes its write values once (`const values =
this.stored(command.fields)`) instead of calling `attempt.values` separately in
each branch.

### Why the requirement is stated from exactly two places

A parent-held `connect` FOLDS its target's value into the holder's own SET: by
the time the record's `stored` sees that component it is a scalar sub-select
(`Queries.locatedValue`), not a literal, so the record CANNOT ask about it. The
literal the probe read exists in `folded` and nowhere after it. The two call
sites are therefore one requirement with disjoint, nameable coverage, and each
was falsified on its own:

| dropped call | red | receipt |
| --- | --- | --- |
| the record's (`stored`) | **32** — every cell but the plain `connect`, the controls and the junction | `receipts/falsify-stored.log` |
| the fold's (`folded`) | **4** — exactly `keeps the plain connect's own sentence and its written state` | `receipts/falsify-folded.log` |

No cell is red in both. That is the unique coverage each site owes.

## The actual deletion

- `FieldValue.membership` and its `MembershipContribution` payload on every
  contribution: state the engine wrote and no reader ever consumed.
- `Assignments.contribute`'s fourth parameter and
  `Commands.assignMembership`'s `contribution` parameter, with their four call
  sites' arguments.
- `suppliedValues`' loop over `command.fields.demands` asking every demanded
  field of every choice supply, and its unconditional `if (!origin) return`.

Engine token-bearing LOC: **16,040 → 16,040 (+0)**. The deletions pay for the
requirement and its consumer exactly.

## The second consumer / second placement

The requirement is stated once and serves placements the repair did not have to
name individually, because they are the same bind. Measured on the repaired
tree (`receipts/residual-probe.log`, `receipts/residual-probe.test.ts.txt`):

| placement | before | after |
| --- | --- | --- |
| parent-held plain `connect` (folded) | refuses | refuses, same sentence, same state (the fold's own call) |
| parent-held `connectOrCreate`, FOUND arm | refuses (FC-02C) | refuses — now the RECORD's, not the choice's |
| parent-held `connectOrCreate`, CREATE arm | **writes NULL, disconnects** | refuses (**witness 1**) |
| child-held `connect` | **writes NULL, disconnects** | refuses (**witness 2**) |
| child-held `create` / `createMany` | **creates a non-member** | refuses |
| child-held `connectOrCreate`, both arms | **writes NULL** | refuses |
| child-held `set` | **writes NULL** | refuses |
| COMPOUND edge, one member NULL, either direction | **writes NULL** | refuses, naming the unrepresentable member |
| junction choice (`through`) | connects | connects — its captured pair is not a record contribution, and its endpoints are row keys no schema can make nullable |
| explicit `disconnect`, either direction | writes NULL | writes NULL — a literal this row asked for |
| root `create` whose own data cannot supply the referenced field | refuses (`Commands.assignMembership`, plan time) | unchanged, same sentence and class (pinned as a control) |
| nested `update` arm nulling the referenced column under a live member | `ForeignKeyError` | unchanged (FC-02C's R3, deliberately not extended) |

## Capability change

None gained, none lost. No public sentence added, removed or reworded: the
census is identical to `cdd787ac8` (below). Silent data-loss defects removed:
every placement above that "writes NULL, disconnects" now refuses by name. No
valid case acquires a blanket refusal — the pin's controls prove a nullable
referenced unique is still a legal schema, a row holding NULL in one is still
updatable, a holder is still creatable with a NULL foreign key, an explicit
disconnect is still legal in both directions, and both verbs still connect a
representable target in both directions.

## Registrations owed (the manifest was NOT edited)

`scripts/raptor3-manifest.mjs`, `G4_PARITY_COUNTS`:

```
"tests/raptor3/g4/parity/reference-representability.test.ts": 26,
```

(12 → 26: 6 cells × 2 routes = 12 existing, +6 cells × 2 routes = 12 new, +2
segmented-transport cells.) The two native files are gated by their env var
like their `tests/providers/docker/` siblings and are not manifest rows.

## Runs

One vitest at a time, in this worktree, with `TMPDIR=/private/tmp/viborm-r13-tmp`.
No wide run, no fixed lane.

| file | result | receipt |
| --- | --- | --- |
| `tests/raptor3/g4/parity/reference-representability.test.ts` (26 cells × 2 projects) | **52 / 52** | `receipts/after-green-reference-representability.log` |
| … the same file at the base engine | **24 failed / 28 passed**, exit 1 | `receipts/base-red-reference-representability.log` |
| `tests/providers/docker/pg-reference-representability.test.ts` (native, new) | 5 / 5 | `receipts/native-pg-reference-representability.log` |
| `tests/providers/docker/mysql2-reference-representability.test.ts` (native, new) | 5 / 5 | `receipts/native-mysql2-reference-representability.log` |
| `tests/contracts/engine/write/parent-held-lookup.test.ts` (the sentence's existing pin, live PGlite) | 56 / 56 | `receipts/parent-held-lookup.log` |
| `correlated-membership` + `suppressed-membership-target` | 24 / 24 | `receipts/membership-pins-1.log` |
| `published-key` + `lane-x-set-mutations` | 34 / 34 | `receipts/membership-pins-2.log` |
| `member-boundary-packaging` + `fresh-member-placement` | 42 / 42 | `receipts/membership-pins-3.log` |
| `exclusive-member-cardinality` + `singular-slot-transition` | 48 / 48 | `receipts/membership-pins-4.log` |
| `nested-write-conformance-to-one` (live PGlite) | 19 / 19 | `receipts/nested-write-conformance-to-one.log` |
| `nested-write-conformance-fk` (live PGlite) | 28 / 28 | `receipts/nested-write-conformance-fk.log` |
| `nested-write-conformance-membership` (live PGlite) | 30 / 30 | `receipts/nested-write-conformance-membership.log` |
| `cs02-structure-measure` (one call site updated) | **1 red, before and after alike** | `receipts/cs02-structure-measure.log`, `receipts/cs02-structure-measure-base.log` |

The live-PGlite files ran through `scratchpad/run-shared-family-cwd.mjs` (the
sanctioned raised ceiling); the natives through
`run-vitest-safe.mjs --project=provider-pg|provider-mysql2`, one file per
invocation; all others through `node scripts/run-vitest-safe.mjs run <file…>`.

`cs02-structure-measure`'s matrix cell is the **pre-existing** registration
defect this ledger already records ("red at `0cc61e61` and at its own landing
commit; it needs the instrumentation patch"). It was re-measured with every
production file restored from its base backup and the base copy of the test:
the same cell, the same missing root occurrence/write/activation
(`receipts/cs02-structure-measure-base.log`). The one line this unit changed in
that file is the `assignMembership` call site's dropped argument, in a
different scenario (`width-overlap`) from the failing one (`depth-create/1`).

### Falsification (in backup copies, restored by `cp`)

Every production file was copied to `$TMPDIR/backup` before the hunk and
restored by `cp`, never by `git checkout`. Three falsifications are recorded:
the base engine under the final pin file (24 red), and each call site dropped
on its own (32 red / 4 red), as the table above states.

## Typecheck, census, Biome, LOC

- **Typecheck:** `node scripts/run-typecheck.mjs` → **0 diagnostics**, exit 0
  (`receipts/typecheck.log`).
- **Census:** `node scripts/raptor3-refusal-census.mjs` on the working tree and
  `--at cdd787ac8` are **identical**: 23 candidate sentences (30 sites) / 75
  inherited (75 sites) / 21 invariant (22 sites) / 11 internal / **193 total
  sites** (`receipts/census-after.md`, `receipts/census-base.md`). The only
  textual difference is line numbers and the two interpolation variable names
  inside the one sentence this unit moved, which the census matches on the same
  static fragments.
- **Biome:** `execution.ts`, `commands.ts`, `assignments.ts` and
  `relation-body.ts` report the **same diagnostics** base and after, one for one
  (`receipts/biome.txt`); `relation-body.ts`'s single `noUnusedVariables` is the
  same pre-existing `conditionalTarget` at both. The two new test files are
  clean and were formatted with `biome format --write` (new files, as the rules
  allow). `cs02-structure-measure.test.ts` carries a `format` diagnostic at its
  base copy and was **not** formatted.
- **LOC** (`node scripts/query-engine-structure.mjs`, whole query-engine
  perimeter, `receipts/structure-base.json` / `structure-after.json`):
  token-bearing lines **16,040 → 16,040 (+0)**; physical 20,446 → 20,482 (+36,
  all docblock); functions 1,093 → 1,095 (+2: the requirement and its
  consumer); five-parameter functions **36 → 35**.
  Non-engine, `git diff --numstat`: `reference-representability.test.ts`
  +330 / −2, `cs02-structure-measure.test.ts` +1 / −1,
  `raptor3/AGENTS.md` +39 / −0, `g4.md` +58 / −0; new files
  `pg-reference-representability.test.ts` 260 lines and
  `mysql2-reference-representability.test.ts` 255 lines.

## The native lane, and what it proves

Both new files own two `r13_*` tables, create them verbatim from their own DDL
and drop only those. Nothing here pushes a schema, and nothing drops a table it
did not create; no connection string was printed, logged or copied.

Five cells each, identical in shape across the two transports:

1. **Operation-owned rollback.** The refused `connectOrCreate` had already
   INSERTed its create arm's row; the operation's own transaction takes it
   back, and the sibling scalar of the holder's SET is never written.
2. **The child-held direction, natively** — the parent's own write does not
   survive the refusal either.
3. **Borrowed transaction ownership.** Inside `$transaction(async tx => …)` the
   caller writes a row, the engine refuses, and the caller then writes a second
   row and returns normally: both commit. On PostgreSQL this is a real
   discriminator — a statement that had reached the server and failed would
   leave the transaction aborted and every later statement would answer
   `current transaction is aborted`. The engine neither committed, replayed nor
   cleaned up the caller's transaction.
4. **The caller's own abort** still takes the whole callback with it.
5. **Controls** — a representable reference still connects natively in both
   directions, and an explicit disconnect is still legal.

The **segmented** claim is the SQLite batch-only fixtures' — `BatchOnlyDriver`
and `SessionlessBatchOnlyDriver` are transports, not providers — and it is
pinned in the credential-free file as what was MEASURED rather than what was
assumed: the refusal claims neither progress nor a rollback, `batchCalls === 0`
(so no segment was ever acknowledged behind it), and the final state is
untouched. Two shapes were probed for an acknowledged earlier segment,
including one with a representable sibling relation whose `updateMany` capture
would otherwise flush the parent's queued write; neither dispatched anything
(`receipts/progress-probe.log`, `receipts/progress-probe.test.ts.txt`). The
engine therefore never claims to have rolled back an acknowledged prefix here,
because it never has one.

## Unverified

- The `set` verb's coverage is measured through its observable answer
  (`receipts/residual-probe.log`, S1) and not through a reading of
  `OperationContext.mutateMembers`; it refuses with the requirement's sentence,
  which is the contract, but the statement that raises it was not traced.
- The native files exercise the interactive route only. Native providers
  support transactions, and forcing a batch profile on one would be a
  capability change by a test, which this unit does not make.
- No hosted driver (Neon, D1, PlanetScale) was reached. The requirement is a
  comparison of a resolved value against `null` with no SQL of its own, so no
  dialect is implicated — an argument, not a receipt.
- **Environment.** This lane's assigned containers had been restarted onto
  fresh ephemeral host ports, so the ports recorded in the brief and in the
  connection-string files are stale. The assigned PostgreSQL container
  (`viborm-raptor3-g3-pg-20260914`) was **started** — no database, schema or
  table outside this unit's own was created or dropped — and both natives were
  reached by substituting the container's live port into the assigned string
  inside one command. The assignment itself is unchanged.

## Blockers

None. No public-contract change, no new recovery authority, no capability flag,
no second interpreter: the sentence, its class (`NestedWriteError`) and its
relation meta are the inherited ones, and the only behaviour that changed is a
refusal the retired engine already made for the connection it refuses.

## Repair round (2026-09-21)

Two reviewer findings, both `minor`, both documentation-only. No production
file, no cell and no manifest row was touched; the contract, the owner, the
deletion and the registered count (26) are unchanged.

**1. The pin file's header told the pre-R1 story.**
`tests/raptor3/g4/parity/reference-representability.test.ts`'s docblock still
named `CommandExecution.supplied` as the requirement's owner (that method does
not exist — `grep -rn suppliedValues src/` is empty; the owner is
`CommandExecution.stored` at `commands/execution.ts:200`, its one sentence
`requireRepresentable` at :175, and `folded` at :228 states it a second time
for the folded arm alone), claimed the refusal stands "ahead of every write of
the unit" (a record-owned placement is asked at :516, after this record's
`before` children have run, so a refused `connectOrCreate`'s CREATE arm at
:716 may already have INSERTed its own row — the native pg witness's first
fact is precisely that the operation's own rollback takes that row back), and
listed as "out of scope" the two placements this same file now pins ("refuses
a connectOrCreate whose CREATE arm produces an unrepresentable reference",
"refuses the CHILD-held direction when the parent's own reference reads
null"). The ledger and `AGENTS.md` point a reader at this file, so the header
is the account they land on. It is now corrected IN PLACE, saying what
`AGENTS.md:1413`'s addendum says: the owner and the fold's second statement by
name; the refusal standing ahead of the holder's own SET and its sibling
scalars, with a `before` arm's INSERT taken back by the operation's rollback
and the segmented transports measured as having dispatched nothing; and what
actually remains out of scope — FC-02C's R3, the nested `update`/`upsert`
FOUND arm that nulls the referenced column under a live member, which keeps
its provider `ForeignKeyError`. Everything from the first `import` down is
byte-identical to the reported version.

**2. The registration breakdown was off by one cell.** The parenthetical at
this note's line 170 read "+5 cells x 2 routes = 10 new", summing to 24 against
the 26 it explains. The file gained six cells in the two-route loop, not five
(`grep -c '  it("'`: 6 at `cdd787ac8`, 13 now — twelve inside the two-route
loop, one inside the two-fixture segmented loop), so the runtime count is
12x2 + 1x2 = 26. The line now reads "+6 cells x 2 routes = 12 new"
(12 + 12 + 2 = 26). The value owed to `scripts/raptor3-manifest.mjs`
`G4_PARITY_COUNTS` — 26 — was already correct and is unchanged; the ledger's
"12 -> 26 cells" was already correct and is unchanged.

Nothing was declined.

**Runs (repair round).** One vitest, one typecheck, Biome on the one changed
source file.

| file | result | receipt |
| --- | --- | --- |
| `tests/raptor3/g4/parity/reference-representability.test.ts` | **52 / 52** (26 per project) | `receipts/repair-green-reference-representability.log` |
| `node scripts/run-typecheck.mjs` | **0 diagnostics**, exit 0 | `receipts/repair-typecheck.log` |
| `biome check` on that file | clean, format clean (as at the base) | `receipts/biome.txt`, "Repair round" section |

No census re-run: no sentence, class or error site moved (the change is a
docblock and a markdown parenthetical). No LOC re-measure: no engine file was
touched, and the pin file's own `git diff --numstat` moves by the header alone
(+56 / -37 comment lines).

## Commit message draft

```
fix(raptor3): a reference becomes a relation at the row that stores it, not at the choice that supplied it (R1)

FC-02C moved the located-NULL refusal out of the arm Raptor 3 had narrowed it
to, and RECORDED two placements its owner could not reach: a `connectOrCreate`
whose CREATE arm spells the referenced column NULL, and the CHILD-held
direction, where the concrete reference is the parent's own current value.
Both still wrote that NULL and silently DISCONNECTED the holder the payload
asked to connect, with the sibling scalars of the same statement committed
beside them. So did a child-held `create`, `createMany`, `connectOrCreate` and
`set`.

The requirement was never a choice's supply; it is the RECORD's. *All
components needed to represent a connection must be present and non-NULL* is
asked at `CommandExecution.stored`, over the write values of every record
statement — the point where a concrete tuple becomes the row a provider
stores, and the earliest boundary that holds each component's ACTUAL value
whatever supplied it: a located row's bytes, an arm this operation created, or
the parent's own current value (FC-02A's reader); a produced key once D-58's
boundary has carried it back, and never by re-running admission, defaults or
transforms. WHICH components to ask is the resolved edge's answer:
`Commands.assignMembership` is its one reader and now says so on the value it
contributes (`FieldValue.relation`), replacing the `membership` carrier the
code set on every contribution and never read — so an explicit `disconnect`'s
own NULL stays legal by construction and only the edge's members are asked.

Deleted: the choice-side loop over every demanded field,
`Assignments.contribute`'s dead fourth parameter and
`Commands.assignMembership`'s dead `contribution` parameter with its four call
sites' arguments (five-parameter functions 36 -> 35).
`CommandExecution.suppliedValues` is `folded` again, its gate unchanged, and
it states the requirement a second time for the ONE arm the record cannot ask
about: a folded parent-held `connect`'s value IS a sub-select by the time the
holder's SET names it. The two sites' coverage is disjoint and was falsified
one at a time — dropping the record's turns 32 cells red and leaves the plain
`connect` green; dropping the fold's turns exactly the plain `connect` red.

Pins: `tests/raptor3/g4/parity/reference-representability.test.ts` 12 -> 26
cells (both directions, found and produced arms, compound with one NULL
member, root and nested placement, a sibling write; controls for non-NULL
connections, nullable scalars, explicit disconnect, a NULL field outside the
consumed reference, and the create root's existing plan-time owner; plus the
two batch-only transports' progress). 24 red at the base, 52/52 green after.
New native witnesses `tests/providers/docker/pg-reference-representability.test.ts`
and `tests/providers/docker/mysql2-reference-representability.test.ts` (5/5
each): operation-owned rollback, a borrowed transaction left to its caller —
not committed, not replayed, not cleaned up — and the caller's own abort.
`parent-held-lookup` 56/56; `correlated-membership`,
`suppressed-membership-target`, `published-key`, `lane-x-set-mutations`,
`member-boundary-packaging`, `fresh-member-placement`,
`exclusive-member-cardinality`, `singular-slot-transition` green;
`nested-write-conformance-to-one` 19/19, `-fk` 28/28, `-membership` 30/30.
Typecheck 0, census identical to the base (23 candidate / 193 sites), Biome
per file unchanged, engine token lines 16,040 -> 16,040.

Registration owed (the manifest was not edited): G4_PARITY_COUNTS
"tests/raptor3/g4/parity/reference-representability.test.ts": 12 -> 26.

Adopts the decided handoff's "NULL reference" contract; FC-02C's two recorded
residuals are closed. A nested `update` arm that nulls the referenced column
under a live member keeps its provider `ForeignKeyError`, unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
