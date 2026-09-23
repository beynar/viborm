# Lane Q — independent review (U1–U5)

Reviewer run 2026-09-17 against `/private/tmp/viborm-parity-q` (branch `parity-q`,
base `356254a2`), `TMPDIR=/private/tmp/viborm-parity-tmp-q`. Nothing in the
worktree, the main tree or the author's files was modified by this review; the
falsification experiments and the base-state comparisons ran in a scratch copy
(`…/scratchpad/base-check`, `…/scratchpad/base-orig`).

## Verdict: **REVISE**

Four of the five units hold as claimed, the falsifiers of U1/U2.1/U3/U4/U5.1
genuinely redden when the mechanism is broken, and the lane repairs **eighteen**
PostgreSQL cells nobody had measured. Two defects must be repaired before this
lane is accepted — one of them a new red in a registered provider lane, the other
a registered refusal the unit exists to restore and left open — plus three small
corrections. Every resolution below is minimal and was verified by the reviewer.

---

## R1 (blocking) — U5.1 regresses a decimal LIST inside a window on PostgreSQL

`src/query-engine/raptor3/shared/query.ts:823-832` (`carriedValue`)

The unit's invariant is "`carriedValue` consumes the physical fact
`projectedColumn` produced". For a decimal **scalar** that fact is
`expressions.cast(column, "text")`; for a decimal **list** it is
`arrays.decimalProjection(column)` (`projectedColumn`, `query.ts:792-800`), and
the adapters spell that per dialect: `CAST(x AS TEXT[])` on PostgreSQL,
`CAST(x AS TEXT)` on SQLite, `CAST(x AS CHAR)` on MySQL. The new arm applies the
SCALAR spelling to both, so on PostgreSQL a `numeric[]` crosses a JSON window as
the array *literal* `{1.00,2.00}` and its codec refuses it.

Measured, on an isolated database in the same container
(`postgresql://postgres@127.0.0.1:55729/raptor3_review_q`, created and dropped by
this review), one file at a time:

| tree | `tests/providers/docker/pg.test.ts` | the cell |
| --- | --- | --- |
| base `356254a2` | 38 red | `pg scalar round-trip behavior › include round-trips datetime, decimal, and bigint exactly` **green** |
| `parity-q` | 21 red | the same cell **red**: `Driver "pg" returned a malformed decimal scalar for operation "findUnique": the value is not an exact decimal list in this column's declared domain.` |

The red-set diff of those two runs is exactly `−18 / +1`: the branch repairs the
json string paths, the inert-mode and non-portable-path refusals, the three
decimal-exactness cells, `every scalar type round-trips exactly inside an
include`, `json primitives round-trip with exact types`, the scalar-subquery
operand and the nested-mode cell — and introduces this one. The same cell is red
on the second PostgreSQL driver (`provider-postgres`,
`postgres-serialization.test.ts`, green at base), so the blast radius is the
PostgreSQL dialect: docker `pg`, docker `postgres`, and local `pglite` (unrun,
see "unverified" below).

**Resolution** (verified green on `pg`, `postgres.js` and SQLite 180/180):

```ts
    if (leaf.type === "decimal")
      return leaf.list
        ? this.adapter.arrays.decimalProjection(expression)
        : this.adapter.expressions.cast(expression, "text");
```

It is a no-op on SQLite and MySQL (same spelling) and it makes the unit's own
sentence true, so the comment above it needs no change beyond "scalar OR list"
becoming the two spellings `projectedColumn` states. Re-run
`tests/providers/docker/pg.test.ts` and
`tests/providers/local/sqlite3-scalar-roundtrip.test.ts` afterwards.

## R2 (blocking) — U1 leaves the polymorphic collection filter fail-open

`src/validation/relations/polymorphic/filter.ts:114-128`

U1's own gate names "the to-one/to-many relation filters (`relations/filter.ts`)
**and the polymorphic collection filter**"; the collection factory was not given
the rule. Proven on the branch with a two-model variant schema:

```
where: { items: {} }  →  SELECT … FROM "zz_poly_galleries" AS "q0" WHERE 1
```

which is the data-loss shape U1.1 exists to close: `deleteMany({ where: { items: {} } })`
removes every row. This is not a new refusal either — the shipped engine raised
its own registered sentence at
`builders/polymorphic-collection-filter-builder.ts:126-130` (`git show ff5e77ca`):

> `Polymorphic collection filter '<slot>' requires one of: some, every, none.`

**Resolution:** give `polymorphicCollectionFilterFactory` the slot name (its one
caller, `src/validation/relations/polymorphic/index.ts:306`, already holds
`relationKey`) and pass a `refuse` that answers that sentence byte for byte when
none of `some`/`every`/`none` carries a value — the same shape as
`requireRelationQuantifier` in `relations/filter.ts:123-131`. Add the cell to
`parity-admission.core.test.ts` beside the two relation-filter cells.

The to-one variant filter is already closed (`{}` without `type` fails in the
presence arm) — only the collection is open.

## R3 — U5.5 was dropped without being reported

The plan's U5 item 5 (`createMany` trusts the provider's `rowCount`,
`operation-context.ts:1528-1532` — "compare the sum against the rows submitted
before publishing a count", falsifier "a 2-row `createMany` answered with one
`rowCount: 1` … raises and publishes nothing") is not implemented: the reducer at
`shared/operation-context.ts:1529-1533` still sums `result.rowCount` unchecked.
It appears in neither the note's "Still red" list nor its four hand-overs to lane
X, so it is currently lost work.

**Resolution:** either implement it (the owner line is in lane X's file, which
lane Q already edits at `:303` for D-17) or add it as hand-over #5 in
`lane-q-note.md` with the exact diff, the way U1's two hand-overs are written.

## R4 — the D-22 falsifier does not falsify

`tests/contracts/engine/query/parity-lowering.core.test.ts:332-358`

Both "JSON mode precedence (D-22)" cells assert only that `lower(` appears at
least once. Reverting the mechanism in a scratch copy — `const folded =
insensitive || declared === "insensitive";`, i.e. the pre-D-22 upgrade-only rule
— leaves the file **20/20 green**. The fact itself is pinned elsewhere (the
docker-PG cell `json path filters › mode: insensitive › a nested not may override
the inherited mode`, red at base and green here, and the sqlite3 nested-mode
cell), so nothing is wrong with the engine; the unit's named falsifier is simply
not one.

**Resolution:** pin the *asymmetry*, not the presence of folding — e.g. assert
the statement with `not: { string_contains: "ight", mode: "default" }` differs
from the same statement without the inner `mode`, and that the scalar-filter
statement does not.

## R5 — four registered sentences lost their `for field '<f>'` clause

`Filter for field '<f>' must contain at least one operation.` (plan U1.1, named
byte for byte), and the three JSON ones the deleted
`json-filter-builder.ts` owned (`JSON filter for field '<f>' has an unsupported
path string …`, `… requires a portable JSON path …`, `… sets mode: 'insensitive'
but has no …`) are now spelled without the field.

The author states the reason in the note's opening rule and escalates it under
"Follow-ups for Arnaud", and the reviewer confirms the substitute is real: the
`ValidationError` carries `issues[0].path === "where.name"` (probed through the
public client). The relation sentences, which the plan also named, ARE byte for
byte (`Relation filter 'posts' requires one of: some, every, none.` /
`… 'author' requires one of: is, isNot.`), as are the restored
`Scalar '<f>' used in 'having' must be included in 'by'.`,
`The 'select' statement for model '<m>' needs at least one truthy value.`,
`A distance result cannot be selected together with a model field named '_distance'.`
and `Unknown polymorphic target '<t>' for relation '<r>'.`

No registered, executed test pins the lost spellings, so this is **Arnaud's
ruling, not a repair** — but the lane cannot be called "refusals restored byte
for byte" until he takes it. Note that the class also changed for these four
(`QueryEngineError` at lowering → `ValidationError` at admission), which is the
plan's own rule 5 and is correct.

## R6 — one new Biome format hunk

`src/query-engine/raptor3/commands/index.ts:144` is 83 characters; the file was
already format-dirty at base (two hunks), and this edit adds a third. Every other
touched file is clean or carries only diagnostics that were already there at
`356254a2` (verified by diffing `npx biome check` output between the base copy
and the branch; `shared/query.ts` is heavily non-conforming in both, and the new
code follows the file's existing style).

**Resolution:** wrap the call as the formatter prints it.

## R7 (note-only) — `refuseDefaultOnlySkipDuplicates` is not on the polymorphic group

`src/validation/model/args/mutation.ts:57-67` says the refusal is asked "wherever
the verb appears — the root args below, a nested `createMany` inside a `create`
or an `update`, **and a polymorphic collection group**". The group shape at
`src/validation/relations/polymorphic/collection-mutation.ts:281-287` does not
carry it. Since hand-over #1 asks lane X to delete the physical copy at
`operation-context.ts:1379-1382`, the claim in that comment should be made true
or the comment corrected before that deletion lands. (The runtime path for a
polymorphic group was not exercised by this review.)

---

## What was verified, and how

**Falsification (mechanism broken in a scratch copy, pin watched, restored).**
Five units, five experiments:

| unit | mutation | result |
| --- | --- | --- |
| U1 | `requireFilterOperation` short-circuited | `parity-admission` 15/69 red (empty scalar, D-23 pair, JSON path-only, and the two bulk-mutation arms on all three dialects) |
| U2.1 | `lowerMutationLimit`'s no-limit branch lowered unqualified again | `parity-lowering` 7/20 red |
| U3 | the `having` membership refusal removed | `parity-preparation` 6/36 red |
| U4 | `{ set: … }` unwrapped at storage time again | `parity-assignments` 1/6 red **and** `sqlite3-nested-write` back to exactly its original 11 red |
| U5.1 | the decimal carrier cast removed | `parity-decoding` 1/9 red **and** `sqlite3-scalar-roundtrip` 4 red |
| U2.5 | D-22 reverted | `parity-lowering` **20/20 green** — see R4 |

**Suites run by the reviewer** (one file per call, bounded runner, same TMPDIR):

- the five new falsifiers: 140/140 green, all registered in
  `scripts/query-engine-test-manifest.mjs` → `layer-query-engine`.
- `sqlite3-returning-json` 176/176, `sqlite3-scalar-roundtrip` 180/180,
  `sqlite3-index-ddl` 126/126, `sqlite3-nested-write` 4 red (the four lane-X
  cells), `sqlite3-polymorphic-batch` 2 red (the reported collection orphan +
  lane X's singular transfer). Matches the note.
- `layer-validation` + `layer-scalars` + `layer-operation-schemas` +
  `layer-relations`: 3170/3170 green.
- `layer-query-engine`: 5 red — `contract-matrix` (unclassified
  `tests/raptor3/candidate-handoff.test.ts`, untouched by this lane),
  `select-mode-capability-matrix` ×3 and `bulk-insert-row-shapes` (lane X).
- `layer-drivers` + `layer-client`: 6 red — 5 lane X, 1 lane Q (the cache-SWR
  hostile-JSON cell the note reports).
- `raptor3` project, the files that pin lane-Q territory:
  `g4/unit01/repairs.test.ts` + `g4/read-codecs.test.ts` (25 green) and the
  sixteen `g4/review/unit01*` suites (93 green) — decoder strictness, having
  projection, distance projection, cursor refusals, decimal domains, JSON
  sentinels.
- Docker MySQL: `mysql2-relations-ddl.test.ts` — all 25 `relation-filter mutation`
  cells green including the three self-relation ones that need the ERROR 1093
  derived-table wrap; `mysql2.test.ts` — 8 red, matching the note.
- Docker PostgreSQL: see R1.
- `provider-libsql`: 9 green / 663 skipped (no server).
- `node scripts/run-typecheck.mjs`: **zero diagnostics**, exit 0.

**Pre-existing reds, attributed at the base rather than assumed.** Three groups
the note lumps into "pre-existing/concurrent" were re-run on `356254a2` in a
scratch copy and fail identically there: MySQL `to-many include honors descending
orderBy` (MySQL drops the ORDER BY inside the aggregate; the ascending twin
passes only because it coincides with primary-key order), the four `MySQL
namespace containment` cells, and — on PostgreSQL — `JsonNull is storable in a
NOT NULL json column` and the four `enum references` cells. None is lane Q's.

**Hygiene.** No `.skip`, `.only` or `.todo` added anywhere in the diff. No test
cell deleted: the four inverted witnesses each keep or gain cells
(`aggregate-args` 64→65, `relations/filter` 45→46, `json-scalar-schemas` 66→68,
`round4-deleted-refusals` 5→5, `ordering-plan-behavior` 8→8) and each now asserts
the decided behaviour instead of the defect. The ordering-plan re-pin is stronger,
not weaker: `guardedSpellings` must still equal a non-zero `rowValueSpellings`,
and the outer alias is read out of the statement the cell just captured. Nothing
was committed, staged or stashed; `git status` lists exactly the files the summary
declares.

**One fact, one authority.** `refuse` is one hook on the one object primitive,
invoked on both of `createObjectValidator`'s return paths; the filter bases it
replaces `extend` for carry no options, so nothing was dropped. Nested and logical
scopes reach it (`posts: { some: { title: {} } }`, `OR: [{ name: {} }]`,
`NOT: { name: {} }` all refuse). The `by` set is computed once and threaded;
`countedMemberships` publishes the `variants` fact instead of re-deriving it;
`Assignments` holds the admitted payload and `named()` is read only by the
key-reconciliation readers; the driver result chain is entered at one place
(`providerValue`) and skipped for carried values by one threaded `carried` flag.
No second public-syntax walker, no policy boolean, no per-verb codec, no wrapper
file. The two lane-X lines (`operation-context.ts:303`, `commands/index.ts:144`)
are the minimum D-17 needs and are declared as hand-overs.

**AGENTS.md.** The new "Parity lane Q" section states the invariants truthfully,
including what is NOT restored (the collection orphan and the duplicate singular
inverse). One sentence over-claims once R2 is read: "a relation filter refuses a
payload that names no quantifier" is not true of a polymorphic collection until
R2 lands.

## Unverified by this review

- `provider-pglite` could not be run: `run-vitest-safe.mjs` caps `--rss-limit-mb`
  at 1536 and the suite peaks at ~1669 MiB (the 2560 MiB allowance exists only
  inside `run-credential-free-tests.mjs`). `pglite-scalars.test.ts` runs the same
  `scalar-roundtrip-behavior` as the two PostgreSQL suites, so R1 should be
  expected to show there too, and the PostgreSQL branch of the edited
  `ordering-plan-behavior.ts` (`pgOuterRowValueSeek`, `Seq Scan`) is unexercised —
  its SQLite branch is green through `sqlite3-index-ddl`.
- Hosted drivers (`planetscale`, `neon-http`) declare no `DriverResultParser`.
  After D-17 the decoder no longer parses a JSON string itself, so a hosted
  transport that hands JSON back as text would now publish the string. Not
  testable here; worth one line in the note if Arnaud wants it tracked.
- The round-4 review probe is registered in no vitest project, so its inversion is
  read-only evidence (the author says so).
