# FC-02A — the cascaded current identity at consumption

Unit FC-02A of the final closure program. Branch `fc-02a`, worktree
`/private/tmp/viborm-fc02a`, from `29a7bf9d8` on `pattern-engine`.
Contract: the handoff's "FC-02 … A. Cascaded current identity", in full.

Nothing was committed, staged, pushed or formatted (the formatter was not run
on any file whose base copy carries a `format` diagnostic). No database was
dropped; the shared MySQL was touched only through five `fc02a_*` tables this
suite creates and drops itself.

## The witness

The closure review's third executed failure, probe
`review: cascaded current identity with RETURNING=%s`
(`g4/release/closure-review/probes.test.ts.txt`): update a card whose primary
key IS its cascading account foreign key, move the related account from `a1` to
`moved`, change the card's own `label`, then select the card.

| tree | SQLite, RETURNING forced off | native MySQL (no RETURNING at all) |
| --- | --- | --- |
| base `29a7bf9d8` | **5 red / 16 green** of 21 — `TypeError: UPDATE did not produce the required record` at `shared/operation-context.ts:3020` | **3 red / 1 green** of 4, same sentence |
| after | **21 / 21 green** | **4 / 4 green** |

The RETURNING control and the batch-only route are green in both trees: this is
one path's defect, not a cascade defect.

Receipts: [`receipts/base-red.log`](receipts/base-red.log),
[`receipts/after-green.log`](receipts/after-green.log),
[`receipts/mysql-native.log`](receipts/mysql-native.log).

## The fact, and who already owned it

**The necessary fact:** a mutation consumes the values the row holds NOW,
which are not the values the operation observed when it located the row.

A correlated arm's target is the row this one's membership already names, so
when that arm's write moves the key it references the provider moves this row
with it (`ON UPDATE CASCADE`) *before* this row's own statement runs.
`CommandExecution.run` already materialises that into the attempt
(`Assignments.moved` → `CommandAttempt.materialize`), and from that moment
**`CommandAttempt.read` — the estate's one reader of a field's runtime value
(D-58) — answers the current value of every field of that row**, key or not.
That is the owner; no new one was created.

`CommandAttempt.rows` holds a different fact: what was SEEN. It is what a
choice's conditional skip and a `link`'s captured junction pair need, and it
stays exactly where it is.

**What went wrong at the base:** `CommandExecution` handed
`OperationContext.update()` both — the current address (`where`, from the
reader) *and* the original capture (`attempt.rows.get(command.located)`, as
`captured`) — and `update()` answered two of its three questions from the stale
one: the batch scratch's arithmetic base (`q.fieldValue(model, field,
captured[field])`) and, fatally, the non-RETURNING read-back's identity
(`updatedIdentity(model, captured, values)`). The statement changed the row the
cascade had moved; the read-back named the key it no longer held.

## The hunk

Three files, 38 inserted / 13 deleted (the two engine files: 33 / 10),
`git diff 29a7bf9d8 --stat`:

```
 src/query-engine/raptor3/commands/execution.ts               | 14 ++++++++---
 src/query-engine/raptor3/shared/operation-context.ts         | 29 ++++++++++++++++------
 tests/raptor3/post-prep/projection-preparation.test.ts       |  8 +++---
```

`src/query-engine/raptor3/shared/operation-context.ts` — `update()`'s second
parameter is now `current`, the row as it stands now, and the two-parameter
contradiction is gone:

```
-    where: Input,
+    current: Input,
     values: Input,
     member: Member,
     operation = "update",
-    demanded: ReadonlySet<string> = new Set(),
-    captured: Input = where
+    demanded: ReadonlySet<string> = new Set()
   ): Promise<Input> {
     …
+    const identity = this.schema.identity(model, current);
```

with `captured[field]` → `current[field]` (the arithmetic base),
`lowerIdentity(model, where)` → `lowerIdentity(model, identity)` (the
statement), and both `updatedIdentity(model, captured, values)` →
`updatedIdentity(model, identity, values)` (the read-back, batch and
interactive). `this.schema.identity` narrows the row to the model's keys, so
the statement's `WHERE` is byte-for-byte the one it was — the caller's `where`
was already exactly `schema.keys(model)`.

`src/query-engine/raptor3/commands/execution.ts` — the caller reads the row
once, through the reader that already answers the address:

```
-                this.identity(command.located.fields),
+                attempt.select(command.located.fields, [
+                  ...ctx.schema.keys(command.model),
+                  ...command.fields.demands,
+                ]),
                 …
-                command.fields.demands,
-                attempt.rows.get(command.located)
+                command.fields.demands
```

`this.identity(fields)` IS `attempt.select(fields, schema.keys(fields.model))`;
the call widens it by the fields this update demands, which is exactly the set
`update()` consumes beyond the identity.

**The rule deleted:** the update path's second source of truth. `update()` no
longer accepts a row that disagrees with its own address, so there is no
combination left in which the statement and its read-back name different rows,
and no `captured` default (`= where`) papering over a missing capture. No row
mirror was introduced, nothing is synchronised, and no MySQL-specific
correction exists — MySQL is only where the general path is reached natively.

## The second consumer / second placement

- **Second consumer of `current` beyond the identity:** the batch reference
  scratch's arithmetic base, `q.updateValue(model, field, value, q.fieldValue(
  model, field, current[field]))`. It is exercised by an **existing registered
  pin** — `published-key.test.ts`, "a child-held arm placed after the parent's
  write names the key that write published", on the batch-only route, where the
  parent increments its own key. Removing the base (falsification C) turns
  exactly that cell red:
  [`receipts/falsification-c-arithmetic-consumer.log`](receipts/falsification-c-arithmetic-consumer.log).
- **Second placement of the repaired read-back:** the new pin's nested cell —
  the same card update placed one level down, under `hub.update`, with a
  descendant `create` beneath it. It is a distinct code path
  (`CommandExecution.run` → case "record" → child → case "record") and it is
  red at the base with the rest.
- **Second consumer of the ORIGINAL observation, unchanged:** the choice cells.
  The missing-arm cell proves `attempt.rows` still answers what was seen — the
  found arm never ran, nothing cascaded, and the row stays at the key it was
  located by while its own write points it at the created row.
- The other caller of `update()`, `OperationContext.associate`, already passed
  `this.schema.identity(model, row)` and needs no change: with an empty
  `demanded` its `current` IS its identity.

## Capability change

**None.** No refusal was added, deleted or reworded; no error class changed; no
public argument, result shape or capability flag moved. Five valid operations
that previously raised `TypeError: UPDATE did not produce the required record`
on a transport without RETURNING now execute — that is the repair, not a new
capability. Census unchanged at 23 public sentences / 30 sites.

## Registrations owed (the manifest was NOT edited)

| file | cells |
| --- | --- |
| `tests/raptor3/g4/parity/cascaded-current-identity.test.ts` | **21** — add to `G4_PARITY_COUNTS` in `scripts/raptor3-manifest.mjs` |
| `tests/providers/docker/mysql2-cascaded-identity.test.ts` | **4** — no entry needed; `vitest.workspace.ts`'s `provider-mysql2` project collects `tests/providers/docker/mysql2*.test.ts` by glob |

## Runs

One vitest at a time, in this worktree, with `TMPDIR=/private/tmp/viborm-fc02a-tmp`.

| file | base | after |
| --- | --- | --- |
| `tests/raptor3/g4/parity/cascaded-current-identity.test.ts` (new pin) | 5 failed / 16 passed (21) | **21 passed** |
| `tests/providers/docker/mysql2-cascaded-identity.test.ts` (new, native MySQL) | 3 failed / 1 passed (4) | **4 passed** |
| `tests/raptor3/g4/parity/published-key.test.ts` (the owner's existing pins) | — | **12 passed** (×2 projects) |
| `tests/raptor3/g4/unit02/key-arithmetic.test.ts` (neighbour family) | — | **21 passed** (×2 projects) |
| `tests/raptor3/post-prep/projection-preparation.test.ts` (the other direct caller) | — | **4 passed** (×2 projects) |

No wide run, no directory run, no fixed lane, no `g1`/`g2` comparison: the
integrator runs the frozen gate once for the whole program.

### Falsifications (in a backup copy, restored by `cp`)

| # | mutation | result |
| --- | --- | --- |
| A | the base's shape restored: `CommandExecution` passes `attempt.rows.get(command.located)` again and `update()` splits it back out as `captured` for the read-back | the 5 non-RETURNING cells red, the RETURNING control and the batch route green — the base's exact signature; on MySQL 3 red / 1 green |
| B | the arithmetic base taken from the statement's identity instead of the row (`identity[field]`) | **nothing red** — recorded as a negative result, see "Unverified" |
| C | the arithmetic base removed entirely (`undefined`) | `published-key`'s child-held batch cell red — the consumer that reads `current` beyond the identity |

## Typecheck, census, Biome, LOC

- **Typecheck:** `node scripts/run-typecheck.mjs` → **exit 0**, once, at the end.
- **Census:** `node scripts/raptor3-refusal-census.mjs` → **23** public
  sentences at 30 sites (unchanged; run only to prove nothing moved).
- **Biome, per changed file, base copy vs working copy:** identical diagnostic
  counts and rules — `operation-context.ts` 6 (1 `format`, 1
  `assist/source/organizeImports`, 4 `lint/style/noParameterProperties`),
  `execution.ts` 4, `projection-preparation.test.ts` 9
  (`lint/performance/useTopLevelRegex`). The two new test files are clean and
  were formatted with `biome format --write`.
- **LOC** (`node scripts/query-engine-structure.mjs`, `queryEngine`):
  token lines **16,036 → 16,038 (+2)**; physical lines 20,333 → 20,356.
  The two token lines are `const identity = …` and the caller's widened reader;
  one parameter is deleted. This repair does not pay for itself in lines — it
  pays in the removed disagreement, and the account is stated rather than
  dressed up.

Details: [`receipts/perimeter.log`](receipts/perimeter.log).

## Unverified

- **The widened parameter's NON-key arithmetic input has no public witness.**
  Falsification B (arithmetic base from the identity instead of the row) turns
  nothing red, and the reason is structural: a field becomes `demanded` only
  when another command reads it — which, for a non-key field, means a relation
  references it — and the engine refuses arithmetic there at admission
  (`Cannot update relation key field 'x' with a non-literal operation while
  mutating relation 'y'`). Every arithmetic input reachable through the public
  client today is therefore a key, for which the identity would have answered.
  The widening is kept because it is what `update()`'s stated contract means
  and because the narrow form is a latent NULL base the moment that refusal
  moves; it is correct by contract, not by executed discrimination. Its
  consumer is real and falsified (C).
- **The read-back's `values`-applied key arithmetic** (`updatedIdentity`'s
  `q.updateValue` arm, a key that the payload itself increments while a cascade
  also moves it) is not pinned here: no payload expressible through the public
  client both cascades a key and applies arithmetic to that same key.
- The delete path (`CommandExecution.run`, case "delete") still addresses its
  row from `attempt.rows.get(command.located)`. It was left untouched because
  this unit's hunks stay local to the update path (FC-03 edits the same two
  files in parallel); whether a cascade can move a row between its capture and
  its own delete is a question for a later unit, not a claim of this one.
- Only local SQLite and local docker MySQL were executed. PostgreSQL declares
  RETURNING, so it does not reach the repaired branch; no hosted driver was
  touched.

## Blockers

**None.** No public-contract change, no new recovery authority and no
numerical-semantics change was needed: the repair is entirely inside the
existing owner's meaning.

One thing the integrator must do that this unit could not: register
`tests/raptor3/g4/parity/cascaded-current-identity.test.ts` (21 cells) in
`G4_PARITY_COUNTS`.

## Repair round (2026-09-21)

The independent reviewer raised three MINOR findings, all of them against
prose — two comments in the pin and one label in this note. None touched a
cell, an assertion or an engine line; all three are applied as requested,
and the diff of this round is comments and Markdown only.

**1. The header docblock's third paragraph (pin, lines 25-33) claimed the
batch-only route was the falsifier for the identity-for-capture substitution.
It is not.** The reviewer executed that exact substitution
(`q.fieldValue(model, field, current[field])` -> `identity[field]`) in a
backup copy and the pin stayed 21/21 — which agrees with this note's own
falsification B (negative) and with the "Unverified" entry above: no cell of
this file reaches the scratch arithmetic base, because only a key field is
ever `demanded` and arithmetic on a relation key field is refused at
admission. The paragraph now says what the route actually is — a ROUTE
control over the scratch-carried publication path — and points the widened
NON-key arithmetic input at the consumer that does falsify it,
`published-key`'s child-held batch cell.

**2. The arithmetic cell's comment (pin, lines 196-202 at the base of this
round, 201-205 now) asserted that "every projected field is DEMANDED —
including the NON-KEY `tally`" and that its value "travels through the batch
reference scratch".** Both are false:
`Assignments.demands` is populated only by `Assignments.field()`
(`commands/assignments.ts:85-89`), which a projection never calls — a
terminal select reads through `CommandExecution.identity` / `attempt.select`.
The cell is discriminating (it is one of the 5 red at the base) for the
read-back identity, not for the arithmetic base. The comment now states what
the cell pins: an `upsert` whose found arm takes the update, a non-key
`{ increment: 2 }` in the same statement as the cascade, and the row read
back at the key the cascade left it at on the route without RETURNING.

**3. "Two files, 38 inserted / 13 deleted" (this note, "The hunk") mislabelled
a three-file stat block.** `git diff 29a7bf9d8 --numstat`: execution.ts 11/3,
operation-context.ts 22/7 — the two ENGINE files are 33 / 10; the 38 / 13 is
those two plus `projection-preparation.test.ts` (5/3). Corrected in place to
"Three files, 38 inserted / 13 deleted (the two engine files: 33 / 10)". The
report blob's whole-diff figure (5 files, 98 / 13) was already right.

Nothing was declined, and nothing beyond these three was changed — in
particular the `ROUTES` table's own comment (pin, lines 118-122) was left
exactly as it stands, since no finding asked for it.

**Runs of this round** (receipts: [`receipts/repair-round.log`](receipts/repair-round.log)):

| file | result |
| --- | --- |
| `tests/raptor3/g4/parity/cascaded-current-identity.test.ts` | **21 passed (21)**, 1 file |
| `node scripts/run-typecheck.mjs` | **exit 0**, no diagnostics |
| `biome check` on the pin | clean, no fixes applied |

No other file was re-run: the engine hunks, the MySQL qualification and the
falsifications are untouched by this round, so their earlier receipts stand.
The typecheck was invoked twice only because the first invocation's status was
masked by a pipe; both printed zero diagnostics.

## Commit message draft

```
fix(raptor3): one current row for the update's address, arithmetic and read-back — the cascaded identity repaired (FC-02A)

A correlated arm that moves the key this row references moves the row with
it (ON UPDATE CASCADE) before the row's own statement runs, and the attempt
already re-addresses its observation from the value that arm published.
`OperationContext.update` then received that CURRENT address beside the row's
ORIGINAL capture, and answered two of its three questions from the stale one:
the batch scratch's arithmetic base and the non-RETURNING read-back's
identity. The statement changed the row the cascade had moved; the read-back
named the key it no longer held — `UPDATE did not produce the required
record`, the closure review's third executed failure, reached natively on
MySQL, the one adapter that declares supportsReturning: false.

The two parameters become one. `update()` takes `current`: the row's values
as they stand NOW, read by the caller for the model's keys and for every
field this update demands through `CommandAttempt.read`, the estate's one
reader of a field's runtime value (D-58). The statement's identity, the
arithmetic base and the read-back's identity all come from it, so no
combination is left in which they name different rows. `CommandAttempt.rows`
keeps the ORIGINAL observation for the consumers that need what was SEEN —
a choice's conditional skip, a link's captured junction pair — and nothing
is mirrored, synchronised or corrected per provider.

Pins: tests/raptor3/g4/parity/cascaded-current-identity.test.ts, 7 cells on
each of RETURNING, non-RETURNING and batch-only (the review case, a compound
cascade, the holder's own scalar and arithmetic write, a descendant under the
moved holder, nested placement, the choice's missing and found arms) — 5 red
at 29a7bf9d8, 21 green; and the native qualification
tests/providers/docker/mysql2-cascaded-identity.test.ts, 3 red / 4 green.
published-key 12/12, key-arithmetic 21/21, projection-preparation 4/4 (its
direct call re-spelled to the merged parameter, its expectations unchanged).
Typecheck 0, census 23, Biome unchanged per file, +2 engine token lines.

Register in scripts/raptor3-manifest.mjs: G4_PARITY_COUNTS +=
"tests/raptor3/g4/parity/cascaded-current-identity.test.ts": 21.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
