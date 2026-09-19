# Family: atomic-output — triage note

Read-only classification. Repo `/Users/arnaud/code/viborm`, branch `pattern-engine`,
HEAD `7bc08ebd9` (+ uncommitted `src/query-engine/raptor3/shared/decimal.ts`, not
touched). Every file below was run with
`TMPDIR=/private/tmp/viborm-triage-atomic-tmp node scripts/run-vitest-safe.mjs --project extended-local <file>`;
raw stdout for each run is kept at
`/private/tmp/viborm-triage-atomic-tmp/<file-stem>*.log`. No edits made anywhere
in the repository.

**32 red cells measured across the 9 family files: 28 class B (B-open), 4 class C.
Zero class A, zero class D.**

## Table

| file | cell | class | reason | ruling / registration / engine site |
|---|---|---|---|---|
| compound-relation-adoption.test.ts | E4-U2 … (atomic batch) > every referenced column takes its own value, and the decoy owns nothing | B-open | root `article`-style create needs a produced/auto-increment id threaded into a junction/FK row inside one PGlite atomic batch; throws before writing | refusals.json (msg match, current site operation-context.ts:2318-2319); see "Class B" below |
| create-junction-upsert.test.ts | (atomic batch) FOUND: the target is updated AND the join row is written | B-open | same produced-identity-in-atomic-batch throw (root `article.id` is `.increment()`) | same registration |
| create-junction-upsert.test.ts | (atomic batch) FOUND with an EMPTY update payload still adopts | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) FOUND with a RELATION-ONLY update payload adopts and writes the child | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) ABSENT: the created target's PRODUCED id reaches the join row and its grandchildren | B-open | same, plus the topic's own produced id | same |
| create-junction-upsert.test.ts | (atomic batch) a LITERAL parent key takes the same two branches | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) M7: two upsert items are refused even with DISJOINT selectors | B-open (masks a class-C gap, see cell 29) | throws atomic-output before the M7 dependency check ever runs | same |
| create-junction-upsert.test.ts | (atomic batch) upsert + connect naming ONE row joins it exactly once | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) upsert + create naming DIFFERENT rows writes both memberships | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) the WHOLE-TARGET update arm runs, and only on the located row | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) a relation-carrying update arm named by a NON-primary-key unique runs | B-open | same | same |
| create-junction-upsert.test.ts | (atomic batch) the ABSENT arm still creates, with the update arm's deeper edge unapplied | B-open | same | same |
| fresh-create-subtree.test.ts | X1b mechanism 2 (batch): the produced id threads to the grandchild | B-open | same shape, 2-level fresh subtree | same |
| fresh-create-subtree.test.ts | X1b mechanism 1 (batch): the generated author identity folds into the fresh post | B-open | same | same |
| generated-output-fallback.test.ts | one demanded member closes RETURNING over a fresh compound generated row key | B-open | compound generated PK (`tenantId`,`recordId`) on PGlite atomic batch | same |
| junction-produced-identity.test.ts | (atomic batch) the create arm's produced id reaches BOTH the join row and the grandchildren | B-open | same shape | same |
| junction-produced-identity.test.ts | (atomic batch) a multi-entry array gives each item its OWN produced id | B-open | same | same |
| junction-produced-identity.test.ts | (atomic batch) connectOrCreate: the second item adopts the FIRST item's produced row | B-open | same | same |
| junction-produced-identity.test.ts | (atomic batch) the upsert create arm rides the same produced identity | B-open | same | same |
| junction-upsert-arm-probe.test.ts | (atomic batch) UPDATE root: the WHOLE-TARGET arm delegates against the captured key, both arms | B-open | same | same |
| located-target-depth.test.ts | batch: the generated badge id folds into the level-3 member SET, native Observed | B-open | same, depth-3 located update | same |
| located-target-depth.test.ts | batch: six levels, fresh + located mixed, one boundary | B-open | same, 6-level tree | same |
| type-depth-ceiling.test.ts | batch: a 40-level rich create chain folds and persists, native Observed | B-open | same, 40-level chain | same |
| nested-mutation-routing.test.ts | PGlite batch-only routing batch primary-key dataflow > generated parent ID feeds to-many child FK | B-open | same, shared `runBatchPrimaryKeyDataflowBehavior` | same; this is the exact contract D-46 and round3 both name |
| nested-mutation-routing.test.ts | … > generated parent ID feeds nested createMany child FKs | B-open | same | same |
| nested-mutation-routing.test.ts | … > generated child ID feeds to-one parent FK | B-open | same | same |
| nested-mutation-routing.test.ts | … > generated parent ID feeds multiple sibling relation branches | B-open | same | same |
| nested-mutation-routing.test.ts | … > generated parent, child, and grandchild IDs flow through recursive create | B-open | same | same |
| create-junction-upsert.test.ts | (transaction) M7: two upsert items are refused even with DISJOINT selectors | C | guard at `program.ts:388-398` skips the conflict throw whenever a known literal field DISAGREES with the selector, so disjoint selectors (`name:"left"` vs `name:"right"`) are let through instead of refused; test asserts `.rejects.toThrow(...)`, gets a resolved promise | no registration found for this message/site; see "Class C" §1 |
| generated-output-fallback.test.ts | a nested generated key and relation-supplied publication stay in one native batch | C | `commands.ts:449` `assignMembership` does not see `account.providerId` as "known" when it is supplied by a NESTED `provider: {connect:{id:...}}`, even though that value is a construction-time literal | no registration found; see "Class C" §2 |
| junction-produced-identity.test.ts | (transaction) skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8) | C | `expected [2] to deeply equal [2, -1]`: the fresh row's join membership is missing from the result set | no registration found; see "Class C" §3 |
| junction-produced-identity.test.ts | (atomic batch) skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8) | C | throws `Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.` (`operation-context.ts:502`) instead of the E6.8-adopt result the transaction arm is also supposed to produce | no registration found; see "Class C" §3 |

## Class A

None. No cell in this family pins a physical-plan shape (SQL text/CTE fold/alias) with an equivalent shipped-engine result; every red is either an outright refusal (B) or a wrong/missing result (C).

## Class B — the 28 "atomic output" cells

**The registration.** `docs/architecture/raptor3-evidence/g4/root-review-C-receipts/refusals.json`:
```
{
 "msg": "Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING",
 "sites": ["src/query-engine/raptor3/shared/operation-context.ts:1471"],
 "needle": "Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING",
 "shippedHits": []
}
```
`refusal-census.txt` lists the same site/message as `Error inherited`.
`newness.json` marks it `"atBaseline": true` (the throw site itself predates G4,
not a new-in-G4 addition — confirmed by `git blame`: `b2daea1156`, 2026-09-12,
before any of the receipts below). The site has drifted with the file
(`:1471` → `:1837` in round3 → current HEAD `:2318`-`:2319`); I confirmed by
running the tests that today's throw is the identical message at the identical
logical guard.

**The guard, read in full** (`src/query-engine/raptor3/shared/operation-context.ts:2310-2320`):
```
if (this.insertIdField(model, produced) === undefined || !references.storeLastInsertId) {
  if (!adapter.capabilities.supportsReturning || adapter.capabilities.supportsCteWithMutations)
    throw new Error("Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING");
  // The next segment must prove the actual stored owner, including supplied row-key fields.
  ... (segmented-RETURNING implementation follows)
```
`src/adapters/databases/postgres/postgres-adapter.ts:561-562` declares
`supportsReturning: true, supportsCteWithMutations: true` — PGlite uses this
adapter. So for every PGlite/Postgres-family driver the second condition is
always true, and the segmented-RETURNING code immediately below the throw is
dead for this family: it is never reached by a CTE-capable adapter. Direct
evidence this is avoidable, not structural: `generated-output-fallback.test.ts`'s
first (passing) test manually sets
`driver.adapter.capabilities.supportsCteWithMutations = false;` before calling
`create()`, and that test resolves — the identical shape, on the identical
PGlite driver, succeeds the moment that one capability flag is forced false.

**Whether a ruling accepted the loss.** No. Every prior unit that has hit this
exact refusal family has recorded it as unresolved, independently, on four
separate occasions across the G4 program:
- `docs/architecture/raptor3-evidence/g4/cutover-execution-review-round3.md:106-107`
  (round 3, Docker pg lane): "Every one dies with `Error: Raptor 3 G1 atomic
  output requires exact identity scratch or segmented RETURNING`."  — recorded
  as an unrecorded compatibility loss, escalated to Arnaud.
- `docs/architecture/raptor3-evidence/g4/parity/integration-note.md:222-225`:
  "the five `pg batch-only batch primary-key dataflow` cells (…) — red at the
  pre-parity base, **named by no unit of the plan**."
- `docs/architecture/raptor3-evidence/g4/rulings/note.md:490-493`: same five
  cells, same wording, "**untouched here**."
- `docs/architecture/raptor3-evidence/g4/release/d46/note.md:20-27` (D-46,
  the most recent and most directly on-point: same integrator role as this
  triage): "the create arm then hit the registered G1 refusal … because a
  record arm's generated key travels through the identity scratch and the
  terminal read-back, which a batch-only transport without segmented RETURNING
  cannot carry — **the same family as the five registered kept-red pg
  cells**." D-46 fixed a narrower, different defect (the upsert array route's
  planning-read ownership) and explicitly left this family red, by name.

None of the four is a ruling that accepts the loss — each states the refusal is
known, registered, and undecided. Per the brief's rule ("a refusal without a
ruling for this shape is B-open"), all 28 cells in this table are **B-open**.

**Corroborating but non-binding design text.** `src/query-engine/raptor3/AGENTS.md:729-733`:
"A multi-statement write as an array member on a batch-only driver is
PACKAGED and committed, not refused. The shipped route's insertId-scratch
refusal is retired… Do not re-introduce that refusal in the route." This reads
as directly on-point, but its subject is "array member" writes (the
`$transaction([...])` array-route packaging D-46's note also discusses), and I
could not confirm from source alone that it covers a single (non-array)
nested-write client call compiled to multiple statements under an atomic-batch
driver — the exact shape these 28 cells exercise. I flag it for Arnaud rather
than use it to reclassify: it is suggestive that the design intent was for
this family to succeed, not refuse, but it is not a clean, on-shape ruling the
way D-46's note is.

**Why the retired engine is the baseline for "refuses a shape the retired
engine executed."** `docs/architecture/raptor3-evidence/g4/unit03/receipts/shipped-shared-family*.log`
show 7 of this family's 9 files green with the exact same test counts as
today's runs (compound-relation-adoption 4, create-junction-upsert 26,
located-target-depth 8, junction-produced-identity 12, type-depth-ceiling 2,
generated-output-fallback 5, nested-mutation-routing 72) when unit03 ran them
at commit `0cc61e61` (2026-09-14) — `fresh-create-subtree.test.ts` and
`junction-upsert-arm-probe.test.ts` do not appear in unit03's receipts at all,
so this specific corroboration covers 7/9 files, not all 9 (all 9 file
contents are confirmed byte-identical between `0cc61e61` and HEAD, `git diff
0cc61e61f..HEAD -- <file>` empty for every one, including the two shared
behavior files, so there is no reason to expect those two behave differently).
That commit is **before** `e8114ed9d "cut over to the Raptor 3 engine
(C-01)"`, and every one of these files drives its client through the plain
`createClient` from `@client/client` (`tests/fixtures/drivers/pglite.ts:1,132`,
also unchanged since before `0cc61e61`). Before C-01, `createClient`'s default
route was the retired engine, so those green receipts are the retired engine
passing this exact shape, not raptor3. After C-01, `pnpm test:all` never
reaches the `extended-local shared-family` stage (the finding's premise), so
nobody re-ran these files against raptor3 until now — which is exactly what
today's run shows failing. This is consistent, not contradictory, with the
finding.

## Class C — 4 defects, no ruling or registration found

**§1 — M7 DISJOINT-selector upsert guard doesn't fire (transaction mode).**
Reproduction: `client.article.create({ data: { title: "two-disjoint", topics: {
upsert: [{ where: {name:"left"}, create:{name:"left"}, update:{weight:1} },
{ where:{name:"right"}, create:{name:"right"}, update:{weight:2} }] } } })`
against a `(transaction)`-mode PGlite client
(`tests/contracts/engine/write/create-junction-upsert.test.ts`, via
`create-junction-upsert-behavior.ts:392-420`). Expected:
`.rejects.toThrow("Nested operation 'upsert' on relation 'topics' depends on
an earlier 'upsert' target write…")`; observed: resolves. Suspected owner:
`src/query-engine/raptor3/program/program.ts:388-398` — the conflict check
does `if (known.some((field) => literal(field) !== selector[field])) continue;`,
which SKIPS (does not refuse) whenever a known literal field disagrees with
the new node's selector — i.e. it treats provably-disjoint selectors as
provably non-conflicting and lets both upserts through. The overlapping-selector
sibling test (`M7: two upsert items on one relation are refused`) passes,
confirming the guard fires only for the equal/unknown case, not the
disjoint one the test insists on. The test's own inline comment ("it is the
WALL this unit did not move: the preflight classifies a second `upsert` … by
its FOOTPRINT, not by whether the two selectors can name one row") documents
the INTENDED contract (footprint-based refusal regardless of overlap) — the
code as read implements a narrower, overlap-aware refusal instead. I found no
registration for this message/site in the refusal census, and no g4.md/rulings
entry naming "DISJOINT" or "M7". The `(atomic batch)` twin of the same test
is masked (cell 7 above): it hits the class-B atomic-output throw before ever
reaching this check, so fixing that refusal first would surface this same gap
there too.

**§2 — nested-connect-supplied FK not recognized as "known" (SQLite, not
PGlite).** Reproduction:
`tests/contracts/engine/write/generated-output-fallback.test.ts`, describe
`"generated output exact batch scratch"`, using
`BatchOnlyNonReturningSQLiteDriver` (this specific cell is SQLite, not the
family's PGlite theme, but it is still one of the 9 files' red cells).
`client.badge.create({ data: { id:"badge", account: { create: { provider: {
connect: { id: "provider" } } } } }, select: {...} })` throws
`UnsupportedOperationError: query-engine-v2 create cannot resolve the parent id
for relation 'account': referenced field 'providerId' is neither this
record's primary key nor a knowable value in its own create data.` Despite the
"query-engine-v2" text, this is raptor3's own message (source at
`src/query-engine/raptor3/commands/commands.ts:449`, `assignMembership`) —
that string is raptor3's own historical label convention (also used at
`commands.ts:456` and `:1317`), not a call into retired code, so this is not
class D. `account.providerId` is the local FK for `account.provider`
(`.fields("providerId").references("id")`); it is populated by the nested
`provider: {connect:{id:"provider"}}`, a construction-time literal (provider's
`id` is `s.string().id()`, not generated) — so the value looks knowable in
principle, but `producer.known(referenced)` at `commands.ts:437` apparently
does not see values supplied via a nested connect on the SAME create as
"known" before the sibling `badge → account` edge is assigned. No registration
found at `commands.ts:449` in the refusal census. Suspected owner:
`commands.ts:427-450` (`assignMembership`)'s known-value propagation ordering.

**§3 — skipDuplicates E4-U3 × E6.8 adopt-equivalence, two different symptoms.**
Both in `tests/contracts/engine/write/junction-produced-identity.test.ts` ›
`"skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 ×
E6.8)"` (`junction-produced-identity-behavior.ts:313-351`):
`client.post.create({ data: { id:"p6"/"p5", stamps: { createMany: { data:
[{name:"sitting"},{name:"arriving"}], skipDuplicates:true } } } })` against an
existing `stamp` named "sitting". The test's own comment says this shape was
"RETARGETED by U-E6.8 (maintainer-authorized)" — a decision recorded in
`docs/architecture/expressible-shapes-plan.md` ("E6.8: adopt-equivalence
defines skip for generated-key junction createMany rows as authorized …
single-nameable-unique rows rewrite as the connectOrCreate adopt") for the
RETIRED engine, well before raptor3. Whether raptor3 carries the equivalent
logic is unverified (see Unverified). Observed:
- (transaction) resolves, but `AssertionError: expected [2] to deeply equal
  [2, -1]` — the fresh "arriving" row's own membership id is missing from the
  join-row list; only the adopted row's id (`2`) comes back.
- (atomic batch) throws `TransactionError: Raptor 3 borrowed createMany
  skipDuplicates requires an operation-owned member rollback region.`
  (`src/query-engine/raptor3/shared/operation-context.ts:502`) — a different,
  unregistered refusal (no hit in refusal-census.txt/refusals.json for this
  message or site).
Suspected owner: whatever composes E6.8's adopt-rewrite with the
generated-key createMany path in raptor3 — not located precisely within
budget; flagged rather than guessed.

## Class D

None found in this family. The only class-D-shaped candidate (the
"query-engine-v2" text in commands.ts error messages) is raptor3's own
error-message convention, not a call into retired `write-engine` or
`query-engine-v2` code — verified by reading `commands.ts:449,456,1317`
directly, all inside `src/query-engine/raptor3/`.

## Unverified

- `nested-mutation-routing.test.ts` (1945 lines) cannot be run as one
  `run-vitest-safe.mjs` call: it deterministically exceeds the 1536 MiB
  process-group RSS ceiling even alone (observed 1542-1604 MiB across 5
  attempts, including once with a 5-test `-t` filter). I split it into 5
  `-t`-filtered sub-runs (batches of 10-23 tests) that together named 68 of
  the 72 tests the runner reports; all 63 non-dataflow tests I could name
  passed, and the 5 named dataflow tests all failed with the class-B refusal
  (table rows above). I could not individually name and confirm the remaining
  ~4 tests (my static `grep -oP 'test\("..."'` plus the shared behavior's 11
  titles account for 68, not 72); no batch run showed any failure beyond the
  known 5, and every batch's skip+run count summed to 72, so I have moderate
  confidence the remaining tests pass, but did not isolate them by name.
  Logs: `/private/tmp/viborm-triage-atomic-tmp/nmr-batch{1,2,3a,3b}.log`,
  `nested-mutation-routing-dataflow.log`.
- The retired engine was never run directly by me against these 9 files; "the
  retired engine executed this shape" for the class-B cells is inferred from
  unit03's pre-C-01 green receipts plus four independent unit notes
  characterizing the same refusal as a loss relative to the engine replaced —
  not from a fresh run of retired code.
- Whether raptor3 implements E6.8's "adopt-equivalence" rewrite at all (Class
  C §3) — I read the retired-engine plan describing the feature but did not
  locate its raptor3 owner (or absence) within budget.
- Whether AGENTS.md:729-733's "array member… PACKAGED and committed, not
  refused" design statement is meant to cover the single-call, atomic-batch
  shape these 28 B-open cells exercise, or only `$transaction([...])` array
  members specifically (D-46's narrower topic). Flagged, not resolved.
- Did not search beyond this family's 9 files for other instances of the M7
  DISJOINT-selector gap (Class C §1) or the nested-connect known-value gap
  (Class C §2); `rulings/note.md` independently confirms the class-B refusal
  recurs in at least 4 more files outside this family
  (`pglite-bulk-writes.test.ts` ×9, `pglite.test.ts` ×5,
  `pglite-nested-writes.test.ts` ×4, `pglite-scalars.test.ts` ×5) — worth
  Arnaud knowing this family's fix would likely clear those too.

## Blockers

- None blocked classification. The RSS ceiling on `nested-mutation-routing.test.ts`
  was worked around by filtering (see Unverified); one test-run lock refusal
  was hit and cleared by waiting 20s and retrying, per the brief.
- The 4 class-C cells have no registration to cite; classification rests on
  direct source reading plus an exhaustive text search of
  `docs/architecture/raptor3-evidence/g4/**` and `refusal-census.txt` /
  `refusals.json` / `newness.json` / `unmatched.json` for each cell's
  message and site, all negative. Arnaud may hold an out-of-band decision on
  any of these three that is not in the evidence tree.
