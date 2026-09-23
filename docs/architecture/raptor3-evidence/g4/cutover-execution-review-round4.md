# C-01 cutover execution — independent review, round 4

**Unit** `g4-cutover-execution`, round 4 (the round-3 review's resolutions applied).
**Brief** [`g4/briefs/cutover-execution.md`](briefs/cutover-execution.md) +
[`briefs/common.md`](briefs/common.md) + [`briefs/review.md`](briefs/review.md).
**Author's record** [`cutover-execution/note.md`](cutover-execution/note.md) §§R4.1–R4.10.
**Base** `5a37bcd7f371fe393cf7cecb8ec9f82ef8bd3062` (HEAD, unchanged).
**Previous review** [`cutover-execution-review-round3.md`](cutover-execution-review-round3.md)
(REVISE: findings 1–3 blocking, 4–6 must-fix, 7–8 notes).
**Reviewer** independent; did not write the unit.
**Receipts** [`cutover-execution-review-round4-receipts/`](cutover-execution-review-round4-receipts/),
probe [`tests/raptor3/g4/review/cutover/round4-deleted-refusals.review.test.ts`](../../../../tests/raptor3/g4/review/cutover/round4-deleted-refusals.review.test.ts).

## Outcome: **REVISE** (finding 1 blocking, finding 2 must-fix)

**Round 4's three blocking resolutions are real and I reproduced all of them
independently, from my own scratch trees, down to the failing set.** The four
lanes were run; every red in every lane fails identically on `5a37bcd7` with the
candidate route; the one cell the round-3 bisection could not see — the MySQL
GeoPoint spatial-index plan, whose oracle is `QueryEngine.build` — fails on a
base I rebuilt myself with D-14's publication hunks, with a failing set
**byte-identical to the cutover tree's**. **There is not one cutover defect in
any of the four lanes.** The restored class-A suites are exactly what the rule
says they are at the cell level: of the 200 cells the twelve restored files
lost, **every single one was red** when the base file ran on the cutover tree,
**every kept cell was green**, **no cell title was added** and **not one
surviving assertion was rewritten** — "nothing was re-pinned" is true, checked
mechanically line by line. Production is byte-identical to round 3; round 4
touched 23 files and none of them is under `src/`.

What blocks commit 4 is the *characterization* of what was deleted, and it is a
disclosure gap of exactly the kind rounds 2 and 3 found one lane lower down.

R4.5 and the commit-message draft describe all 240 deleted class-A cells as
"the **SQL-text, message-text, source-text and oracle pins** of the deleted
engine". **At least 27 of them are not.** They are registered refusals and
fail-closed contracts on READ, aggregate and result-decode paths that the
candidate no longer raises — and, like the 88 the note does record, they
reproduce on `5a37bcd7` + the candidate route, so they are compatibility
differences the brief makes Arnaud's decision, not defects. I measured five of
them through the **public client**, with the base as a control
([cutover](cutover-execution-review-round4-receipts/probe-CUTOVER.log),
[base](cutover-execution-review-round4-receipts/probe-BASE-legacy.log),
[base + candidate](cutover-execution-review-round4-receipts/probe-BASE-candidate.log)).
The sharpest one:

```
client.author.updateMany({ where: { name: {} }, data: { name: "overwritten" } })
  5a37bcd7 → throws  Filter for field 'name' must contain at least one operation.
  cutover  → { count: 2 }          // every row in the table
client.author.deleteMany({ where: { name: {} } })
  5a37bcd7 → throws  the same sentence
  cutover  → { count: 2 }          // the table is now empty
```

The commit message tells the integrator "**93 red cells beyond the base … 88 of
the 93 are unrecorded compatibility differences … in seventeen families … They
need Arnaud's decision**". A reader takes that as the complete set. It is not:
a further ≥ 27 differences are invisible because the cells that carried them
were deleted under a justification that does not fit them.

The fix is a **recording**, not a repair, and it is the same move the unit has
already made eighteen times.

---

## Findings

### 1. blocking — ≥ 27 of the 240 deleted class-A cells are lost registered refusals, not old-engine pins, and they are recorded nowhere

The rule R4.5 states and applies is "restore the file and delete only the cells
that are **red against the new engine** — the SQL-text, message-text,
source-text and oracle pins of the deleted engine". The first half was applied
exactly (see "What I verified"). The second half is a claim about *why* each
deleted cell is red, and for a large minority it is false.

I classified all 200 cells the twelve restored files lost by the failure the
base file produced when it ran on the cutover tree (the author's own JSON
receipt, `receipts/round4/classA-restored-run1.json`; my table is
[`classA-deleted-cells-with-observables.txt`](cutover-execution-review-round4-receipts/classA-deleted-cells-with-observables.txt)):

| what the deleted cell's failure actually was | cells |
| --- | ---: |
| a statement/shape text pin (`t0`→`q0`, `__viborm_cursor_0`, `0viborm_*`, `LEFT JOIN LATERAL`, byte-exact SQL) | 129 |
| `Operation '<verb>' does not compile to one SQL statement` — D-14's write refusal, **disclosed** | 28 |
| a source-text gate over a deleted file (`ENOENT`) or its own ratchet | 4 |
| **a refusal the base raised and the candidate does not, or raises as a different class / a raw `TypeError`** | **≥ 27** |
| (a further 8 of that last class are the same D-14 write refusal masking an older one, so I do not count them) | 8 |

The ≥ 27, by group:

- **11 read-path admission refusals**, all in `sql-generation.core.test.ts`:
  `refuses non-portable JSON string path` × 6 (`status`, `$.`, `$.*`,
  `$[last]`, `$[0`, `$status`), `refuses path segments whose escaping is not
  portable`, `json filter with only a path fails closed`,
  `empty accepted scalar filter fails closed`,
  `empty accepted relation filter fails closed`,
  `groupBy throws when direct having filter field is not in by`. Every one is
  `expect(() => …).toThrow(<sentence>)` on a `findMany` / `groupBy`; on the
  cutover tree nothing is thrown.
- **13 fail-closed result contracts** in `request-result-shape-contracts.core.test.ts`:
  `enforces the requested projection on direct execution` (resolves instead of
  rejecting), `rejects a relation-count row with missing carrier / missing inner
  relation / extra inner relation / primitive carrier`, `rejects private
  carriers that were not requested`, `enforces requested nested include shapes`
  (all `expected error to be instance of QueryEngineError`), `rejects duplicate
  groupBy fields` × 2, `rejects known but unrequested and uniformly missing
  scalar columns`, and two that now leak a **raw `TypeError`** where a refusal
  stood — `TypeError: Invalid provider integer` and `by.map is not a function`
  — plus `fails closed on simultaneous scalar and computed _distance output`,
  whose sentence changed.
- **3 cursor cells** (`vector-distance cursor ordering fails explicitly`, one
  per dialect): the registered `Cursor pagination supports direct scalar …`
  refusal is replaced by `vector.orderBy is not a function`.

Two of these were, separately, already removed from a **surviving** suite under
the same reasoning: `bulk-create-plan.core.test.ts`'s `fails closed on a short
provider result window` (R3.4 calls it "the deleted engine's short-window
message"; what it pinned is that a truncated provider result window raises
rather than silently reporting a wrong count).

**Measured, through the public client, with the base as the control.** My probe
`round4-deleted-refusals.review.test.ts` restates five deleted cells as the call
a user makes. It is **green on the cutover tree**, **red on every cell at
`5a37bcd7`**, and **green again on `5a37bcd7` + the candidate route**:

| call | `5a37bcd7` | cutover tree |
| --- | --- | --- |
| `findMany({ where: { metadata: { path: "$.*", equals } } })` (and the other five non-portable spellings) | throws `JSON filter for field 'metadata' has an unsupported path string '…': a path string must start with '$'. …` | resolves, `[]` — the malformed path is simply not applied |
| `findMany({ where: { metadata: { path: ["status"] } } })` | throws | resolves **every row** |
| `findMany({ where: { name: {} } })` | throws `Filter for field 'name' must contain at least one operation.` | resolves **every row** |
| `updateMany({ where: { name: {} }, data })` / `deleteMany({ where: { name: {} } })` | throws the same sentence | `{ count: 2 }` — **all rows updated, then all rows deleted** |
| `path: ["pet","toys","0"]` vs `path: "$.pet.toys[0]"` | the two spellings are one query | different answers (`[Ada]` vs `[]`) |

The last row is family 3's cousin and family 3 exists; the others have no family.
The `updateMany`/`deleteMany` row is the one I would put in front of Arnaud
first: a `where` that degenerates to an empty operator bag used to fail closed
and now matches the whole table.

**This is not a defect and must not be repaired.** All five reproduce on
`5a37bcd7` + the candidate route, so the unit's own classification — "an
unrecorded compatibility difference of the candidate, neither repaired nor
deleted" — is the right one. The brief is explicit: *"Refusals are contracts.
Preserve the registered refusals… A new observable compatibility choice is a
decision for Arnaud: record it as a blocker in your note, do not copy or 'fix'
legacy behavior."*

**Resolution.** (a) In note §R4.2, add the families these cells carry, with
their exact observables and cell counts, next to the seventeen already there —
the same treatment, from the same measurement I have already produced. (b) In
§R4.5 and in the commit message, replace "the SQL-text, message-text,
source-text and oracle pins of the deleted engine" with the measured split: N of
the 240 are text/shape pins, N are D-14's write refusal, N are **registered
refusals the candidate no longer raises**, and the last group is a set of
compatibility differences that the deletion of its witnesses does not make
smaller. (c) In the commit message's KNOWN RED, say that the 93 red cells are
the differences that are still *observable in a registered cell*, and that a
further ≥ 27 were carried by cells this commit deletes — with a pointer to the
note section. Nothing needs repairing and nothing needs restoring.

### 2. must-fix — round-3 finding 5's third file was not closed, and the round-4 summary names a different file in its place

Round-3 finding 5 named **three** files whose §1.4 removals dropped a verbatim
one-sided half: `operation-program-read-contracts`, `namespace-qualification`
(two cells), and **`tests/raptor3/g4/review/unit01-followup/distance-parity.test.ts`**
(two cells whose `mine.*` half was one-sided).

R4.6 re-expresses `operation-program-read-contracts`, both
`namespace-qualification` cells and **`provider-result-contracts`** — which is
finding **4**'s file, not finding 5's — and the author's round-4 summary states
"the three dropped one-sided halves were re-expressed … operation-program-read-contracts,
namespace-qualification and provider-result-contracts". `distance-parity` is
absent from R4.6; R4.7 renames its helper and its titles and nothing else, and
its cell count stays 7 of 9 (`g4-unit01-review` 198, which I re-ran). The
alternative the finding allowed — "record each as a knowing coverage loss" —
is only half done: R3.4's row says the pin removed was `AS "0viborm_distance"`,
not that a one-sided half went with it.

Materially, one of the two is harmless and one is not:

- `projects the distance and NOT the point column` — its one-sided half
  (`/AS "_distance"/`, `doesNotMatch(/AS "at"/)`, `fields === ["id","_distance"]`)
  **is pinned verbatim elsewhere**, at
  `tests/raptor3/g4/unit01/repairs.test.ts:399-403`, a registered cell unchanged
  since the base. Nothing was lost.
- `keeps the point column when it is selected in its own right` — its one-sided
  half (`/AS "at"/`, `/AS "_distance"/`, `fields === ["id","at","_distance"]`)
  is pinned **nowhere else**: `grep -rn '"at", "_distance"\|fields, \['` over
  `tests/raptor3/g4/` returns only `repairs.test.ts`'s two-field form. That fact
  — the point column survives beside the distance when it is selected in its own
  right — has no witness on the tree being committed.

**Resolution.** Re-express the second cell's three `mine` assertions (it is four
lines), or record the loss explicitly; and correct the sentence — in the note
and in the summary — that says the review's three files were the three that were
fixed.

### 3. note — round 4's own class-A measurement covers 14 files, not 15, and two receipts disagree about the totals

`receipts/round4/classA-restored-run1.json` contains **15 files, 540 cells, 208
red**. R4.5's table is **15 files, 568 cells, 240 red**, and `INDEX.txt` says
"536 cells, 208 red, 328 green". They reconcile — the JSON includes
`result-parser-architecture-gates.core.test.ts` (4 cells, 0 red), which is not
in R4.5's table, and **omits `read-traversal-byte-pins.core.test.ts` (32 cells,
32 red)**, which is — but only if the reader does the arithmetic. So R4.5's
"**The red count of every single file equals R3.4's table exactly**" is true of
fourteen files and inherited from round 3 for the fifteenth. That fifteenth is
the one whose disposition is "stays deleted", so the claim carries weight. Its
32/32 is a sound inference — I read the file at the base and it is 32 `test(`
cells, no `.each`, and its own docblock says "Every assertion pins ONE
`{ sql, params }` object", which the candidate's `q0` aliases alone make red —
but it is an inference, and R4.9 does not list it.

**Resolution.** One sentence in R4.5 or R4.9: `read-traversal-byte-pins`' 32
reds are round 3's measurement, not round 4's, and the run-1 receipt carries one
extra file and one fewer.

### 4. note — three small untruths left in the commit-message draft

1. `six libsql provider contracts … these sit inside the suite's existing
   describe.skip ("V1 effectful push is not supported by libSQL")`. The quoted
   sentence is the **`biome-ignore` comment on the line above**
   (`tests/providers/local/libsql-scalars-upserts.test.ts:30`); the
   `describe.skip`'s own title is `"LibSQL contracts that need effectful
   live-schema setup (DRIVER_NOT_SUPPORTED)"`. The substance — registered,
   matrix-visible, does not execute — is right, and it closes round 3's
   finding 3.2.
2. `three of those removals dropped a one-sided half that still holds; those
   halves are restated verbatim (operation-program-read-contracts' direct-runtime
   arms, two namespace-qualification cells, one provider-result-contracts cell)`
   — that list is **four** removals, and by the round-3 review's count at least
   six of the seven §1.4 removals dropped a one-sided half (finding 2).
3. `tests/raptor3/expanded/unique-filter-identity.ts:19` still names
   `tests/contracts/engine/write/extended-where-unique-behavior.ts` in its
   `sources:` string. R4.5 is right that this is provenance and not an import;
   it is now provenance pointing at a file this commit deletes.

### 5. note — `repair3.test.ts` keeps the stale vocabulary the renames removed everywhere else

The ten cell titles and `distance-parity`'s helper are renamed exactly on the
R2.3 pattern (verified below). Inside `tests/raptor3/g4/unit01/repair3.test.ts`,
the docblock still opens "All three are REGISTERED REFUSALS **the shipped engine
owns** … every one also pins **the shipped sentence** ABSOLUTELY", and the
locals are still `shippedWorld` / `seen.shipped`, where `shipped` is
`createClient(...)`, i.e. since C-01 the client route seam. The same is true of
`repair2.test.ts`'s and `repairs.test.ts`'s `{ shipped, candidate }`
destructuring. Round-3 finding 6 asked for the titles and the helper, and it got
them; this is the residue and it is cosmetic — the absolute sentence pins
themselves are unchanged and green.

---

## What I verified, and how

### 7. The production diff of round 4 is EMPTY — CONFIRMED three ways

- `captureRaptor3Identity()` computed by me, now:
  `production 50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63`
  — byte-equal to round 3's and to the author's round-4 receipt.
- The newest mtime under `src/` is `2026-09-16 23:43`
  (`raptor3/commands/index.ts`, D-14). Round 4 ran `2026-09-17 00:45–01:25`.
  Nine `src` files are newer than round 3's start and **none** is newer than
  round 4's.
- `find tests scripts src … -newermt "2026-09-17 00:44"` lists the author's
  **23 files**, every one under `tests/` or `scripts/` — the same 23 the note's
  Biome comparison counts — plus the note, the patch and my own probe.

**No cutover defect was found in any lane, so nothing needed repairing, and
nothing was.**

### Finding 1 of round 3 (the credential-free lanes) — CLOSED, reproduced

| tree | result | receipt |
| --- | --- | --- |
| cutover | **5 failed files**, 61 failed / 703 passed / 664 skipped of 1,428 | [`provider-local-cutover.MINE.log`](cutover-execution-review-round4-receipts/provider-local-cutover.MINE.log) |
| pristine `5a37bcd7` | 10 files passed, 8 skipped — **0 failed** / 1,253 passed | [`provider-local-BASE-legacy.MINE.log`](cutover-execution-review-round4-receipts/provider-local-BASE-legacy.MINE.log) |
| `5a37bcd7` + candidate route | 7 failed files — **71 failed** / 1,182 passed | [`provider-local-BASE-candidate.MINE.log`](cutover-execution-review-round4-receipts/provider-local-BASE-candidate.MINE.log) |

I built the scratch base with `git archive 5a37bcd7` and wrote the two-line route
default myself; the resulting diff is **byte-identical** to the author's saved
`bisect/base-tree-route-default.diff`. `comm` of the sorted `FAIL` lines: **all
61 cutover reds are in the base+candidate set, zero one-sided entries**, and the
10 extra are exactly `sqlite3-write-engine-linearization.test.ts` (8) and
`sqlite3-write-engine-mutations.test.ts` (2), the two suites C-01 deletes. My
failing set is `diff`-identical to the author's. Spot-checked observables
(`Unknown update operation: z`, `SEARCH q0 USING INDEX …`,
`needs at least one truthy value … but got 'Query execution failed'`) are
byte-identical between the two trees.

### Finding 2 of round 3 (the Docker lanes, and the bisection's blind spot) — CLOSED, reproduced, including the blind spot

`docker port` → pg `127.0.0.1:55729`, mysql `127.0.0.1:55730`, both G3 containers
up 13 h.

| lane | tree | result |
| --- | --- | --- |
| `pg-nested-write-races.test.ts` | cutover | **13 failed / 82 passed** of 95 |
| | `5a37bcd7` + candidate route | **8 failed / 69 passed** of 77 — failing set `diff`-identical to the author's; the 5 absent are exactly the restored `batchPrimaryKeyDataflowContract` cells |
| `pg-write-update.test.ts` (the file C-01 deletes) | `5a37bcd7` + candidate route | **19 failed / 148 passed** of 167 — **5** `batch primary-key dataflow` + **14** `extended whereUnique` |
| `mysql2.test.ts` | cutover | **13 failed / 71 passed / 1 skipped** of 85 |
| | `5a37bcd7` + candidate **route only** | **12 failed / 72 passed** — and the GeoPoint spatial-index cell **passes** |
| | `5a37bcd7` + candidate route + **D-14's publication hunks** | **13 failed / 71 passed**, failing set **`diff`-identical to my own cutover run** |

I rebuilt the build-oracle base myself: the three raptor3 files copied from the
cutover tree (whose whole diff against the base is +36/−0, +10/−1 and the
`publish`/`publishPrepared`/`decideRead` extraction — I read all three), and the
`query-engine.ts` / `pending-operation.ts` / `client-route.ts` hunks typed by
hand. My three hunks came out **byte-identical** to the author's saved
`bisect/base-tree-build-oracle.diff`. On that tree the spatial cell fails with
the byte-identical observable —
`expected { table_name: 'q0', …(7) } to match object { access_type: 'range', …(1) }`
— so **the MySQL GeoPoint spatial-index plan is a candidate compatibility
difference, not a cutover defect**, and the limitation the round-3 review named
is closed with a receipt rather than a caveat. R4.4's claim that the restored
`batchPrimaryKeyDataflowContract` registration is not what makes those five red
is likewise proved, not asserted: the same five die inside the file that held
the contract before C-01.

### Finding 4 of round 3 (the class-A suites) — CLOSED, and I re-derived it cell by cell

I ran the twelve restored files myself with a JSON reporter
([`classA-restored-now.json`](cutover-execution-review-round4-receipts/classA-restored-now.json))
and joined them, by `fullName`, against the author's run of the **base** files on
the cutover tree. For all twelve, at once:

| property | result |
| --- | ---: |
| cells kept and green | **328 / 328** |
| cells deleted | **200** |
| deleted cells that were **red** when the base file ran here | **200 / 200** |
| deleted cells that were **green** there | **0** |
| kept cells that were red there | **0** |
| cell titles **added** (a re-pin under a new name) | **0** |
| `+` lines containing `expect(`/`assert.`/`toThrow`/`toBe`/`toContain`/`toMatch`/`toEqual` across all 15 touched suites | **0** |

Per file, kept/base: `sql-generation` 91/147, `field-reference-sql` 49/89,
`operand-callback-sql` 62/74, `decimal-having-operand-sql` 42/48,
`cursor-pagination-sql` 14/44, `json-null-sentinel-sql` 21/30,
`request-result-shape-contracts` 11/29, `geopoint-sql` 14/20, `lateral-joins`
11/18, `batch-attribution-hazard-signature` 5/17, `write/parse-boundary-gate`
3/6, `write/architecture-gates` 5/6 — **every number in the commit message**.
200 deleted here + 40 in the three files that stay deleted (32 + 5 + 3) = **240**,
and 240 + 328 = 568. The round-3 review's 327 was indeed 568 − 241; **328** is
right.

I then read the diff of three files against `5a37bcd7` and every deleted cell's
assertion in them — `lateral-joins` (7: the two "lateral joins enabled"
describes, every assertion `toContain("LEFT JOIN LATERAL")`), `geopoint-sql`
(6: the write-lowering `test.each`, now answered by D-14's write refusal, and
three PostGIS cells) and `request-result-shape-contracts` (18) — and the
observable of all 200 (finding 1's table). The "delete only the red cells" rule
is applied faithfully; what it deleted is not all of one kind.

Two byproducts worth stating. `geopoint-sql`'s `uses the smallest positive upper
bound only in positive polarity` and `threads distance-prefilter polarity
through relation quantifiers` both die on `expected … to contain ' && '`: the
candidate emits **no PostGIS bounding-box prefilter on PostgreSQL**, the same
class of fact as the MySQL spatial-index row the commit message does disclose,
and the PostgreSQL half is disclosed nowhere. And the three
`combines all supplied filters independent of key order` cells die on two
statements that are no longer equal, i.e. the lowering is key-order-dependent
where the base pinned that it was not. Both belong in finding 1's recording.

The two orphaned behaviour modules are gone (`extended-where-unique-behavior.ts`,
`to-one-update-where-behavior.ts`), with no importer left anywhere. The manifests
are restored **in the base's own relative order**, which I checked
programmatically rather than by eye: `QUERY_ENGINE_CORE_TESTS` 77 → 65,
`WRITE_ENGINE_CORE_TESTS` 56 → 15, **zero entries added that the base did not
have, and the base list filtered to the survivors equals the current list element
for element** in every exported list.

### Finding 5 of round 3 (the one-sided halves) — 2 of 3 closed, verbatim; see finding 2

I diffed all three re-expressed suites against `5a37bcd7`. Every surviving line
is the base's, unchanged; the only `+` lines are a title, a comment, and (in
`provider-result-contracts`) the removal of a now-unused request-capture
wrapper.

- `operation-program-read-contracts` — the cell is back, keeping the base's
  `findMany { take: -2 }` reversal, `findFirst`, `findUnique → null` and
  `transactionCount === 0`; `executionCount === 8` is correctly gone with the
  four carrier arms it counted. **2 cells**, the base's count. This is exactly
  what my predecessor's probe cell 9 predicted.
- `namespace-qualification` — both cells back, keeping
  `not.toContain('"billing_ns_users"')`, `not.toContain('"ns_users"."')`,
  `not.toContain("__viborm_cursor_0")` and
  `not.toContain('"billing"."__viborm_cursor_0"')` verbatim. **122 cells.**
- `provider-result-contracts` — back, keeping the base's
  `resolves.toMatchObject({ rows: [{ location: locationText }] })` and its
  fixture. **115 cells.**

All three counts measured in my own core-lane run.

### Finding 6 of round 3 (the misnamed cells) — CLOSED

`repair2.test.ts:49`, `repair3.test.ts:88`/`:131`, `repairs.test.ts:124` now read
"… identically on the client route seam and the command engine", which is what
the cells do: the `shipped` arm is `createClient(...)` and the `candidate` arm is
`world.engine.execute`. `distance-parity.test.ts`'s `shippedStatement()` is
`routedStatement()`, with `shippedMessage` → `routedMessage`,
`const shipped` → `routed`, `"the shipped engine must refuse"` → `"the routed
seam must refuse"`, six titles and the header restated. `g4-unit01-review` is
**29 files / 198 tests green**, the registered count unchanged. See finding 5
for the vocabulary left inside `repair3.test.ts`.

### Finding 7 of round 3 (the retired adjudicator's literal) — CLOSED

`tests/raptor3/scenarios/contracts/instances.ts:321-351` restates the progress
record one-sided inside the `s2-changed-dependency` fixture's own `assert`: the
five common fields pinned unconditionally at the `sqlite-atomic-batch` profile,
and `{ memberPath: [1], totalMembers: 2 }` pinned for the engines that publish
them. That is the record `verifyChangedDependencyCommandsProgress` carried,
unchanged, with the one difference `verifyProgramEnginePair` strips named in a
comment.

### Finding 3 of round 3 (the commit message) — the KNOWN RED matches, lane by lane

Every number in the draft's KNOWN RED block is a number I measured myself on
this tree:

| lane | draft | my run |
| --- | --- | --- |
| core gate `--project='layer-*'` | 6 failed files / 11 failed tests of 464 / 9,301 | **6 / 11 of 464 / 9,301** |
| `provider-sqlite3` + `provider-libsql` | 5 failed files / 61 failed | **5 / 61** (703 passed) |
| `pg-nested-write-races.test.ts` | 13 failed / 82 passed of 95 | **13 / 82 of 95** |
| `mysql2.test.ts` | 13 failed / 71 passed of 85 | **13 / 71 / 1 skipped of 85** |
| base, credential-free lanes | 0 failed / 1,253 passed | **0 / 1,253** |

The six red core-lane files and all eleven cells are the ones the note names:
`query-interceptors-array` 3, `query-interceptors-integration` 2,
`official-cache-swr` 1, `contract-matrix` 1, `select-mode-capability-matrix` 3,
`bulk-insert-row-shapes` 1. `contract-matrix`'s single red is
`tests/raptor3/candidate-handoff.test.ts: expected undefined to be defined` —
the base's own, untouched by the restoration (the twelve restored files are all
classified). The draft's arithmetic closes exactly: 10 new core-lane cells (11
minus `contract-matrix`) + 61 + 13 + 9 = **93**; 2 (family 17) + 8 (R3.2's
public-client cells) = the 10; the seventeen families sum to **80**, + 8 = **88**;
93 − 88 = the **5** restored pg registrations.

The three sentences round 3 asked to be added or corrected are all present and
all true:

- **the changed refusal** — `Driver "<name>" supports neither transactions nor
  atomic batch execution.` at `src/drivers/driver-transaction-base.ts:790` and
  `:979` (double quotes), with the single-quoted spelling surviving only in the
  now-unreachable `write-engine/shared.ts:732`. Verified in the source.
- **`build()` publishes a different query** — `q0`/`q1` aliases (every deleted
  text pin shows it), no `LEFT JOIN LATERAL` for nested includes on
  PostgreSQL/MySQL (the seven deleted `lateral-joins` cells), MySQL GeoPoint
  `EXPLAIN access_type ALL` (reproduced above).
- **the restorations** — `create-many-return-fold` green,
  `batch-primary-key-dataflow` red on purpose with the engine limitation named;
  the six libsql contracts registered, matrix-visible and non-executing (see
  finding 4 for the mis-attributed quotation).

Two figures I re-derived from git rather than took: **203** deleted test files /
**91,069** lines, and **33** production owners / **28,740** lines — both exact.

### Suites I ran

| command | result |
| --- | --- |
| `node scripts/run-typecheck.mjs` (twice: before and after my probe) | **exactly the two permitted `pattern/pack.ts` TS2345**, at `:1443` and `:2633`, with all four review-probe files present. My probe's first cut added 7 `TS2741`; I fixed it in my own file (one type on a helper parameter, one call wrapped) and re-ran. |
| core lane `--project='layer-*'` | **6 failed files / 11 failed tests of 464 / 9,301** |
| `pnpm test:coverage:policy` | **11 / 11, 16 / 16, 6 / 6**, exit 0 |
| `run-raptor3 g4-unit01-review` | 29 files / **198** tests, gate verified |
| `run-raptor3 g2-contracts` | 16 files / **216** tests, gate verified |
| the twelve restored class-A files | **328 / 328** green |
| `run-raptor3 g4-unit02-pg-contracts` (55729) | 1 / 1 green |
| `run-raptor3 g4-unit02-mysql-contracts` (55730) | 3 files / **17** green |
| `--project=provider-sqlite3 --project=provider-libsql` (cutover / base / base+candidate) | 61 red / 0 red / 71 red |
| `provider-pg` `pg-nested-write-races` + `pg-write-update` | 13 / 8 / 19 as tabled |
| `provider-mysql2` `mysql2` (cutover / route-only / build-oracle) | 13 / 12 / 13 as tabled |
| the four `review-cutover` probe files | 4 files / **21** cells green |

### Evidence integrity

Nothing was committed, staged, reset or stashed; `HEAD` is still `5a37bcd7f`; no
production file was touched, and `captureRaptor3Identity().production` after this
review is `50c0ee97fb1458333c818735da4c92b7bca89daa65929199c00ef551533b7a63`, the
author's. The harness fingerprint moves from the author's
`02f0489ce79b9dc47903e1119603a87e478a911c68ae890e37dc93b54483ebb0` to
`11ff45cb8f1b92e2dafd867536d8e4dbc8a9f3e1d7f23e1f282e1c2963e6ce3b`: the
difference is my one probe file. Every command ran serially under the existing
workspace lock on the pinned runtime; no lock was removed. The three scratch
trees live outside the repository. The two Docker containers were written to by
the pg and mysql suites (which drop and recreate their own tables);
`g4-unit02-pg-contracts` and `g4-unit02-mysql-contracts` were green afterwards.

### Author claims I could not verify

- The build, the three bundle fixtures and the cost census were **not** re-run by
  round 4 or by me. Production is byte-identical to round 3, whose figures the
  round-3 review reproduced to the byte, so the inference is sound — but it is
  the inference R4.9 already labels.
- The four G4 campaign corpora were not re-generated by round 4 or by me.
- `read-traversal-byte-pins`' 32 red cells (finding 3).
- The patch's `git apply` round-trip is the author's; round 3 verified the
  equivalent for its own patch and I verified the deleted-file and deleted-line
  totals against git directly.
- The 45 → 33 Biome comparison is a scratch measurement I did not reproduce.
- No performance cell was re-measured, by the author or by me.
- Whether the 88 recorded differences, the ≥ 27 of finding 1, and the five
  knowingly-red pg cells are acceptable is a judgement for Arnaud. I classified
  them; I did not weigh them.
