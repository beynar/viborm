# N4 group A4 — the two "not implemented" sentences in `shared/storage.ts`

Worktree `/private/tmp/viborm-n4`, branch `n4`, base `bf7ac30b4`.
Write targets: `src/query-engine/raptor3/shared/storage.ts`; `src/schema/**/*.ts`
(read only — **no schema file was edited**, see below).
Rows: 48 and 49 (`docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md`).

## The truth this unit states

Both sentences are **unreachable**, so both are **invariants**, not refusals.
They are now stated through the engine's one invariant owner
(`src/query-engine/raptor3/shared/invariant.ts` — `EngineInvariantError`,
`assertInvariant`, `unreachable`), which this group **imported and did not
create**. Agreed name for the integrator: that file, that class, those two
functions — identical to group A2's.

The plan's rule for these three rows is "reachability through the schema
builder is established FIRST … it is never refused at the schema to move a
sentence." Reachability was established three ways and all three agree:

1. **By the call graph.** Every `bindMembership` call site reads the resolved
   slot before it binds: `prepareSlotPredicate` (`query.ts:1590`),
   `prepareProjection` (`query.ts:3529`), `countEdges` (`query.ts:3741`) and
   `RelationBody.expand` (`relation-body.ts:91`) each branch on
   `resolved.member` and on `edge.kind`, then either walk `edge.members` arm by
   arm or bind an ordinary/bound-inverse slot with no variant. The only arm
   name that comes from a payload is the tagged grammar's `type`, and
   validation pins it to `v.literal(publicType)` over the configured variants
   — in `taggedTargetPredicate` (filters, quantifiers, `_count`) and in
   `taggedVerb` (all eleven collection verbs) and `polymorphicUpdateFactory`
   (the to-one verbs). An unknown arm is a `ValidationError` at admission,
   which `tests/raptor3/g4/read-projection.test.ts:218` already records.
   Symmetrically, `physicalField` is only ever asked for a name that came from
   admission against the model's declared scalar keys, or from the resolved
   topology itself — `storedFields`, a `Membership.pairs` member, a carrier
   `discriminator.field`, a junction side's `referencedField`, or a row key.
2. **By exhausting the declaration surface.** `receipts-A4/structural.probe.test.ts`
   builds nine admitted schemas with the public `s.*` builder — FK simple and
   compound, self relation, ordinary junction, mapped names everywhere, a
   variant ROW carrier in all four carrier×inverse cells (optional and
   required), a variant JUNCTION carrier with generated and with pinned
   `.through(...)` names and with each inverse cardinality, and one model
   carrying two row carriers beside a junction carrier — then asks for EVERY
   `(model, field)` those schemas can make the engine ask about (each model's
   `storedFields`, each row key, and every field named by every bound
   membership on either endpoint) and EVERY `(model, relation, variant)` it can
   bind. All resolve. 22 cells, green.
3. **By running admitted payloads.** `receipts-A4/executed.probe.test.ts`
   instruments `EngineSchema.prototype.physicalField` and `.membership`, then
   runs ~50 admitted operations against a migrated SQLite world with both
   carrier families: all eleven collection verbs, the eight to-one verbs,
   filters (tagged, presence, quantified), projections (`variants`, `only`,
   `only: []`), `orderBy … _count`, `_count select`, `aggregate`, `groupBy`,
   the bound-inverse side of both carriers, and deletes. **1077 field asks over
   18 distinct `(model, field)` pairs — two of them carrier columns
   (`a4x_notes.subject_type`, `a4x_notes.subject_id`), so the carrier branch is
   exercised and answers — and 61 membership asks over 10 distinct triples,
   every carrier ask naming an arm. Nothing reached either throw.**
   (`receipts-A4/executed-asks.json`.)

The historical evidence agrees that these are engine-facing diagnostics: the
values the row-48 sentence was ever seen with are `_count`, `AND`, `author`,
`posts`, `0` (`g4/witness/receipts/g4-fixed-witnesses.attempt3.log`) — the
engine handing the resolver a filter operator, a relation name or an index.
Those were engine defects, since fixed. No admitted payload produced any of
them.

**Nothing was refused at the schema to move a sentence, and no `src/schema`
file was edited.** Two schema-side facts were checked and recorded instead:
`checkVariantRowStorage` already refuses a scalar MAPPED onto a carrier column
(`P008`, via `reservedColumns`), and a scalar whose FIELD KEY is spelled like a
carrier column (`subject_type`, mapped elsewhere) is admitted and shadows it in
`buildPhysicalFieldView` — it resolves to the scalar rather than reaching any
sentence. Both cells are in the structural probe. The shadowing is a naming
question, not a refusal; it is listed under **unverified / out of scope** below.

## Per row

| # | site (now) | disposition | what changed | the fact it rests on |
|---|---|---|---|---|
| 48 | `storage.ts:248` `buildPhysicalFieldView` | **ASSERT** (unreachable) | `throw new Error(\`Raptor 3 G1 physical field is not implemented: ${field}\`)` → `assertInvariant(column, "'${field}' is neither a declared scalar of '…' nor one of its variant carrier columns.")`. The carrier-column walk moved into one private `carrierColumns(schema, model)` that `buildStoredFieldsView` now reads too. | A model stores its declared scalars (`model["~"].state.scalars`, whose keys ARE `scalarFieldNames`) and its variant row carriers' generated `<relation>_type` / `<relation>_id` columns; `buildStoredFieldsView` enumerates exactly those two sets, and every asked name comes from admission against the scalar keys or from the resolved topology (a membership pair, a carrier discriminator, a junction side's `referencedField`, a row key). Junction columns are never asked here — they are escaped as `pair.junctionField` and their values bound through the SIDE's model and `referencedField` (`query.ts:911`, `:2382`). |
| 49 | `storage.ts:72` `variantMember` | **ASSERT** (unreachable) | `throw new Error(\`Raptor 3 G1 variant carrier membership is not implemented: ${name}\`)` → `assertInvariant(member !== undefined, …)`, and the helper now takes `variant` so the message tells "addressed with no arm" from "the undeclared arm 'x'" | A carrier slot names every arm at once and this one-membership view cannot represent that, so every caller addresses ONE arm or composes the arms itself. Each caller reads `resolved.member` and `edge.kind` first: a bound inverse answers untagged through `resolved.member`; a carrier slot is walked over `edge.members`; and the one arm name a payload supplies is the tagged `type`, which validation pins to a literal union of the configured public variants. |

Neither row needed the resolver extended, so neither is EXECUTE. The map's
`UNSURE` on both is resolved to **unreachable**, with the evidence above.

## Hunks

`git diff bf7ac30b4 -- src/query-engine/raptor3/shared/storage.ts`
(full diff saved at `receipts-A4/storage.diff`):

1. **imports** — `+ import type { PolymorphicStorageColumn } from "@schema/relation/polymorphic";`
   and `+ import { assertInvariant } from "./invariant";`.
2. **`variantMember`** — the `throw` becomes `assertInvariant`; a fourth
   parameter `variant: string | undefined` is added so the message names which
   of the two missing cases fired; the doc comment states the invariant and the
   owner that establishes it. Both call sites in `buildMembershipView` pass
   `variant` (they already had it in scope).
3. **`carrierColumns` (new, private)** — the `variantRowCarrier && !member`
   walk that `buildPhysicalFieldView` and `buildStoredFieldsView` each spelled
   separately, now once. This is the change that makes row 48's assertion
   honest: the descriptor a field resolves to and the list of what the row
   stores are the same enumeration, so they cannot drift and leave the
   assertion stating a fact that is no longer true. (ELEGANCE §1; it is not an
   abstraction for imagined consumers — it is one necessary fact that had two
   authorities.)
4. **`buildPhysicalFieldView`** — scalar branch unchanged; the loop becomes
   `carrierColumns(...).find(...)` + `assertInvariant`; the doc comment names
   where every asked field comes from.
5. **`buildStoredFieldsView`** — the duplicated walk is gone; it is now a
   spread of `scalarFieldNames` and `carrierColumns(...).map(column => column.name)`.
   Same names, same order.

No behaviour changes for any reachable input: the resolved descriptors, the
stored-field list and its order, and the set of states that fail are all
identical. What changed is the CLASS of the two failures and their message.

## Falsification record

The pin for an assertion is the census tool's classification, and it is red at
the base for the unit's reason:

| claim | at `bf7ac30b4` | at this worktree |
|---|---|---|
| `scripts/raptor3-refusal-census.mjs` counts these two sites | **public refusal sentences** (`storage.ts:214`, `:64`, class `Error`) — 46 public, 0 invariant | **Invariants** (`storage.ts:248`, `:72`, via `assertInvariant`) — 22 public, 18 invariant |
| the two unreachable states fail as `EngineInvariantError` and not `VibORMError` | **RED** — 3 cells fail, the throw is a bare `Error` and `shared/invariant.ts` does not exist | green, 3 cells |
| the reachable set is unchanged (structural + executed probes) | **green, 23 cells** | green, 23 cells |

Receipts: `receipts-A4/census-base.md` / `census-base.log`,
`receipts-A4/census-head.md` / `census-head.log`,
`receipts-A4/probes-falsified-at-base.log`, `receipts-A4/probes-head.log`.

The third row is the point: the 23 reachability cells are green at the BASE
too. The sentences were already unreachable before this change; this unit did
not make them unreachable by narrowing anything, it recorded that they were.

Method for the base run: the memory protocol for falsification — `cp` the head
copy of `storage.ts` to the scratchpad, write `git show bf7ac30b4:…` over it,
run, then `cp` the backup back and `diff -q` to verify. No `git checkout`, no
commit, no stage, no worktree added. `shared/invariant.ts` was left in place
(other groups' in-progress files already import it); the base copy of
`storage.ts` simply does not reference it.

## Runs

| command | result |
|---|---|
| `npx biome check src/query-engine/raptor3/shared/storage.ts` | **before** (identical to base): clean. **after**: clean. No formatter was run on the file. |
| `node scripts/run-vitest-safe.mjs run --config …/probe.vitest.config.ts` (3 probe files, TMPDIR `/private/tmp/viborm-n4-A4-tmp`) | 26/26 green, 1.91 s wall, 442.9 MiB peak RSS |
| the same, with base `storage.ts` swapped in | 23 green / 3 red (the classification cells only) |
| `node scripts/run-vitest-safe.mjs run tests/raptor3/g4/read-projection.test.ts tests/raptor3/g4/read-filters.test.ts` | 40/40 green, 4.96 s wall, 606.9 MiB peak RSS |
| `node scripts/run-vitest-safe.mjs run tests/raptor3/prep/variant-collection-order.test.ts tests/raptor3/polish/commands.test.ts` | 20/20 green, 6.23 s wall, 609.4 MiB peak RSS |
| `node scripts/raptor3-refusal-census.mjs` (head, and `--at bf7ac30b4`) | see the falsification table |
| `node scripts/run-typecheck.mjs` (whole estate) | 3 errors, **none in this group's files** — see "Still red" |

No test was deleted, skipped or weakened; no recorded expectation was changed
(nothing in `src`, `tests` or `scripts` referenced either sentence — only
`storage.ts` itself and historical evidence logs).

## Still red — other groups' in-progress edits

`node scripts/run-typecheck.mjs` at the time of writing:

- `tests/raptor3/ownership/commands.test.ts(376,55)` TS2322 — `"atomic-array"`
  is no longer assignable to `ExecutionBinding["kind"]`. Caused by the N4
  ruling item #31 landing in `src/query-engine/raptor3/shared/operation-context.ts`
  (the `{ kind: "atomic-array" }` arm and its `TransactionError` are deleted
  there); the test still constructs the deleted variant. **Not this group's
  file; not fixed here.**
- `tests/raptor3/g4/parity/batch-captured-bulk.test.ts(126,7)` and `(145,7)`
  TS2769 — a new, untracked parity test awaiting a `PendingOperation` where a
  `Promise` or thunk is required. **Not this group's file; not fixed here.**

Both flickered during the session (the `atomic-array` error disappeared and
returned between runs) because other groups are editing concurrently. `src/`
had zero diagnostics on every run.

Note also that the two historically permitted Pattern `TS2345` diagnostics at
`src/query-engine/pattern/pack.ts:1443` and `:2633` did **not** appear in any
run of this session.

## LOC

`src/query-engine/raptor3/shared/storage.ts`: 237 → 270 physical lines
(+33); **215 → 228 charged token-lines (+13)**, using the
`query-engine-structure.mjs` definition of `tokenLines` (physical lines with at
least one parser-owned token; comments and blanks excluded). The +13 splits as
roughly +6 for the two assertions and the extra `variant` parameter, +9 for
`carrierColumns`, −4 returned by the now-derived `buildStoredFieldsView`, +2
imports. 20 of the 33 physical lines are the comments that name each fact.

No other file in this group's targets changed. No file outside
`src/query-engine/raptor3/shared/storage.ts` and this note's directory was
written.

## Unverified / out of scope

- **A scalar whose FIELD KEY is spelled like a carrier column shadows it.**
  `collectReservedPhysicalNames` compares SQL names, so `s.string().map("subject_type")`
  is refused (`P008`) while a field keyed `subject_type` and mapped elsewhere is
  admitted; `buildPhysicalFieldView` then answers with the scalar, and
  `buildStoredFieldsView` lists the name twice. This reaches no sentence, so it
  is not an N4 row. It is a schema-naming question for Arnaud (should `P008`
  also reserve carrier column names against scalar KEYS?), recorded here and
  pinned by a cell in `receipts-A4/structural.probe.test.ts`. **Not changed:
  the brief forbids refusing at the schema to move a sentence, and this would
  be a new observable schema refusal.**
- **The recursive read's own `bindMembership`** (`query.ts:3212`) would reach
  row 49's state if `traversal.relation` named a carrier slot. That path is
  D-54's private recursive-read fit with no public entry point, so it is
  internal by the same ruling as rows 1–2 and 5–8; it is not evidence of
  reachability and was not touched.
- Reachability is asserted against the public client API and what
  `EngineSchema.admit` / `validation/**` let through, as the map defines it. A
  caller reaching into engine internals directly (as unit tests do) can still
  construct both states — that is what makes them invariants rather than
  impossibilities, and why the assertion is kept rather than deleted.
- The probes live in this group's evidence directory, not in a registered
  vitest project: they are reachability evidence, not a suite the estate runs.
  They need their own config (`receipts-A4/probe.vitest.config.ts`) because
  they sit outside `tests/**`. If the integrator wants them registered, they
  belong under `tests/raptor3/g4/` and that is a file this group does not own.
