# Lane Q — independent review, round 2

Reviewer: independent agent, 2026-09-17. Worktree reviewed:
`/private/tmp/viborm-parity-q` (branch `parity-q`, base `356254a2`, no commit,
no stash, `HEAD == 356254a2d`), TMPDIR `/private/tmp/viborm-parity-tmp-q`. Read
in full before touching anything: the parity plan
(`docs/architecture/raptor3-parity-plan.md`, decisions D-17..D-24),
`g4/briefs/common.md` (the twelve rules), the worktree's
`src/query-engine/raptor3/AGENTS.md`, round 1's review (`lane-q-review.md`) and
the lane note's Round 2 (`lane-q-note.md:256-445`). Nothing in the worktree, the
main tree or the author's files was changed by this review: the two falsification
experiments and the one runtime probe were restored and removed, and the
worktree's `git status` is the same 31 entries (26 modified, 5 untracked) before
and after, with `md5` verified on both mutated files.

**Verdict: ACCEPT.** All seven findings are resolved, each one applied exactly as
round 1 spelled it and nothing else moved: the only files with an mtime after the
round-1 review (12:21) are the nine the note declares. The two blocking items were
falsified by this review in the live systems they concern — reverting R1's arm
reproduces the exact PostgreSQL red it repairs, disabling R2's hook reddens four
cells across two suites — and the D-22 falsifier, which round 1 proved did not
falsify, now does. Whole-estate typecheck: **0 diagnostics, exit 0**. The reds
that remain are the ones the note names (lane X's, the two polymorphic probes
that need Arnaud's decision, and the pre-existing container/base set); none is
hidden, no cell was deleted or skipped, no pin was rewritten to a wrong answer.

---

## 1. The seven resolutions, verified one by one

### R1 (blocking) — the decimal LIST carrier

`src/query-engine/raptor3/shared/query.ts:823-842` (`carriedValue`) is now the
hunk round 1 prescribed, character for character, and it states the same pair
`projectedColumn` (`:792-800`) produces:

```ts
    if (leaf.type === "decimal")
      return leaf.list
        ? this.adapter.arrays.decimalProjection(expression)
        : this.adapter.expressions.cast(expression, "text");
```

The unit's invariant ("`carriedValue` consumes the physical fact
`projectedColumn` produced") is now true of both spellings rather than one.

**A/B, on the live container** (`postgresql://postgres@127.0.0.1:55729/raptor3_g2`,
one file at a time):

| tree | `tests/providers/docker/pg.test.ts` | the cell |
| --- | --- | --- |
| branch with the arm reverted to the scalar spelling | — | `pg scalar round-trip behavior › include round-trips datetime, decimal, and bigint exactly` **red**, `Driver "pg" returned a malformed decimal scalar for operation "findUnique": the value is not an exact decimal list in this column's declared domain.` |
| branch as submitted | **20 red** / 200 passed / 7 skipped | the same cell **green** (line 201 of the run) |

The 20 reds are exactly the pre-existing set round 1 attributed at the base: 15
`GeoPoint …` cells (this container has no PostGIS), `JsonNull is storable in a
NOT NULL json column`, and the four `enum references` cells (`42883`). The +1 the
branch had introduced is gone. The second PostgreSQL driver agrees:
`tests/providers/docker/postgres-serialization.test.ts` is **4 red** / 197 passed,
all four the pre-existing `enum references` cells, with the decimal include cell
green (line 133).

R1 is a strict no-op on the other two dialects, and I checked that rather than
assuming it: `arrays.decimalProjection` is `CAST(x AS CHAR)` on MySQL
(`src/adapters/databases/mysql/mysql-adapter.ts:715`) and `CAST(x AS TEXT)` on
SQLite (`sqlite-adapter.ts:555`), which is what `cast(x, "text")` already spelled
there (`mysql-adapter.ts:587-588`, `sqlite-adapter.ts:414-415`); only PostgreSQL
distinguishes (`TEXT[]` vs `TEXT`, `postgres-adapter.ts:404`, `:284-285`). That is
why no MySQL suite needed re-running this round, and
`tests/providers/local/sqlite3-scalar-roundtrip.test.ts` is **180/180**.

### R2 (blocking) — the polymorphic collection filter is closed

`src/validation/relations/polymorphic/filter.ts:114-145` takes the slot from its
one caller (`polymorphic/index.ts:306-307`, which already held `relationKey`) and
carries a `refuse` hook of the same shape as `requireRelationQuantifier`
(`relations/filter.ts:123-131`). The sentence is byte for byte the shipped one —
I re-read it at `ff5e77ca`
(`git show ff5e77ca:src/query-engine/builders/polymorphic-collection-filter-builder.ts`,
line 118): `Polymorphic collection filter '${relation.slot.field}' requires one
of: some, every, none.`

**Falsified.** With the hook neutralised in a backed-up copy:
`parity-admission.core.test.ts` **3 failed / 69 passed** (the cell on all three
dialects) and `tests/unit/operation-schemas/relations/polymorphic-collection-filter.core.test.ts`
**1 failed / 18 passed**. Restored from the copy, `md5` verified; both suites are
green again (72/72 and 19/19).

The witness was inverted, not deleted: the cell count is unchanged (19) and the
new assertion pins the registered sentence instead of the fail-open it asserted.
The new falsifier cell is where round 1 asked for it —
`parity-admission.core.test.ts:201-207`, beside the two relation-filter cells,
over the file's own two-variant `gallery` model — and it pins the slot name.

### R3 — U5.5 is reported, and the hand-over is actionable

Not implemented in lane Q (the owner line is lane X's file), written as
hand-over #5 with the exact diff, which is what round 1 asked for. I checked the
diff against the real code rather than the note: at
`src/query-engine/raptor3/shared/operation-context.ts:1528-1533` both identifiers
the diff uses are in scope — `skipDuplicates` (the parameter threaded into
`buildInsert` at `:1518`) and `rows` (`for (const row of rows)` at `:1483`) — so
lane X can apply it as written. Two coordination facts are recorded as findings
below (§3.2): the consolidated hand-over list still says four, and lane X's
round 2 closed before this hand-over was written.

### R4 — the D-22 falsifier now falsifies

`tests/contracts/engine/query/parity-lowering.core.test.ts:331-373` replaces
"`lower(` appears" with the asymmetry itself: the JSON cell requires
`reset !== inherited` and strictly fewer folded arms, the scalar cell requires
`reset === inherited`.

**Falsified.** Reverting the arm at `query.ts:1421-1424` to the pre-D-22 rule
(`const folded = insensitive || declared === "insensitive";`) in a backed-up copy
gives **1 failed / 19 passed**, and the failure is the JSON cell at
`parity-lowering.core.test.ts:366` (`expected … not to be …`), with the scalar
cell green — which is right, because the reverted rule *is* the scalar rule.
Round 1 measured 20/20 green under the same mutation. Restored, `md5` verified,
20/20.

### R5 — correctly left as Arnaud's ruling

No code change, which is what round 1 concluded. The lane's claim is now the
narrow one ("the relation, groupBy, select, `_distance` and polymorphic sentences
are restored byte for byte", not "every refusal is"), and the question is
escalated under "Follow-ups for Arnaud". Unchanged, still open (§3.3).

### R6 — the third format hunk is gone

`npx biome check src/query-engine/raptor3/commands/index.ts` now reports exactly
two hunks, the multi-line `throw new Error` (`:152-154`) and the `NotFoundError`
arrow (`:176-177`), neither in this lane's diff; the first is present verbatim in
`git show 356254a2:src/query-engine/raptor3/commands/index.ts:149-150`. The new
`new Queries(schema, config.driver.adapter, config.driver.result)` wrap is not in
any hunk. R1's three new lines are format-clean too: passed through
`npx biome format` on their own, the formatter prints them unchanged. The other
seven round-2 files report **no diagnostic at all**; `shared/query.ts` keeps only
the pervasive format/`noParameterProperties` set it already had at the base.

### R7 — the claim in `mutation.ts` is made true, and it works

`refuseDefaultOnlySkipDuplicates` now reaches the polymorphic collection group
(`src/validation/relations/polymorphic/collection-mutation.ts:222-224`, `:287-294`;
`TaggedVerbOptions` gained the optional hook and `taggedVerb` already forwarded
its options to each arm's `v.object`). Round 1 left this unexercised, so I
exercised it with a throwaway probe (written into the worktree, run, deleted;
`git status` back to 31 entries):

- `update: { items: { createMany: { type, data: [{}], skipDuplicates: true } } }`
  **is refused**, and the message carries the registered sentence:
  `Value did not match any union member: Value did not match any union member:
  createMany with skipDuplicates cannot include a row with no explicit scalar
  values; no portable duplicate-only DEFAULT VALUES primitive exists., Expected
  literal: tick, Expected array`, `path: ["items","createMany"]`;
- the same rows **without** `skipDuplicates` are admitted;
- an explicit row **with** `skipDuplicates` is admitted.

So hand-over #1 (deleting the physical copy at `operation-context.ts:1379-1382`)
opens no hole on this route. One caveat is recorded as a finding (§3.1): this new
refusal is pinned by no registered cell, and the union wraps the sentence.

---

## 2. What I ran, and what it said

One file (or one project) per call, bounded runner, `TMPDIR=/private/tmp/viborm-parity-tmp-q`,
never two at once.

| target | result |
| --- | --- |
| `parity-admission.core.test.ts` (`layer-query-engine`) | **72/72** |
| `parity-lowering.core.test.ts` | **20/20** |
| `layer-operation-schemas` (whole project) | 47 files, **1290/1290** |
| `layer-relations` + `layer-validation` | 42 files, **911/911** |
| `layer-query-engine` (whole project) | 5 red / 635 passed — `contract-matrix` (pre-existing: it does not classify `tests/raptor3/candidate-handoff.test.ts`, a file no lane touched), `select-mode-capability-matrix` ×3 and `bulk-insert-row-shapes` (lane X) |
| `layer-client` (whole project) | 6 red / 530 passed — 5 lane X (`query-interceptors-array` ×3, `query-interceptors-integration` ×2), 1 lane Q (the cache-SWR hostile-JSON cell the note reports) |
| `provider-sqlite3` `sqlite3-scalar-roundtrip.test.ts` | **180/180** |
| `provider-sqlite3` `sqlite3-polymorphic-batch.test.ts` | 2 red / 147 passed — the reported collection orphan and lane X's singular transfer, exactly the two the note names |
| `provider-pg` `pg.test.ts` (docker) | 20 red / 200 passed / 7 skipped, every red pre-existing (15 GeoPoint/PostGIS, `JsonNull`, 4 `enum references`) |
| `provider-postgres` `postgres-serialization.test.ts` (docker) | 4 red / 197 passed, all four `enum references` |
| `node scripts/run-typecheck.mjs` | **0 diagnostics, exit 0** (7.5 s, 4.95 GiB peak) |
| `npx biome check` on the nine round-2 files | only the two base hunks in `commands/index.ts` and `shared/query.ts`'s pre-existing set |

**Nothing else moved.** The files whose mtime is after the round-1 review are
exactly the nine the note declares: `polymorphic/filter.ts`,
`polymorphic/index.ts`, `polymorphic/collection-mutation.ts`, `shared/query.ts`,
`commands/index.ts`, `raptor3/AGENTS.md`, `parity-admission.core.test.ts`,
`parity-lowering.core.test.ts`,
`polymorphic-collection-filter.core.test.ts`. No commit, no stage, no stash; the
main tree was not written to except this review file.

**Registration.** The five falsifier files are in
`scripts/query-engine-test-manifest.mjs` → `layer-query-engine`, and they
classify in `contract-matrix` (its single failure is `tests/raptor3/…`, which the
loop reaches after the parity files pass). `scripts/raptor3-manifest.mjs` is
untouched, correctly: no registered raptor3 file gained a cell.
`tests/contracts/engine/query/decimal-list-surface.test.ts`, which the note cites
as its live-PGlite receipt, is a tracked pre-existing file (`f0c37adaf`),
unmodified by this lane — not an unregistered new falsifier.

**Hygiene.** No `.skip`, `.only` or `.todo` anywhere in the round-2 diff; the one
inverted witness keeps its cell count (19) and asserts the decided behaviour; the
new admission cell is additive (69 → 72, three dialects).
`src/query-engine/raptor3/AGENTS.md` is **106 insertions, 0 deletions** — one new
section named for the lane, no other section rewritten — and round 1's
over-claim is repaired in it ("to-one, to-many and the polymorphic COLLECTION",
"root, nested in a create, nested in an update, and a polymorphic collection
group", the two decimal spellings), while it still states plainly what is NOT
restored (the collection orphan and the duplicate singular inverse).

**One fact, one authority** still holds for the round-2 edits: `refuse` remains
the single whole-object hook on the one object primitive (both return paths,
`primitives/object.ts:698-699`, `:772-773`), the collection filter's only caller
threads the slot it already had, `carriedValue` consumes `projectedColumn`'s
spelling instead of restating one, and
`polymorphicCollectionFilterFactory`'s new parameter is internal (imported at
`polymorphic/index.ts:96`, exported to no public surface). No second walker, no
policy boolean, no per-verb codec, no wrapper file.

---

## 3. Findings (none blocking)

### 3.1 R7's new refusal is pinned by no registered cell — minor

The polymorphic collection group now refuses a payload the estate previously
admitted, and only this review's throwaway probe exercised it. One cell beside
`parity-admission.core.test.ts:295-314` ("a default-only row cannot be skipped,
at the root or nested") would close it, e.g. a third arm for
`items: { createMany: { type, data: [{}], skipDuplicates: true } }`. Note for
whoever writes it: inside the tagged union the sentence arrives wrapped
(`Value did not match any union member: … no portable duplicate-only DEFAULT
VALUES primitive exists., Expected literal: …`), so the pin must match by
substring, not by equality.

### 3.2 Hand-over #5 is at risk of being lost between the lanes — program item

U5.5 (`createMany` trusts the provider's `rowCount`) is a plan item and is now
correctly reported rather than silently dropped, but: (a) the note's consolidated
list "Hand-overs to lane X, in one list" still enumerates four, with the fifth
living only in the Round 2 section; and (b) lane X's round-2 review closed at
12:25, six minutes before that hand-over was written (12:39). Nothing in lane Q
can fix this — it needs the orchestrator to route the diff (a lane-X repair round
or a small follow-up unit) and one line added to the consolidated list.

### 3.3 Open rulings and reported reds, unchanged and correctly surfaced

- **R5 / the four sentences without `for field '<f>'`** (`Filter for field …`
  and the three JSON ones): still Arnaud's ruling. The field is in
  `issues[0].path`; naming it in the sentence means building the per-scalar
  filter objects per field, which defeats `validation/scalars/intern.ts`.
- **The polymorphic collection orphan and the singular-inverse duplicate** need a
  probe outside the arm's row subquery; D-19 forbade a private carrier for the
  to-one case and is silent here. Both stay red, in `sqlite3-polymorphic-batch`
  and `mysql2`, and the note writes out the design.
- **The cache-SWR hostile-JSON cell** stays red and is attributed to the cache
  route's own materialization (lane X's files) with the reason.

### 3.4 Cosmetic, round-1 carry-over

The five parity entries in `scripts/query-engine-test-manifest.mjs:30-34` were
inserted before `"tests/contracts/engine/query/orderby-relation-depth.core.test.ts"`,
which breaks the array's alphabetical order. No check enforces it and no test is
affected; worth one line the next time the file is touched.

---

## 4. Unverified by this review

- `provider-pglite` still cannot run under the runner's 1536 MiB ceiling, so the
  PostgreSQL branch of the edited `ordering-plan-behavior.ts` (`pgOuterRowValueSeek`,
  `Seq Scan`) remains unexercised here; its SQLite branch is green through
  `sqlite3-index-ddl` (round 1). The author's live-PGlite evidence for the R1 path
  (`decimal-list-surface.test.ts`, 41 cells) was not re-run by me — the two docker
  PostgreSQL drivers cover the same decimal-list decode.
- Hosted drivers (`planetscale`, `neon-http`) declare no `DriverResultParser`;
  after D-17 a hosted transport that hands JSON back as text would publish the
  string. Not testable in this environment; unchanged from round 1 and worth
  tracking.
- The MySQL docker suites were not re-run this round. Justified by the adapter
  spellings quoted in §1 (R1 is textually identical on MySQL) and by R2/R7 being
  dialect-independent admission facts, both of which I did exercise.
