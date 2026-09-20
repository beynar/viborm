# Release unit "n2" — the lax to-one no-op (note)

Integrator: Fable, in the main tree on `29f36fbca` (commit 20). The unit N2 of
`docs/architecture/raptor3-nesting-and-refusals-plan.md` §2, under rulings
D-51 to D-54 (2026-09-20). Receipts under `receipts/`.

## 1. The red

`disconnect: true` and `delete: true` on a to-one edge refused "Cannot
disconnect/delete relation '…': target record was not found for this parent"
where DESIGN §5.3's truth table pins a no-op — the three
`nested-write-conformance-to-one` cells (both modes), the polymorphic
singular-collection "EMPTY slot writes nothing" cells, two
`parent-held-compound-edge` cells and one `relation-key-update-legality`
cell (the gate triage's class C, mechanism 6).

## 2. The truth and its owners

The relation body (`commands/relation-body.ts`, the `disconnect`/`delete`
case) built the same required lookup for the lax form (`true`) and the
strict form (an explicit member selector). The form is known exactly there,
so the emission decides `required` from it: a lax lookup is not required,
and — through `retained ??= required` — asserts no batch presence premise
for a row that need not exist. The consumers answer an absent selection
honestly, the rule the external review asked for by name: a deletion whose
selection bound no row emits no statement (`commands/execution.ts`, the
`delete` command; a required selection threw in `runSelection` before
reaching it), and a lax removal names no target, so it is the set-based
membership clear the `Removal` type already allowed (`target` optional) —
at most one row on a to-one edge, whatever the slot holds at execution. The
FK-holder side of `disconnect: true` contributes its null literals as before
and reads nothing new.

Admission allows only `true` / `false` for a to-one `delete`, so the strict
form lives on the to-many edge and is unchanged; the guide says so
(`src/query-engine/raptor3/AGENTS.md`, the paragraph before the
`connectOrCreate` first-create-wins rule).

## 3. Hunks

`relation-body.ts` (+18/−9: `lax`, the conditional `required`, the
targetless lax removal, three comment blocks), `execution.ts` (+5/−5: the
absent-row deletion rule), `AGENTS.md` (one paragraph), the plan's §2 witness list corrected;
the pin `tests/raptor3/g4/parity/lax-to-one.test.ts` (five cells on each
route: the FK-holder disconnect, the inverse disconnect through a targetless
clear, the inverse delete on an empty slot, the delete of an occupied slot,
the to-many strict form still refusing). Lint: both owners' diagnostics
identical to their base.

## 4. Verification

- The pin 10 / 10 (`receipts/pin.log`).
- `nested-write-conformance-to-one` 19 / 19, from 16 (`receipts/to-one.log`).
- The whole shared-family and PGlite estate, one shard per process through
  the gate's own stages (`receipts/regress/`, `receipts/comparison.md`): 126
  files, **no file worse, 15 files better**, the gate at 142 red cells from
  the inventory's 184 (D-50 and this unit together; the files of the
  atomic-output family carry D-50's share). This unit's own share: to-one 3,
  polymorphic singular-collection 4 of the 7 (the other 3 were D-50's),
  parent-held-compound-edge 2, legality-occupied-to-one 1, parent-held-lookup
  1, compound-junction 1.
- The raptor3 fixed stage 758 / 758, g2-baseline and g2-contracts 216 / 216,
  typecheck 0, query-engine-core over its floors, the coverage policy green
  (`receipts/RESULTS.txt`).

## 5. Still red, unverified, blockers, known exposure

**Known exposure (the Opus review's finding, measured base against unit) —
closed by N3 (commit 23): the deletion lookup's `retained` is the raceable
membership race, asserted at capture; the pin gained the re-parented cell.**
On the batch route the lax deletion no longer asserts the captured member's
presence or membership inside the batch: the base emitted the member's
`EXISTS` premise before the `DELETE`, the unit emits only the parent's. A
member deleted or re-parented between the capture and the batch is therefore
deleted by its captured identity with no refusal where the base refused. The
live route serialises the read and the write inside its transaction, and
the lax removal is re-evaluated at execution (`UPDATE … SET "userId" = NULL
WHERE "userId" = ?`), so the exposure is batch-only and deletion-only. It is
ELEGANCE §6's loss-after-observation, distinct from the initial absence
§5.3 makes lax: the premise for a captured member belongs to N3b / D-32,
not to `required` (re-adding `retained` here would restore the refusal
§5.3 forbids on the empty slot).

**Known dead work.** The FK-holder side of `disconnect: true` still builds
and places its lookup (`SELECT … WHERE "id" = NULL` before the parent
UPDATE, on both routes, as the base did): nothing reads its rows any more —
the null literals are contributed unconditionally and the membership
publication is plan-time. The statement count is unchanged from the base;
deleting that lookup for the lax FK-holder disconnect is N4's (the census
unit owns dead or internal work; this read produces no red cell), because
the deletion branch of the same emission needs it.

Still red: the rest of the gate (142 cells), each named in the gate note and
the plan. Unverified: no Docker lane re-run for this unit (the change is
route-independent and the pin covers both routes on SQLite; the shared
estate is PGlite); the plan's §2 witness sentence was corrected by the
integrator (the strict form is unspellable on a to-one edge) and is
Arnaud's to confirm. Blockers: none.
