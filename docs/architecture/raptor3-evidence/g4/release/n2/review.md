# Release unit "n2" — the lax to-one no-op (independent review)

Reviewer: independent (Opus), main tree `/Users/arnaud/code/viborm` on
`pattern-engine` @ `29f36fbca`, unit uncommitted. Read first: the author's
`note.md` and `receipts/`, the plan's §2, the external review's point 5,
`engine-unification/DESIGN.md` §5.3, `ELEGANCE.md`, `g4/briefs/common.md`.
Nothing under `src/` or `tests/` was edited; every falsification and every
statement probe ran in a scratch detached worktree at `HEAD`, removed
afterwards. `TMPDIR=/private/tmp/viborm-n2-review-tmp` for every run.

## Verdict: REVISE

The code is accepted as written — **no change to `src/` or `tests/` is
asked for**. Three corrections are asked for in `note.md` (and one in the
`g4.md` ledger line). Two are factual; the third names a consequence the
plan authorised by name but the note understates, and which the next unit
(N3 / D-32) needs stated before it plans its own premise work.

## 1. The fact and its owner (plan §2, ELEGANCE §1)

**Decided once.** `relation-body.ts:226` — `const lax = payload === true`,
a local const in the one function where the payload's form is known. It is
not stored on a command, not threaded through a context, not re-derived
anywhere. Three consumers read the *consequence*, never the form again:

| consumer | how the fact arrives | verified |
|---|---|---|
| the lookup's initial-absence refusal | `required` is the thunk or `undefined` (`relation-body.ts:236-242`) | `runSelection` (`execution.ts:256-259`) throws only when `required` is set |
| the batch presence premise | `retained ??= required` (`relation-body.ts:701`) stays `undefined`, so `execution.ts:263-264` is skipped | measured: base emits two asserts, the unit one (§4, probe C) |
| the removal's target | `target: lax ? undefined : outgoing.fields` (`relation-body.ts:282`) | `ctx.remove` omits the identity conjunct, `operation-context.ts:2787-2794` |

**No second reader.** `execution.ts:540-541` does not re-derive laxness: it
reads the *binding*, which is the honest consequence of the emission's
decision. That is the external review's point 5 satisfied literally — the
consumption rule is stated at the consumer, not simulated by making the
lookup optional and hoping.

**No new mechanism.** `Removal.target` was already optional
(`commands.ts:129-135`) and `clearMembership` already emits a targetless,
source-only removal (`relation-body.ts:798`). The lax removal is that
existing set-clear, reached by a second caller — not a new shape. The
dependency pass never reads `removal.target` (`commands.ts:600-620` matches
on `mutation.edge.scope.edge`), so the analysis is unchanged by construction.

## 2. Is the absent-row deletion rule safe for every `delete` the tree emits?

Every `{ kind: "delete" }` with a `located`, read in full:

- **`relation-body.ts:270`** (FK-holder side) and **`:299`** (inverse /
  junction) — both are `outgoing`. Lax ⇒ not required ⇒ the empty slot is the
  intended no-op. Strict ⇒ required ⇒ `runSelection` throws *before* the
  deletion runs. Both sources are `kind: "query"`, never `producer`.
- **`relation-body.ts:674`** (the to-many member delete near :656-665) — the
  series' `analysis` template. Its selection carries the required thunk built
  at `:645-657`, so even if the template were run it would throw, not no-op.
- **`execution.ts:846`** (the per-member delete of an expanded series) — its
  `located` is `commands.capture(selection, row)` and is written into
  `attempt.rows` at `:841-842` *before* the member is built. `runSelection`
  returns at its first line (`attempt.rows.has`), so the row is always bound.
  `capture()` also inherits `selection.required` (`commands.ts:1038-1049`).

**Could a required selection reach the deletion unbound?** No. `runSelection`
has exactly three exits: the pre-bound early return; the producer branch,
which binds unconditionally; and the read branch, which throws when
`required` is set and returns unbound only when it is not. A producer-sourced
selection is never a deletion's `located` (all four sites are `kind: "query"`).
So `if (row)` can only be false for the lax form — its unique coverage is
nameable, which is what the no-redundant-guards rule demands.

**The junction delete order** is untouched: for `verb === "delete" &&
edge.kind === "junction"` the removal is still placed before the deletion in
the same `"after"` bucket (`relation-body.ts:295-303`), and the lookup that
feeds the deletion is placed `"before"`, so the membership clear cannot
disturb it. Measured green on both modes, in
`polymorphic-collection-write-family.test.ts` (§4): ``delete: true` on an
EMPTY slot writes nothing`, ``delete: true` removes the SINGLE connected
owner, never the variant target` and ``disconnect: true` deletes THE
junction row, with no selector` — the empty and the occupied junction case,
on the clear and on the deletion.

## 3. Admission — where the strict branch lives

Confirmed by reading and by execution:

- to-one: `src/validation/relations/update.ts:317-318` — `disconnect:
  v.boolean()`, `delete: v.boolean()` (and `:324` for the
  no-`disconnect` variant). Booleans only; there is no to-one `{ where }`.
- to-many: `src/validation/relations/update.ts:475-489` — `disconnect:
  v.singleOrArray(whereUnique)`, `delete: v.singleOrArray(whereUniqueExtended)`.
  No boolean spelling.
- polymorphic to-one: `src/validation/relations/polymorphic/update.ts:225-231`
  — `delete` is a union of tagged objects, `disconnect: v.literal(true)`, and
  the `true` form is consumed before `relation()` at `relation-body.ts:138-165`.
- polymorphic collection: `collection-mutation.ts:306-313` — tagged `where`s;
  the file states there is no `disconnect: true` spelling at all.

Measured (scratch worktree, both routes): `posts: { disconnect: true }` and
`posts: { delete: true }` are refused by admission with a `ValidationError`
("Expected object, Expected array") and the two member rows are untouched.
So `lax === true` implies a to-one edge, and the targetless removal can never
become a to-many mass clear. The strict branch is the to-many edge's, exactly
as the note and the guide say.

## 4. What I ran

| command | result |
|---|---|
| `tests/raptor3/g4/parity/lax-to-one.test.ts` | **10 / 10** |
| `tests/raptor3/g4/parity/upsert-array-route.test.ts` | 6 / 6 |
| `…/query/nested-write-conformance-to-one.test.ts` (launcher) | **19 / 19** |
| `…/query/nested-write-conformance-fk.test.ts` (launcher) | 27 passed, **1 failed** — the same `createMany duplicate PK rolls back parent and prior ch…` cell as `receipts/regress/shard-5.log`. Not worse. |
| `…/write/polymorphic-collection-write-family.test.ts` (launcher) | 73 passed, **15 failed** — the failing set is line-for-line identical to `receipts/regress/polymorphic.log`; no removal/deletion cell is in it |
| `pnpm test:all --only "Raptor 3 fixed"` | **758 / 758**, 65 files |
| `node scripts/run-typecheck.mjs` | 0 diagnostics |
| `npx biome check` on both owners | **identical to base**: 10 diagnostics each, same categories, same descriptions, empty symmetric difference (compared against a detached `HEAD` worktree, JSON reporter) |

**Falsification (probe A).** `git worktree add --detach
/private/tmp/viborm-n2-verify-base HEAD`, pin copied in, own `TMPDIR`:
**6 of 10 cells fail**, each with the exact sentence the unit removes —
`Cannot disconnect relation 'author': target record was not found for this
parent.`, the same for `'profile'`, and `Cannot delete relation 'profile': …`
— on *both* routes. The four cells that pass at base are the two
occupied/strict controls per route, which is the right shape: the pin's
falsifiers are the lax cells only. Worktree removed.

**Probe B (statements, unit applied in the scratch worktree).** The lax
inverse `disconnect` lowers to `UPDATE "profiles" SET "userId" = NULL WHERE
"userId" = ?` — membership-correlated, no identity conjunct, re-evaluated at
execution, which is "whatever the slot holds at execution" literally. The
occupied lax `delete` lowers to `DELETE FROM "profiles" WHERE "id" = ?` —
the captured identity, as claimed. Vacate-then-supply (`disconnect: true` +
`connect`) is correct on both routes, empty and occupied: `pr1 → null`,
`pr2 → u1`.

**Probe C (the premise, same schema, base vs unit).** Occupied lax `delete:
true`, batch-only route. Base emits **two** assertions: the parent's
`EXISTS(users WHERE id = ? AND id = ?)` and
`EXISTS(profiles WHERE "userId" = ? AND "id" = ?)`. The unit emits **one** —
the parent's. This is the `retained ??= required` consequence, measured. See
finding F2.

## 5. Findings

### F1 — the note's hunk sizes contradict its own receipt (low, note only)

`note.md` §3 says `relation-body.ts (+13/−5)` and `execution.ts (+5/−4)`.
`receipts/numstat.txt` and `git diff --numstat` both say **18/9** and
**5/5**. Evidence discipline is the point of the receipt; a note that
disagrees with it will be read as the authority.

*Resolution.* In `note.md` §3, write `+18/−9` and `+5/−5`, or keep the
smaller figures and say explicitly "net of the three comment blocks".

### F2 — the batch route loses the captured member's premise on an OCCUPIED lax delete; the note frames it as being about an absent row (medium, note only)

Plan §2 authorises this by name ("the batch presence premise is not asserted
for a lax lookup (`retained ??= required` stays undefined)"), and DESIGN
§5.1/§5.3 make the exists-assert the batch realisation of `requireAffected`,
which §5.3 pins `false` for `delete: true`. So the code is right. But
`note.md` §2 describes it as "asserts no batch presence premise **for a row
that need not exist**", and that is not the whole effect: the premise also
covered the row that *does* exist at capture time. Measured (probe C): base
asserted `EXISTS(profiles WHERE userId = parent AND id = target)` before the
`DELETE … WHERE id = ?`; the unit does not. A member deleted or re-parented
between the capture and the batch is therefore deleted by its captured
identity, with no refusal, where the base refused.

The exposure is deletion-only and batch-only: the live route serialises the
read and the write inside the open transaction (DESIGN §5.1), and the lax
*removal* is safe by construction because it is re-evaluated at execution
(probe B) — only the deletion carries a captured identity forward.
ELEGANCE §6 is the distinction being collapsed: initial absence (what §5.3
makes lax) is not loss after observation (what the assert owned). The plan
already has an owner for the second — N3 / D-32, "the loss-after-observation
premise stated for the series' captured members, inside the mutation's
batch" (plan §3b) — and the lax to-one deletion's captured member is one
more consumer of it.

*Resolution.* One sentence in `note.md` (§2 or §5): on the batch route the
lax deletion no longer asserts the captured member's presence/membership, so
a member lost or re-parented between the capture and the batch is deleted
without refusal; the live route is protected by transaction serialisation
and the removal side by re-evaluation at execution; the loss-after-observation
premise for this captured member belongs to N3 / D-32, not here. No code
change: re-adding `retained` here would restore the refusal §5.3 forbids.

### F3 — the FK-holder lax `disconnect` keeps a lookup whose rows are now unused (low, note only)

Plan §2 says the FK-holder side of `disconnect: true` "needs no lookup". The
emission still builds and places it (`relation-body.ts:228-246`,
`requireLookup`), and measured it dispatches
`SELECT … FROM "users" WHERE "q0"."id" = NULL` before the parent UPDATE, on
both routes. Nothing reads its rows any more: the null literals are
contributed unconditionally and `publishMembership` is plan-time only
(`commands.ts:468-478`, consumed at `:778-781`). Statement count is unchanged
from base — this is not a regression, it is a dead read the unit created by
removing the only consumer of that read's result.

*Resolution.* Record it in `note.md` §5 as known dead work owned by N5 (one
sentence), or delete the lookup for `lax && edge.owner === "source" &&
verb === "disconnect"` in a later unit — the deletion branch of the same
`if` genuinely needs it, so this is a real change, not a tidy-up, and it does
not belong in N2.

### F4 — the ledger line names the wrong reviewer (trivial)

`docs/architecture/raptor3-evidence/g4.md`'s N2 entry ends "Sonnet review
pending". This review was performed by Opus, per Arnaud's instruction.

*Resolution.* Update that clause when the unit is committed.

## 6. What I did not verify

- **The 126-file estate claim** ("no file worse, 15 files better, the gate at
  142 red cells from 184"). I re-ran three of the named files and matched the
  receipts exactly, including an identical failing-test *set* for the
  polymorphic family. The other 123 files rest on `receipts/regress/` and
  `receipts/comparison.md`; I did not re-run the shards.
- **The mode suites, coverage and floors** (`g2-baseline` / `g2-contracts`
  216 / 216, `coverage:query-engine-core` 87.43, `coverage:policy`). Taken
  from `receipts/RESULTS.txt`; not re-run. Typecheck I did re-run: 0.
- **The Docker lane.** Not re-run, as the author discloses. The change is
  route-independent and both routes are pinned on SQLite, both modes on
  PGlite; under D-53 that establishes the SQL behaviour and leaves transport
  facts to their own witnesses.
- **Concurrency.** F2's window is a reasoned and statement-level result
  (base asserts, unit does not), not an executed race. No suite in this
  estate exercises an interleaving here.
- **The plan's own §2 witness sentence** was edited by this unit (the
  original demanded "an explicit `delete: { where }` on the same empty slot",
  which admission makes unspellable on a to-one). The correction is honest
  and the substitute witness is on the to-many edge where the strict form
  actually lives — but the plan is Arnaud's document, so the edit is his to
  confirm, not mine to accept.

## 7. Against the twelve rules and ELEGANCE

No test deleted, skipped or weakened: `git diff -- tests` is empty and the
only test change is the added pin. No refusal weakened beyond the one D-51 /
D-52 and DESIGN §5.3 name, and the strict refusal keeps its exact sentence
and is pinned on the to-many edge. No policy boolean, no second walker, no
new class, no legacy import. One owner decides, three consumers read the
consequence, and an existing optional field (`Removal.target`) absorbs the
new case instead of a new mechanism. Lint identical to base, typecheck clean,
no file in the estate worse. The code is sound; the corrections above are to
the record, not to the engine.
