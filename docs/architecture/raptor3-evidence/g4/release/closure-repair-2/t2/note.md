# T2 — the dual-condition failure says what the statement measured

Repair prompt 2 §2 (`docs/architecture/raptor3-local-closure-repair-2-prompt.md`).
Base `88fe2814b` on `pattern-engine`, continuing in the T1 worktree
`/private/tmp/viborm-te`, branch `closure-te`. Native MySQL 8 for the measured
schedules, credential-free SQLite for the rest. Receipts: [`receipts/`](receipts/).

## 1. The failing witness

G1's note recorded the defect as a cost it had chosen to pay
([`../../closure-repair/g1/note.md`](../../closure-repair/g1/note.md) §1, "The
cost this pays, named"): *"the failure raised is the first condition's … for an
upsert carrying both conditions, where both matched and only the second has
since drifted, the sentence names `targetWhere` where U1's two reads would have
named `setWhere`."* §12 recorded that no cell witnessed it. A diagnosis that
names a condition the statement never singled out is not a cost of one round
trip saved; it is a wrong answer, and pinning it would have preserved it.

The schedule, on a root `upsert` carrying BOTH conditions against a row that
matches both (`targetWhere: { name: "chosen" }`, `setWhere: { count: 7 }`): the
locator and both probes read unlocked, another writer commits a change to ONE
of the two matched columns, and the confirmation — one statement, the
conjunction of the probes that matched — answers no row.

| witness | red at base (`88fe2814b`) | after |
| --- | --- | --- |
| only the SECOND condition's column changed | `… upsert targetWhere match premise changed …` — a condition that had not moved | `… upsert matched premise (targetWhere, setWhere) changed …` |
| only the FIRST condition's column changed | the same per-field sentence, by accident of ordering rather than by measurement | the same set sentence |
| BOTH changed | `targetWhere` alone | the same set sentence |

Credential-free (`tests/providers/local/sqlite3-found-consumption.test.ts`):
**6 failed / 14 passed** at base
([`receipts/01-red-at-base-sqlite.log`](receipts/01-red-at-base-sqlite.log), the
three cells in both projects) → **20 / 20** after
([`receipts/02-sqlite-green.log`](receipts/02-sqlite-green.log)). Native MySQL
(`tests/providers/docker/mysql2-found-consumption.test.ts`): **3 failed / 12
passed** at base
([`receipts/03-red-at-base-mysql.log`](receipts/03-red-at-base-mysql.log)) →
**15 / 15** after ([`receipts/04-mysql-green.log`](receipts/04-mysql-green.log)).
Both base runs were taken with the production files restored BY COPY to
`88fe2814b` (`commands.ts`, `execution.ts`) and restored the same way after; no
`git checkout`, nothing staged.

## 2. The continuing invariant, and its single owner

**Invariant.** A failure reports what the statement that failed MEASURED. The
found arm's confirmation is one statement proving one premise — the conjunction
of every condition that matched (G1 §1, unchanged) — so what a miss loses is
that premise: where several conditions were conjoined the failure says a MATCHED
REQUIREMENT changed and names the conditions as a SET; where exactly one was
matched the premise IS that condition and its own precise sentence stands, byte
for byte.

**Owner.** The place the premises are BUILT: the root upsert in
`Commands` (`src/query-engine/raptor3/commands/commands.ts`), whose one sentence
builder now spells all three subjects of this family — `${field} match premise`,
`${field} skip premise`, and `matched premise (${conditioned})` — and hands the
confirmation's own failure to the choice as `Choose["conditions"].matched`. The
place that RAISES it is unchanged and now states no diagnosis of its own:
`CommandExecution.confirmFound` (`commands/execution.ts`) raises
`conditional.matched` where it raised `first.match`. One fact, one owner; no
second interpreter, no per-verb switch, no round trip, no policy bit.

Two consequences follow from that single rule, and both are pinned:

- **No round trip is bought.** The confirmation stays ONE statement: three cells
  assert exactly one locked confirmation natively
  (`confirmationsOf(driver, TAG_TABLE)`, addressed by `` `id` ``), and four
  assert the credential-free statement census (locator, two probes, one
  confirmation).
- **The BATCH route keeps per-field attribution, and must.** There each
  condition is its OWN premise statement (`requirePresent` per probe in
  `case "choose"`), so naming the one that disagreed is a fact that route
  measured. Nothing on it changed; the scripted corpus that owns it
  (`tests/raptor3/transitions/conditional-upsert.ts`, whose stale scenarios run
  only on the `sqlite-atomic-batch` profile) is green and is NOT sensitive to
  either engine hunk — which falsification 2 below shows directly.

## 3. The hunk

```
 src/query-engine/raptor3/commands/commands.ts   | 35 +/- 9   (the builder, the `matched` failure, its doc)
 src/query-engine/raptor3/commands/execution.ts  | 14 +/-10   (the raise, and the comment it corrects)
 src/query-engine/raptor3/AGENTS.md              | 25 +       (the dated addendum)
 tests/providers/local/sqlite3-found-consumption.test.ts  | 151 +/- 1  (5 cells)
 tests/providers/docker/mysql2-found-consumption.test.ts  | 127 +      (3 cells)
```

- `commands.ts`: `failure(match: boolean)`, built once per condition INSIDE the
  loop, becomes `premiseChanged(subject)` hoisted out of it — one template, one
  meta, three subjects. The `conditions` record is built where a condition
  exists and carries `matched`: `probes[0].match` itself when there is exactly
  one (the same object, so the single-condition sentence cannot drift from the
  premise it belongs to), and the set sentence when there are more.
- `execution.ts`: `const conditional = command.conditions` and
  `conditional ? () => conditional.matched : …`. The selector arm, the read, the
  lock, the materialization and the fallback chain are untouched — `first` is
  still the probe whose selector the one-condition case reads, and `conditional`
  is the record that carries the failure. They are two bindings of one fact (a
  record exists where a probe does) because one reads a PROBE and the other
  reads the RECORD; collapsing them would buy an index assertion on `probes[0]`
  and no coverage.

## 4. What disappears

1. **The per-condition branch inside the sentence** (`${match ? "match" :
   "skip"}` in the template, and the `failure(true)` / `failure(false)` pair it
   served): one builder, one subject, no boolean that means two spellings.
2. **The owner's choice of WHICH failure to raise** (`first ? () => first.match`):
   `confirmFound` no longer reaches into the first probe. The guard that remains
   is the presence of a conditions record, which is the same fact it tested.
3. **The empty conditions record.** A root upsert carrying no condition no
   longer builds `{ probes: [], missingRow }` with an eager `NotFoundError` that
   nothing can raise: the record exists where a condition does. Every reader was
   already guarded by `probes.length` or `?.`, so no route's behaviour moves.

No test, branch or check is deleted or weakened anywhere; no recorded
expectation is re-expressed — every existing sentence assertion in the tree
(`sqlite3-found-consumption`, `mysql2-found-consumption`,
`transitions/conditional-upsert.ts`) is single-condition and keeps its exact
bytes.

## 5. A second applicable consumer

- **The batch route**, above: the same decision ("report what this statement
  measured") applied to premises stated one per condition keeps the per-field
  sentence exactly as it is. One rule, two truthful answers, and the difference
  is measured rather than asserted — falsification 2 turns the single-condition
  cells red while the batch corpus stays green.
- **The `skip` premise** is spelled by the same builder, so the family that
  already had two subjects now has three and no second place knows how an
  upsert's premise sentence reads.
- **The success side of the same shape** has two registered consumers, both
  green here: `tests/contracts/engine/query/nested-write-conformance-fk.test.ts`
  ("top-level upsert targetWhere+setWhere match runs the update branch", 28 / 28
  on PGlite) and the dual-condition guard in
  `tests/contracts/drivers/behaviors/nested-write-advanced-behavior.ts`
  (170 / 170 through `sqlite3-nested-write`).

## 6. Capability change

**None.** No valid operation becomes a refusal and no refusal becomes a success:
the uncontended pair commits its ordinary result (`count: 42`, one UPDATE, no
INSERT — the new credential-free control), the interactive route's round-trip
count is unchanged (one confirmation, pinned on both transports), and the
failure keeps its class, its code and its meta (`TransactionError`, V5001,
`{ model, operation }`, no `raceable`).

What changes is one SENTENCE, in one shape: a root upsert carrying BOTH
`targetWhere` and `setWhere`, both matched, whose premise a concurrent commit
changed before the confirmation. It read `… ${field} match premise changed
before the atomic batch.` naming the first condition; it now reads
`query-engine-v2 top-level upsert matched premise (targetWhere, setWhere)
changed before the atomic batch.` A caller matching on the old string for that
shape sees the new one; a caller matching on the single-condition strings sees
no change at all. The sentence is registered as a dated row in
`docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md`.

## 7. Registrations

| file | cells | project(s) |
| --- | --- | --- |
| `tests/providers/local/sqlite3-found-consumption.test.ts` | 5 → **10** | `provider-sqlite3` (glob) and `coverage-drivers` (directory scan) — 20 executions |
| `tests/providers/docker/mysql2-found-consumption.test.ts` | 12 → **15** | `provider-mysql2` (glob `tests/providers/docker/mysql2*.test.ts`) |

`scripts/raptor3-manifest.mjs` is **NOT** edited: neither file is
manifest-enumerated (`grep found-consumption` finds nothing in
`scripts/raptor3-manifest.mjs`, `scripts/driver-test-manifest.mjs`,
`scripts/credential-free-test-manifest.mjs` or `vitest.workspace.ts`), both
already run in their globbed projects, and no new file is added by this unit.

The five credential-free cells: first-only, second-only and both conditions
changing (each asserting the class, the code, the sentence, the absence of
`raceable`, the four-read statement census, no UPDATE and no INSERT of the
table, and the stored row); a `targetWhere`-only control that keeps its own
precise sentence, beside the file's existing `setWhere`-only control; and the
uncontended pair. The three native cells add the durable state (the other
transaction's value stands, this one wrote nothing) and the ONE-confirmation
pin.

## 8. Runs

One Vitest at a time; one docker file per invocation; the connection string was
substituted into each command from its file and never printed.

| run | result | receipt |
| --- | --- | --- |
| `sqlite3-found-consumption.test.ts`, production at BASE | **6 failed / 14 passed** (RED) | `01-red-at-base-sqlite.log` |
| `sqlite3-found-consumption.test.ts` | **20 / 20** (10 cells × 2 projects) | `02-sqlite-green.log` |
| `mysql2-found-consumption.test.ts`, production at BASE (native) | **3 failed / 12 passed** (RED) | `03-red-at-base-mysql.log` |
| `mysql2-found-consumption.test.ts` (native MySQL) | **15 / 15** | `04-mysql-green.log` |
| `transitions/conditional-upsert-{commands,legacy}` + `post-prep/selector-preparation` | **52 / 52** | `05-neighbours-credential-free.log` |
| `mysql2-concurrency-policy.test.ts` (native MySQL) | **11 / 11** | `05b-mysql-concurrency-policy.log` |
| `nested-write-conformance-fk.test.ts` (PGlite shard) | **28 / 28** | `06-nested-write-conformance-fk.log` |
| `providers/local/sqlite3-nested-write.test.ts` | **170 / 170** | `07-sqlite3-nested-write.log` |
| `atomic-unit-batch.core.test.ts` | **9 / 9** | `08a-atomic-unit-batch.log` |
| `upsert-envelope-parse-boundary.test.ts` | **6 / 6** | `08b-upsert-envelope.log` |

Every row above was measured on the FINAL bytes of this unit (the formatter ran
on `commands.ts` before them; see §9).

### Falsifications ([`receipts/14-falsifications.log`](receipts/14-falsifications.log))

Each applied to the working copy and restored by `cp` from `$TMPDIR`; no
`git checkout`, nothing staged.

| mutation | red — and ONLY this |
| --- | --- |
| `confirmFound` raises the first condition's failure again (`() => first.match`) | the three conjoined cells, both projects (6 / 20). Nothing else moves: the single-condition controls stay green, so the mutation is not detected by wording alone |
| the set sentence swallows the single condition (`probes.length === 0`) | both single-condition controls, both projects (4 / 64) — `setWhere`'s and `targetWhere`'s exact sentences. The conjoined cells stay green, and so do the 44 scripted `conditional-upsert` cells, which is the direct measurement that the BATCH route raises `condition.match` per premise and not this failure |

## 9. Typecheck, census, Biome

- **Typecheck**: `node scripts/run-typecheck.mjs` — **0 diagnostics, exit 0**,
  once, at the end of the unit
  ([`receipts/13-typecheck.log`](receipts/13-typecheck.log)).
- **Census**: `node scripts/raptor3-refusal-census.mjs` on the working tree
  ([`receipts/09-census-after.md`](receipts/09-census-after.md)) against
  `--at 88fe2814b` ([`receipts/09-census-base.md`](receipts/09-census-base.md)),
  both exit 0. The count tables are **byte-identical** — invariant 22 / 21,
  internal 11 / 11, inherited 75 / 75, candidate 30 sites / 23 distinct, rethrow
  56, **194 total sites** — and the two files differ only in the header and in
  line anchors. **The delta is zero, and that is a fact about the census, not
  about the sentence**: this family is BUILT at analysis and raised through a
  `DeferredFailure` (`throw failure()`), which the census reads as a rethrow, so
  neither the old per-field spelling nor the new set spelling has ever appeared
  in its counts. The new sentence is public all the same, so it is registered
  where the map lists sentences —
  `docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md`, a dated
  addendum row (R2-1) with the map's own columns. The inherited 75 were checked
  first for a sentence that already means "a matched requirement changed": the
  closest is this family's own per-field spelling, whose prefix and suffix the
  new sentence keeps.
- **Biome**: per changed file, against the base copies
  ([`receipts/11-biome-after.log`](receipts/11-biome-after.log),
  [`receipts/12-biome-base.log`](receipts/12-biome-base.log)) — **identical**:
  6 errors, `commands.ts` 2 and `execution.ts` 4, over the same five rules
  (`noParameterProperties` ×2, `useDefaultSwitchClause`, `noCommaOperator`,
  `organizeImports`, `noParameterAssign`), all pre-existing and none in a line
  this unit wrote; both test files clean. Formatting: neither `commands.ts` nor
  either test file carries a `format` diagnostic in its BASE copy, so the
  formatter was allowed and was run on `commands.ts` (the only file it wanted);
  the test files and `execution.ts` were already format-clean.

## 10. Cost

| perimeter | reference | before (T1 tip) | after | delta |
| --- | --- | --- | --- | --- |
| engine token lines (`scripts/query-engine-structure.mjs`) | 16,182 | 16,247 | **16,259** | **+12** |
| like-for-like | 20,040 | 20,105 | 20,117 (derived) | +12 |
| charged perimeter | 23,975 | 24,040 | 24,052 (derived) | +12 |

The engine row is MEASURED at both ends in this worktree by swapping the base
copies in and out ([`receipts/10-structure-before.log`](receipts/10-structure-before.log),
[`receipts/10-structure-after.log`](receipts/10-structure-after.log), the latter
re-measured on the final formatted bytes); the other two carry this unit's delta
only, because both `src/` files it touches are engine files inside both
perimeters. Per file (the same token-line measure): `commands.ts` 1,652 →
1,663, `execution.ts` 1,155 → 1,156. The measure skips JSDoc, so the doc comment
on `Choose["conditions"].matched` costs nothing here; the twelve are the widened
`conditions` type, the hoisted builder and the `matched` decision.

`git diff --numstat`, this unit's own files:

```
 35   9  src/query-engine/raptor3/commands/commands.ts
 14  10  src/query-engine/raptor3/commands/execution.ts
 25   0  src/query-engine/raptor3/AGENTS.md
151   1  tests/providers/local/sqlite3-found-consumption.test.ts
127   0  tests/providers/docker/mysql2-found-consumption.test.ts
 15   0  docs/architecture/raptor3-evidence/g4/release/closure-repair/g1/note.md
 28   0  docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md
```

plus this note, its receipts and the ledger record. Round trips: **unchanged**
on every route, verb and placement.

## 11. The guide, and the notes it corrects

- `src/query-engine/raptor3/AGENTS.md`: one dated addendum, placed beside the
  §1 addendum whose sentence it corrects ("so the failure is the first
  condition's"), naming the new sentence, the single-condition guarantee, the
  owner that decides it, the absence of an added round trip, and why the batch
  route keeps per-field attribution.
- `g4/release/closure-repair/g1/note.md` §1: a dated addendum recording that the
  cost it named is now paid honestly, and that §12's "no registered witness"
  bullet is closed.
- `g4/release/plan/refusals-map.md`: the dated row registering the sentence, with
  the census's blindness to this family stated at the row.

## 12. Unverified

- **Which condition actually changed is still not reported, and cannot be by
  this statement.** The repair makes the failure truthful, not more specific.
  Per-field attribution for a conjunction would need the conditions evaluated
  over the confirmed row rather than inside its `WHERE` (no adapter can project
  a predicate today) or a round trip per condition after the miss — which takes
  further locks after the answer, the thing the harmlessness argument for a
  missing confirmation rests on not doing. Both were declined by the prompt.
- **A conjunction of three or more conditions has no cell**, because the public
  surface admits exactly two (`targetWhere`, `setWhere`,
  `EngineSchema.admit`'s own loop). The builder joins whatever set it is given;
  nothing in it is written for two.
- **The nested placements of a conditional upsert are not in scope**: only the
  ROOT upsert carries conditions today (`Choose.conditions` is built in one
  place), so there is no nested witness to add.
- **PostgreSQL was not run by this unit.** No cell of this defect is
  PostgreSQL-shaped: the sentence is provider-neutral, built at analysis, and
  the confirmation it belongs to is one prepared selector through
  `Queries.select`. The PGlite conformance shard above exercises the Postgres
  dialect of the same shape's success side.
- **No wide runs**: the full `provider-mysql2`, `provider-sqlite3`,
  `coverage-*`, parity and conformance projects are the integrator's one frozen
  gate, not this unit's.

## 13. Blockers

None.

## 14. Commit message draft

```
fix(raptor3): a conjoined premise reports the requirement it lost, not the first condition it named

G1 made the found arm's confirmation ONE statement carrying every matched
condition, and named the cost it could not pay: the failure it raised was the
FIRST condition's, so an upsert carrying both `targetWhere` and `setWhere`
reported `targetWhere` when only `setWhere` had drifted. That is not a round
trip saved, it is a wrong answer — measured here on native MySQL and
credential-free SQLite, where a competing commit moved one matched column and
the refusal named the other.

The rule is that a failure reports what the statement that failed MEASURED. One
statement proved one premise — the conjunction of the probes that matched — so
what a miss loses is that premise: where several conditions were conjoined the
sentence now says a MATCHED REQUIREMENT changed and names them as a set
(`… matched premise (targetWhere, setWhere) changed before the atomic batch.`),
and where exactly one was matched the premise IS that condition, whose sentence
is unchanged byte for byte. The decision lives where the premises are built —
one builder for all three subjects of the family, and `Choose["conditions"]`
carries the confirmation's own failure — so `confirmFound` raises it and states
no diagnosis of its own. The BATCH route is untouched and stays per-field
exact, because there each condition is its own premise statement and naming the
one that disagreed is a fact that route measured.

No round trip is added: the confirmation is still one locked read, pinned as
such on both transports. No class, code or meta moves, no valid operation
becomes a refusal, and the empty conditions record a conditionless upsert used
to build disappears with the eager failure nothing could raise. Eight new cells
(five credential-free, three native) cover first-only, second-only and both
conditions changing — the error, the unchanged stored row, the absent consuming
write — beside single-condition controls for both spellings and the uncontended
pair. Census counts byte-identical (194 sites); the sentence is registered in
the refusals map, whose row states why this family has never been census-visible.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
