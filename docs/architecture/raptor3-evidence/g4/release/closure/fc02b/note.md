# FC-02B — captured TEXT DateTime identities, the T3 residual

Branch `fc-02b`, worktree `/private/tmp/viborm-fc02b`, base `7c3c33a4e`
(after FC-00, FC-01, FC-03, FC-02A and FCPG).

Contract: the handoff's "FC-02 … B. Captured TEXT DateTime identities — the
recorded T3 residual", and FC-00's inventory row **F-4** — the one class-2 row
whose evidence was a *green-over-red pin* rather than an executed failure.

## The witness

`tests/raptor3/g4/parity/captured-identity-domains.test.ts` recorded the
residual as two cells named `cannot re-bind a TEXT dateTime key the payload
spelled …`, which asserted `assert.rejects(update, STALE_CAPTURE)`. Turning
them into success assertions and adding the coverage the brief asks for gives
the witness.

Minimized: on a transport without RETURNING (the shape that CAPTURES the rows
it writes), through the public client, on real in-process SQLite —

```ts
await client.instant.create({ data: { id: "2020-03-01T10:00:00Z", tag: "t", n: 0 } });
await client.instant.updateMany({ where: { tag: "t" }, data: { n: 1 }, select: { id: true } });
```

- **At the base (red):** `TransactionError: updateMany selected-row cardinality
  changed during its locked mutation.` The row exists, is perfectly addressable
  by its own payload spelling, and no concurrent writer touched it. Same for
  `2020-03-01T12:00:00+02:00`. The batch-only `delete … include` route answers
  a different sentence for the same cause — `QueryEngineError: createMany with
  'select' could not read back one of the created rows at the primary key it
  reported` — reached from `slot.create`'s own read-back at the key it
  reported, and the nested-create reference value answers `TypeError: UPDATE
  did not produce the required record`. **7 cells red at the base**, 14 across
  the two projects (`raptor3`, `coverage-raptor3`):
  `receipts/base-red.log`.
- **After (green):** 17 / 17 cells, 34 / 34 across the two projects
  (`receipts/pin-captured-identity-domains.log`). Each spelling's row is
  updated, the public `id` comes back as a `Date` at the right instant, and the
  exact stored spelling still addresses the row afterwards (nothing was
  rewritten).

The **cause** is one sentence: `SELECT` decoded the TEXT cell into a `Date`,
`schema.identity` put that `Date` in the captured identity, and
`Queries.scalarValue` re-spelled it through `admittedTemporal` /
`Date.prototype.toISOString`, so `UPDATE … WHERE "id" = '2020-03-01T10:00:00.000Z'`
addressed a row that does not exist. Logical instant equality does not
reconstruct the physical key's bytes.

## The fact and its owner

**Fact:** the PHYSICAL value of a captured cell — the bytes the row actually
holds — as distinct from the public value that cell MEANS.

**Owner:** the row decoder, `Queries.decodeScalar`
(`src/query-engine/raptor3/shared/query.ts`), which **already carries the
distinction**. Its `internal` parameter is threaded from `decodeQuery` /
`decodeProjection` through every arm, and the decimal arm beside the temporal
one already spends it: `shared/decimal.ts`'s `decodeDecimalScalar` returns
`decodePhysicalDecimal` (the codec's physical text) for an internal read and
`materializePhysicalDecimal` (the public `Decimal`) for a public one. The
`datetime` arm read `internal` and ignored it, always materializing the `Date`.

That the physical value of a TEXT-stored instant IS its spelling is not a new
claim either: `validation/primitives/datetime-physical-codec.ts` states it —
`encodePhysicalDateTime(iso, "text")` is the identity, and `"text"` is one of
the three `DateTimePhysicalForm`s the leaf already carries
(`leaf.dateTime`, from the adapter's `dateTimeRepresentation`).

So the repair is the existing seam applied to the domain that needed it: an
internal read keeps the provider's spelling, a public read materializes the
`Date`. `Queries.scalarValue` then binds that string back through
`a.literals.dateTime(wire, nativeType)` → `encodePhysicalDateTime(wire,
"text")` → the same bytes. `admittedTemporal` is unchanged and keeps its one
job: spelling a **payload's** `Date`. A string was always a pass-through there.

## The hunk

Four files, 349 insertions / 82 deletions; **one engine file**, and its
functional change is **one line**.

- `src/query-engine/raptor3/shared/query.ts`
  - `decodeScalar`, `case "datetime"`, after the unchanged `providerTimestamp`
    validation and its unchanged refusal: `return parsed;` →
    `return internal ? value : parsed;` (+ a 10-line comment naming the seam).
  - `admittedTemporal`'s doc paragraph: the sentence that stated the residual
    as a permanent limit is replaced by what is now true — a capture of such a
    column never produces a `Date` here, so the spelling still has exactly one
    owner.
- `src/query-engine/raptor3/AGENTS.md` — the guide addendum, placed
  beside the paragraph it corrects, not a rewrite.
- `tests/raptor3/g4/parity/captured-identity-domains.test.ts` — the pins.
- `docs/architecture/raptor3-evidence/g4.md` — the ledger record.

Nothing else. No adapter, no codec module, no `operation-context.ts`, no
`commands/*` — the units running in parallel edit those.

## The rule deleted

**The re-admission of a CAPTURED instant.** A captured `dateTime` no longer
crosses the admission boundary a second time; only a payload's `Date` does.
With it go:

1. the two `cannot re-bind a TEXT dateTime key…` residual cells and the
   `STALE_CAPTURE` regexp they shared (`captured-identity-domains.test.ts`);
2. the file-header and `admittedTemporal` paragraphs that recorded the
   residual as measured-and-not-a-repair;
3. the guide sentence in `AGENTS.md` ("still NOT addressable from a capture …
   not a repair"), superseded by the addendum beside it.

No refusal, error class, assertion or integrity requirement was deleted,
skipped or weakened. `providerTimestamp`'s grammar, the public DateTime domain
check and the `InvalidScalarResult` sentence run exactly as before and on the
same values — an internal read is validated identically and then answers the
validated *input* instead of the constructed `Date`. No policy boolean, no new
parameter, no mode branch, no second reader, no cache, no per-verb conversion.
No stored data is rewritten and no user input is normalised.

**Two distinct stored keys are never made equal.** The opposite: before the
repair, every capture of this column collapsed to one spelling. Now each
capture carries its own row's bytes, so `2020-03-01T10:00:00.000Z` and
`2020-03-01T12:00:00+02:00` — the same instant, two rows — remain two distinct
addresses. Pinned by the cell "two spellings of ONE instant stay two addresses,
each captured by its own bytes", which updates one and asserts the other is
untouched, then captures both and asserts the complement premise still holds.

## The second consumer / placement

The captured internal value is bound back at three genuinely different
placements, all pinned and all red at the base:

1. **The address and its premises** — `schema.identity` → `lowerIdentity` →
   `fieldValue`, for the mutation's own `WHERE` and for `requireCapturedSet`'s
   presence and complement premises (the three spelling cells, the compound
   cell, the two-spellings cell).
2. **The reference value a nested write spends** — the parent row captured by
   `OperationContext.update` is what the child's foreign key is written from:
   `slot.update({ where: { at: "…T10:00:00Z" }, data: { notes: { create: … } } })`
   on the non-RETURNING transport. Red at the base with `TypeError: UPDATE did
   not produce the required record`; green after, and the child really
   correlates (`include: { notes: true }` returns it).
3. **The root identity a collection correlates on** — the batch-only
   `slot.delete({ where: { at }, include: { notes: true } })`, the D1-shaped
   route, over all three spellings.

The **compound** placement (a two-member identity whose `dateTime` member is
non-canonical) and the **omitted** one (a row whose identity does not contain
the `dateTime` at all, so the column is an ordinary one) are both pinned; the
omitted cell is a control — it is green at the base and stays green, and it
asserts the public `at` is still a `Date` and the stored spelling still
addresses the row.

## Capability change

**One family recovered**, exactly FC-00 inventory row F-4: every captured route
— root selected bulk `updateMany`/`deleteMany` without RETURNING, a captured
`update`/`delete` with a relation projection or a nested write, and a
batch-only `delete … include` — over a **TEXT-stored `dateTime` key whose
stored spelling is not `Date.prototype.toISOString`'s**, i.e. a valid ISO
string written without milliseconds or with a UTC offset. Row F-4's class-2
status is discharged.

No new public language, no public-contract change, no numerical-semantics
change, no new recovery authority, no new adapter capability, no new refusal
and no removed one. Nothing previously accepted is now refused: the controls
(`date`, `bigint`, `decimal`, `time`, and both SQLite numeric storage forms)
measure that.

## Registrations (the integrator applies; `scripts/raptor3-manifest.mjs` untouched)

- `G4_PARITY_COUNTS["tests/raptor3/g4/parity/captured-identity-domains.test.ts"]`:
  **9 → 18**.

No new file, so no new manifest entry and no new project membership.

## Runs (file → counts)

One vitest at a time; no wide run, no directory run, no fixed lane, no
`g1`/`g2` comparison.

| File | Result |
| --- | --- |
| `tests/raptor3/g4/parity/captured-identity-domains.test.ts` (the pin, 9 → 18 cells) | **34 / 34** over `raptor3` + `coverage-raptor3` (6.45 s, 543.8 MiB) — `receipts/pin-captured-identity-domains.log` |
| the same file, base engine restored in a backup copy | **14 failed / 20 passed** — `receipts/base-red.log` |
| the same file, only `return internal ? value : parsed;` reverted | **14 failed / 20 passed**, identical set — `receipts/falsify-internal-physical-spelling.log` |
| `sqlite-native-datetime.provider`, `datetime-physical-codec.core`, `read-codecs`, `malformed-result-cuts`, `batch-captured-bulk`, `driver-result-parser`, `sqlite-datetime-recreation` (the touched codec's own pins, the decoder's refusal pins, the captured-set consumer and the storage-form family — one invocation) | **125 / 125**, 12 project files (8.66 s, 680.0 MiB) — `receipts/owner-and-neighbour-pins.log` |
| `tests/raptor3/g4/parity/postgres-identity-scratch.test.ts` (live PGlite, `--project raptor3-provider`) | **2 / 2** (2.92 s, 1431.1 MiB) — `receipts/pglite-identity-scratch.log` |

The file selection: the pin itself; the codec/decoding pins found by grepping
the tree for the touched sentences (`provider timestamp`, `public DateTime
domain`, `declared physical timestamp`) and for the codec names
(`decodePhysicalDateTime`, `encodePhysicalDateTime`, `dateTimeRepresentation`);
and one neighbour family on each side of the seam — the captured-set consumer
(`batch-captured-bulk`) and the provider result chain
(`driver-result-parser`).

Falsification method: `cp` to `$TMPDIR/backup`, edit in place, run, `cp` back,
**md5 verified equal** (`890d5a29…` for `shared/query.ts`). Never
`git checkout`.

### The PostgreSQL question, measured rather than assumed

The repair only reaches the arm where the provider hands back a **string** for
a `datetime`. `receipts/pglite-representation-probe.log` (and its script, `.mjs.txt`) shows
live PGlite answering a flat `timestamptz`/`timestamp` column with a JS `Date`,
so PostgreSQL enters the `value instanceof Date` branch above and is untouched.
A JSON-carried value does arrive as a string there
(`"2020-03-01T10:00:00+00:00"`), but an internal read never carries one: both
projections a capture uses — `Selection.rowProjection` (the model's stored
scalar fields) and `Selection.identityProjection` (its keys) — are flat scalar
columns, with no relation document to carry. MySQL's naive datetime string is
converted to an ISO `…Z` string by its adapter's `parseField` before the codec
sees it, and `toMySqlDateTime` re-spells that back to the naive UTC form it
stores.

## Typecheck

`node scripts/run-typecheck.mjs` → **exit 0, 0 diagnostics**, once, at the end
(7.48 s, 5393.2 MiB) — `receipts/typecheck.log`.

## Census

`node scripts/raptor3-refusal-census.mjs` → **public refusals 23** distinct
sentences at 30 sites, **192 total sites**. Unchanged; no refusal, error class
or message was touched. `receipts/census.log`.

## Biome

Per changed file, current tree vs `git show HEAD:<file>`, the base copy checked
at the **same path** so every path-keyed rule applies identically
(`receipts/biome.txt`):

| File | base | now |
| --- | --- | --- |
| `src/query-engine/raptor3/shared/query.ts` | 15 errors, 1 info | 15 errors, 1 info |
| `tests/raptor3/g4/parity/captured-identity-domains.test.ts` | 0 | 0 |

The rule breakdown is identical (4 `useSimplifiedLogicExpression`, 3
`noUnusedFunctionParameters`, 1 `noUnusedVariables`, 4 `noParameterProperties`,
2 `useDefaultSwitchClause`), and the 15th error is the file's **pre-existing
`format` diagnostic**, whose printed diff is byte-identical base vs now (9,839
bytes, same lines) — so the added lines introduce none of it. No file was
formatted: `shared/query.ts`'s base copy carries that diagnostic, which the
rules forbid touching, and the test file is not new — its one new formatter
diagnostic (a re-wrapped type annotation) was fixed by hand.

`AGENTS.md` and `g4.md` are Markdown and carry no Biome diagnostics.

## LOC

`node scripts/query-engine-structure.mjs` token lines (parser-owned tokens,
comments and blank lines excluded): **16,064 → 16,064, net zero**. The
functional change replaces one token line with another; everything else added
is comment. Physical lines: `shared/query.ts` 5,059 → 5,072 (+13, all comment;
whole tree 20,430 → 20,443). Branch nodes 2,563 → 2,564: the one ternary,
which is the repair. `receipts/structure-before.json`,
`receipts/structure-after.json`.

## Unverified

- (Review, integrator-applied) A fourth consumer of the internal decode is the value-IDENTITY consumers — `operation-context.ts:3152` and `:3123-3137`, `execution.ts:699` — which compare captured values; for a `dateTime`-keyed junction the comparison moves from object identity (a fresh `Date` per capture, never `Object.is`-equal) to value equality of the physical spelling. No pin covers that shape.

- Executed on **in-process SQLite only** for the repaired behaviour (both the
  capturing non-RETURNING route and the batch-only route), plus live PGlite for
  the no-regression check. No native PostgreSQL or MySQL run: the repaired arm
  is unreachable on both (measured above for PostgreSQL, read off
  `mysql-adapter.ts`'s `parseField` for MySQL), so a native receipt would
  measure the unchanged path.
- The **numeric** storage forms (`SQLITE.DATETIME.INTEGER`, `REAL`) keep
  returning a decoded `Date` for an internal read. That is deliberate — their
  physical value is a number the `dateTime` literal owner does not bind — and
  the two new control cells measure that a capture over them still round-trips.
  A Julian-day column written **outside** this engine at sub-millisecond
  resolution would still not be capture-addressable; no such cell exists and
  none is claimed.
- A provider that answers a flat `datetime` column with a string this engine's
  `providerTimestamp` grammar accepts but whose dialect re-parses differently
  (a zoneless spelling bound against a `timestamptz` column) is not exercised;
  no shipped driver produces one (`pg`/PGlite answer `Date`, MySQL's adapter
  normalises to `…Z`, SQLite answers the stored text).
- Only the two files named under **The hunk** were changed in `src/`; the whole
  `pattern-engine` gate was not run — the integrator runs it once for the
  program.

## Blockers

**None.** No irreducible representation change was needed: the internal/public
split the repair spends already existed on the codec seam and is already spent
by the decimal domain. No public-contract change, no new recovery authority, no
numerical-semantics change. One repair attempt, falsified once, green.

## Commit message draft (the integrator commits)

```
fix(raptor3): an internally captured TEXT DateTime keeps the bytes its row holds (FC-02B)

FC-00's inventory row F-4, the T3 residual: a `dateTime` column stored as TEXT
admits more than one valid ISO spelling of one instant. The admission boundary
keeps a payload's string unchanged and the SQLite adapter stores it byte for
byte, but a capture of that row decoded it to a `Date` and `Queries.scalarValue`
re-spelled it through `admittedTemporal`/`toISOString`. So a key the payload
wrote `2020-03-01T10:00:00Z`, or with a `+02:00` offset, was addressable by its
own payload and by nothing the engine captured — `TransactionError: updateMany
selected-row cardinality changed during its locked mutation` on every captured
route, with the row sitting there.

The necessary fact is the PHYSICAL value of a captured cell, and the codec
already owns the distinction it needs: `decodeDecimalScalar` keeps the codec's
physical form for an INTERNAL read and materializes the public `Decimal` for a
public one, on the `internal` flag `Queries.decodeScalar` already threads. The
`datetime` arm read that flag and ignored it. It now takes the same seam —
an internal read of a TEXT-stored `dateTime` answers the provider's own
spelling, a public read still materializes the `Date` — which is exact because
`encodePhysicalDateTime(iso, "text")` is the identity, as the physical datetime
codec states. The captured identity then binds the stored bytes back, and
`admittedTemporal` keeps its one job: spelling a PAYLOAD's `Date`.

Two valid spellings of one instant stay two distinct addresses, each captured
by its own bytes. Nothing rewrites stored data, nothing normalises user input,
no per-verb conversion, no policy boolean, no new parameter, no mode branch.
`providerTimestamp`'s grammar, the public DateTime domain check and the
`InvalidScalarResult` sentence are unchanged and run on the same values. Net
zero engine token lines (16,064).

`captured-identity-domains.test.ts` 9 -> 18 cells, 7 red at the base / 17 green
after: the two residual failure expectations become success assertions and are
joined by the third spelling, the public `Date` asserted at each cell, two
spellings of one instant (each addressable alone, both together, never
conflated), a compound identity whose `dateTime` member is non-canonical, an
identity that omits the `dateTime`, the reference value a nested create writes
from the captured parent, the batch-only to-many over all three spellings, and
the `date`/`bigint`/`decimal`/`time` controls plus the two SQLite numeric
storage forms added here. Falsified by reverting the one line in a backup copy.

Registration owed (the manifest was not edited): G4_PARITY_COUNTS for
captured-identity-domains.test.ts 9 -> 18.

Typecheck 0, census public 23, Biome unchanged per touched file, engine token
lines 16,064 -> 16,064.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
