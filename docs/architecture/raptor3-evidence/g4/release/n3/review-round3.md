# Release unit "n3" — independent round-3 re-check

Reviewer: independent (Opus), main tree `/Users/arnaud/code/viborm` on
`pattern-engine` @ `eca417a4e`, unit still uncommitted. Read, in order:
`review-round2.md` (my predecessor's REVISE, R1–R6), `review.md` (round 1),
`note.md` whole, `receipts/round2/` (`RESULTS.txt`, `falsify-unbounded.log`,
`pins.log`, `fixed.log`, `biome-oc.log` vs `biome-oc-head.log`, the coverage
logs, `round2-runs.sh.txt`), `src/query-engine/raptor3/AGENTS.md`'s ladder
paragraph, the plan's "3 as landed" paragraph, the ledger's N3 entry,
`ELEGANCE.md` §§5/6/8/10, `g4/briefs/common.md`, and the live diff
(`git diff -- src tests scripts docs/architecture/raptor3-nesting-and-refusals-plan.md`)
plus the two untracked test files.

Nothing under `src/`, `tests/` or `scripts/` was edited, staged, committed,
reverted or stashed by me; my only write is this file. My one ad-hoc probe
lives entirely under `TMPDIR=/private/tmp/viborm-n3-recheck3-tmp` (a private
vitest workspace whose single project's `include` is that directory — the
repo's own `server.fs.allow` already admits `tmpdir()`), so no file was added
to the repository. One vitest process at a time, one file per call.

## Verdict: REVISE

**R1, R3, R4, R5 are closed; R6's declination is sound and I do not ask for
the refusal.** The new cell is faithful and it does discriminate the bound —
I confirmed its claimed statement order myself, and the falsification receipt
is exactly what it says it is. Every measurement is green at the note's
numbers (27 / 54, 796 / 796, 0 diagnostics), Biome is HEAD-identical, and
nothing outside the unit moved.

**R2 is half-closed and introduced one false clause.** The plan's "3 as
landed" paragraph now states the bound and the lax-only `retained` correctly,
but its same sentence also claims the position claim is "not made at all
where an ordinary statement could arrive as the assertion class" — which is
R6, the refusal the integrator **declined**. The plan therefore asserts a
guard the code does not have. That is the same defect class round 2
corrected (a document stating a rule that did not land), inverted. One
clause, one line. **R7** below.

---

## 1. R1 — the counts (closed)

`note.md` carries the lax pin as **27 / 27** in both places (§4 line 120 "the
lax pin 27 / 27 on three transports"; §4's Round 2 paragraph line 198
"27 / 27 (54 across the two projects)"), and the fixed stage once, as
**796 / 796 (758 + 38: 6 + 1 + 27 + 4)** (§3 line 114), repeated as
"796 / 796 (758 + 38)" in §4. `6 + 1 + 27 + 4 = 38`; `758 + 38 = 796`. A scan
of `note.md` for the superseded figures (`21`, `24`, `793`, `758 + 35`)
returns nothing.

The file really is 27: **9** `it(` cells × **3** routes
(`lax-to-one.test.ts:76, 90, 104, 121, 131, 156, 205, 238, 290`; four of them
return early on the routes they do not address, which is a pass, not a skip —
the registered count stays 27). `scripts/raptor3-manifest.mjs:1354` registers
`"tests/raptor3/g4/parity/lax-to-one.test.ts": 27`. Measured: 27 per project,
54 across `raptor3` + `coverage-raptor3`; fixed stage 796 / 796 over 69 files.

Round 1's observation stands unchanged and is still fine: `G4_PARITY_COUNTS`
has no consumer but `Object.keys` — the numbers are a record, not a checked
fact. They are currently exact.

## 2. R2 — the plan states a guard that does not exist (the one finding)

`docs/architecture/raptor3-nesting-and-refusals-plan.md:187-193` now reads:

> (3b) attribution comes first, and where the provider reports no index the
> re-probe's answer is a sentence: the claim "nothing but premises ahead of
> the rejection" is bounded by the LAST premise in the batch, **and not made
> at all where an ordinary statement could arrive as the assertion class**;
> and the premise about a captured member is asserted where the observation
> is taken — `retained` on the deletion lookup for the LAX form (the strict
> form keeps its identity sentence, D-34) …

The two things R2 asked for are there: the re-probe's answer is a sentence,
the claim is bounded by the LAST premise, and `retained` is qualified **for
the LAX form**. The emphasised clause is not.

In the landed code `batchMayContainAssertionCollision` has exactly one use in
this file (`operation-context.ts:1234-1236`), and it gates only the
`soleGuard` disjunct of the walk:

```ts
const soleGuard =
  assertionFailures.size === 1 &&
  !batchMayContainAssertionCollision(statements, this.driver.dialect);
…
if (present !== assertion.present || soleGuard) { failure = …; attributedIndex = index; break; }
```

So in a colliding batch the *other* disjunct still attributes whenever a
premise has since changed, `rejectedIndex` becomes a number, `positionBound`
becomes the last premise, and `rejectedBeforeAnyWrite` can be true. The claim
**is** made where an ordinary statement could arrive as the assertion class.
That is precisely the residual round 2 described in its §2 and the note owns
in §2 ("the round-2 review's optional refusal … was declined"), and it is
what `operation-context.ts:1254-1263` and `AGENTS.md` both disclose. The plan
is the only document in the estate that now denies it, and it is the
normative one.

**R7** (exact, one line). Either delete the clause, or restate it as the fact
that is true — it is the *sole-guard attribution*, not the position claim,
that collision suppresses:

> … is bounded by the LAST premise in the batch; the sole-guard attribution
> is not made at all where an ordinary statement could arrive as the
> assertion class; and the premise about a captured member …

Nothing else in the plan's paragraph needs to move.

## 3. R3 — the ledger (closed)

`g4.md`'s N3 entry:

- the "Landed:" clause now states the landed rule and only it — "attribution
  first, and where the provider reports no index the claim of no write ahead
  of the rejection bounded by the LAST premise in the batch (the re-probe's
  answer is a sentence)". No collision clause, so the ledger does not repeat
  the plan's error;
- "`retained` on the deletion lookup **for the lax form** (the raceable
  `membershipRaceFailure`, one sentence owner; the strict form keeps its
  identity sentence)";
- "the lax pin **18 / 18** with the re-parented cell" for the first shape
  (6 cells × 3 routes — the file as I reviewed it in round 1), and "pins
  27 + 4 cells green on three transports, fixed 796 / 796" for the repaired
  one. The "12 / 12" is gone;
- round 2's outcome is recorded as its own sentence — REVISE, R4's
  non-discriminating cell named as the reason, the discriminating cell and
  its falsification, R1–R3 and R5 restated, R6 declined with the residual
  disclosed — and the entry still ends **"Re-check pending."** for this round
  to close.

## 4. R4 — the new cell: faithful, and it discriminates

`lax-to-one.test.ts:238-288`, on the `NoIndexBatchOnlyDriver` route only.

**(a) Its expectations are the contract's.** The rejection is matched by the
registered sentence, not by whatever the engine produces: `NestedWriteError`
with message *"Cannot delete relation 'profile': a member was removed after
the plan-time read; retry to converge."* — character for character the string
`membershipRaceFailure` owns (`commands/commands.ts:149-160`, which also sets
`meta.raceable = true`), instantiated for `verb = "delete"`, `edge =
"profile"`, `change = "removed"`. The rest are absolute post-conditions of
the transport's rollback, written as values: **one** batch
(`batchCalls === 1`, so no recovery attempt), `user.findMany()` deep-equal to
`[{id:"u1",name:"Owner"},{id:"u2",name:"Other"}]` (u1 **not** renamed),
`profile.findMany()` deep-equal to `[{id:"pr1",userId:"u2"}]` (the plant's
placement kept, the delete did not happen), and `p3.userId === null` (the
connect did not happen). Nothing is phrased as "what the implementation
returns".

**(b) The claimed statement order is exact — measured.** I did not take the
comment's word for it. An ad-hoc probe under my TMPDIR (a `ProbeDriver`
subclassing the unit's own `NoIndexBatchOnlyDriver`, recording each
`executeBatch`'s `queries` before dispatch) replayed the cell's world,
payload and plant and printed the composition. Exactly **one** batch, of
seven statements, in this order:

| # | statement |
|---|---|
| 0 | PREMISE `n2_users` (`__viborm_assert__`, the parent's own row) |
| 1 | PREMISE `n2_profiles` (the captured member's retention) |
| 2 | **WRITE** `UPDATE "n2_users"` (the rename) |
| 3 | PREMISE `n2_posts` (the connect target) |
| 4 | **WRITE** `UPDATE "n2_posts"` (the connect) |
| 5 | **WRITE** `DELETE FROM "n2_profiles"` |
| 6 | READ `n2_users` (the returning read) |

which is the comment's "P(user) P(profile member) W(users) P(post) W(posts)
W(delete profile) read", verbatim. The probe also shows the ladder's walk:
after the abort it re-reads the users premise (present → continue) and then
the profiles premise (absent → attribute, break) and never reaches the posts
premise — `attributedIndex = 1`.

That makes the discrimination mechanical, not argumentative:
`positionBound = last premise = 3`; statement **2 is a write at index ≤ 3**,
so `statements.every(index > positionBound || isAssertion)` is false and the
claim is refused. Unbounded, `positionBound = rejectedIndex = 1` and
statements 0 and 1 are both premises, so the claim holds, D-25's one recovery
is granted, the operation re-plans and the rejection disappears. This is the
first cell in the unit where the two settings differ.

**(c) The falsification is what it says.** `receipts/round2/round2-runs.sh.txt`
copies `operation-context.ts` aside, asserts the string `positionBound =
last;` occurs exactly once, replaces it with `positionBound = rejectedIndex;
// FALSIFICATION: unbounded`, runs **that file only**, then restores from the
copy and `cmp`s — `RESULTS.txt` records `restored: identical`.
`falsify-unbounded.log` shows `27 tests | 1 failed` in **both** projects,
both failures named `… > a raceable premise ahead of a write, with a later
premise behind that write, …`, both `AssertionError: Missing expected
rejection.`, totals `Tests 2 failed | 52 passed (54)`. "Missing expected
rejection" is the right red: unbounded, the operation succeeds. The live
source carries the bound — `operation-context.ts:1264-1270` is
`let positionBound = rejectedIndex; … positionBound = last;` — and
`grep -rn FALSIFICATION src/ tests/ scripts/` returns nothing. My own run of
the file is 27 / 27 per project.

R4 is closed, and the note's §2 now correctly demotes the round-1
counter-example ("it does not discriminate the bound, because on the atomic
fixture the attributed premise IS the last one") while keeping it as the
end-to-end pin. One detail in the same parenthesis is not receipted: "the
operation re-plans and converges in two batches". The falsified run dies at
`assert.rejects`, before `batchCalls` is read, so the receipt proves the
recovery is granted, not that it converges in exactly two. Listed as
unverified; no change asked.

## 5. R5 — the ladder's comment is now true of the code

`operation-context.ts:1254-1263`:

> Where the provider said where it stopped, that is the position. Where only
> the re-probe did, the claim "nothing but premises ahead" must hold for ANY
> premise that could have fired — the last one in the batch … What the bound
> cannot see is an ordinary statement arriving as the assertion class BEHIND
> the last premise, with writes dispatched ahead of it: on the shipped
> index-free transports (D1, Neon) the batch is atomic, so nothing survives
> that abort; a transport that is neither atomic nor indexed owes its own
> witness (D-53) before the claim is made there.

Checked clause by clause against the `every` test. A write at index ≤
`positionBound` fails it, so a colliding statement *ahead of* the last
premise cannot reach the claim — the round-2 objection to the old second half
("behind it … nothing after it ran") is answered. A colliding statement at
index > `positionBound` is outside the test entirely, and the only writes
that could have been dispatched before it are the ones between the last
premise and it — exactly "BEHIND the last premise, with writes dispatched
ahead of it". The sentence names the residual correctly and no longer
justifies it by the wrong question.

The inventory backing it is real: `grep -rn supportsBatch src/drivers/` gives
two `= true` drivers, **D1** (`d1/index.ts:157`) and **Neon HTTP**
(`neon-http/index.ts:137`). D1's override calls `client.batch(statements)`
under the comment "Execute all statements atomically" (`d1/index.ts:272`);
Neon's calls `client.transaction(…)` (`neon-http/index.ts:289`). Both are
native single-call batches, so the provider index is only ever recovered
post-hoc by `findUniqueExecutionContextIndex`, which refuses when more than
one statement is a candidate — "index-free" is accurate for them; the
sequential fallback in `driver-transaction-base.ts:658-772` is the path that
carries a real `statementIndex`, and it is not theirs.

One refinement, offered as a note and not as a resolution: on **D1** the
bound cannot change any outcome at all, because the uncertainty it feeds is
additionally gated by `!this.driver.supportsOrderedCommittedSegments` and D1
sets that flag `true` (`d1/index.ts:158`). **Neon HTTP is the only shipped
transport where the bound decides anything.** The comment is not wrong, only
wider than it needs to be; `AGENTS.md`'s paragraph carries the same sentence
and the same scope.

## 6. R6 — declining is right, and I do not ask for the refusal

I read the predicate and the inventory.

`FOREIGN_ASSERTION_SIGNATURE` (`src/drivers/error-mapping.ts:78-82`) is
`postgresql: /[/%]/`, `mysql`/`sqlite`: `/json|->/i`, and
`batchMayContainAssertionCollision` returns true on the first non-assertion
statement whose SQL text matches. On PostgreSQL that is a character test over
raw SQL, and the engine does emit `/` in ordinary statements: `integerDivide`
is `(${left} / ${right})` and a non-exact `divide` mutation is
`${column} = ${column} / ${by}` (`postgres-adapter.ts:281`, `:461`). So
`positionBound = mayCollide ? undefined : last` would, on Neon HTTP — the one
shipped transport where the bound decides — forfeit D-25's recovery for any
batch that happens to contain a division.

The guard it would buy protects a transport that is **neither atomic nor
indexed**, and no such transport ships: the only two batch transports are D1
and Neon, both atomic. ELEGANCE §5's "for each guard, name the distinct
failure or boundary it alone owns" cannot be satisfied — the failure it alone
owns has no shipped occurrence — and §10 ("do not create … extension hooks
for imagined consumers"; prefer moving a decision to its rightful owner)
puts the guard where D-53 already puts it: in the unit that brings such a
transport, beside that transport's own witness. The declination is consistent
with both, and with the estate's standing rule against a check whose unique
coverage cannot be named. The residual is disclosed in three places (the src
comment, `AGENTS.md`, `note.md` §2), which is what an owed obligation looks
like here.

I found no shipped transport that needs the refusal now, so it must not land
now.

Two precision points on the *rationale* (not on the decision, and neither
worth a round):

- `note.md` §2 writes "a LIKE pattern **or** a division would forfeit the
  recovery on Neon". The division half is right; the LIKE half is not. The
  PostgreSQL adapter binds the pattern as a parameter — `${column} LIKE
  ${pattern} ESCAPE '\'` and `${column} LIKE ${`${escapeLikeLiteral(value)}%`}
  …` (`postgres-adapter.ts:194`, `:232`) — so a `contains` filter's `%` lands
  in the parameter list, never in the SQL text the predicate scans. Dropping
  "a LIKE pattern or" would make the sentence exactly true.
- `note.md` §2's declination sentence and the typed-floor sentence that
  follows it are joined by "; then the uncertainty; then, for a raceable
  premise, the recovery mark; and, when nothing is attributed, the typed
  floor …". The ladder's ordered list has lost its head to the interpolated
  paragraph and now reads as a continuation of the declination. Cosmetic.

## 7. Biome — identical to HEAD, six and six

`receipts/round2/biome-oc.log` and `biome-oc-head.log` (HEAD's file copied to
`.oc-head-probe.ts`) both end "Found 6 errors", and the categories are the
same six, in the same order:

| # | rule | unit | HEAD copy |
|---|---|---|---|
| 1 | `assist/source/organizeImports` | `:1:1` | `:1:1` |
| 2–5 | `lint/style/noParameterProperties` ×4 | `:312:5 :314:5 :315:5 :325:5` | `:310:5 :312:5 :313:5 :323:5` |
| 6 | `format` | whole file | whole file |

The two-line offset is the unit's two added import lines. I re-ran both
checks live: `npx biome check src/query-engine/raptor3/shared/operation-context.ts`
→ the same six, "Found 6 errors";
`npx biome check tests/raptor3/g4/parity/lax-to-one.test.ts` → clean, no
findings. Round 1's "five for this file" omitted the assist; the note's
"HEAD's six diagnostics (the import-order assist, four
`noParameterProperties`, the pre-existing format diagnostic)" is exact. The
HEAD probe copy is gone from the tree.

## 8. Nothing else moved

`git status --untracked-files=all --porcelain -- src tests scripts` is
precisely the unit and nothing more: modified `scripts/credential-free-test-manifest.mjs`,
`scripts/raptor3-manifest.mjs`, `src/query-engine/raptor3/AGENTS.md`,
`commands/commands.ts`, `commands/execution.ts`, `commands/relation-body.ts`,
`shared/operation-context.ts`, `tests/raptor3/g4/parity/lax-to-one.test.ts`,
`tests/raptor3/transitions/staleness.ts`; untracked
`tests/raptor3/g4/parity/batch-only-drivers.ts` and
`series-member-premise.test.ts`. Outside those three trees the unit's
documents are the plan, `g4.md`, `n2/note.md` and `g4/release/n3/`.
`git diff --numstat -- src tests scripts` matches `receipts/numstat.txt` line
for line (9 rows, `3/0, 15/0, 36/0, 42/7, 25/6, 15/0, 91/53, 168/7, 5/4`).
The two untracked test files are unchanged since round 2 (mtimes 02:49 and
02:09, both before the round-2 review at 03:17; the round-2 repairs are
03:21–03:27). §1's resolution is still intact in the live source —
`relation-body.ts:247-260` (comment and guard) assigns `retained` under `if (lax)` alone, with
the D-32/D-34 comment. The unrelated dirty and untracked files (`CONTEXT.md`,
`memory.md`, `exa-results/`, the root `transport-*-corpus.json`, the pre-G4
evidence archives) are untouched by me.

## 9. Resolutions

- **R7** (`docs/architecture/raptor3-nesting-and-refusals-plan.md:190-191`) —
  the one required change. Remove "and not made at all where an ordinary
  statement could arrive as the assertion class" from the position-claim
  sentence, or move it onto the thing it is true of (the sole-guard
  attribution), as spelled in §2 above. As written the plan asserts the
  declined R6 refusal as landed.
- **R8** (optional, `note.md` §2) — drop "a LIKE pattern or" from the
  declination rationale: on PostgreSQL the pattern is a bound parameter, so
  only the division case is real. The conclusion does not change.

The ledger's "Re-check pending" closes with this round once R7 lands: R1,
R3, R4, R5 confirmed, R6 correctly declined, R2 confirmed except the clause
R7 removes.

## 10. What I ran

`TMPDIR=/private/tmp/viborm-n3-recheck3-tmp` for every run, one file per
call, sequentially, never two vitest processes at once.

| command | result |
|---|---|
| `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/lax-to-one.test.ts` | **27 tests per project**, 54 across `raptor3` + `coverage-raptor3`, 2 files passed, exit 0 |
| `pnpm test:all --only "Raptor 3 fixed"` | **796 / 796**, 69 files passed, exit 0 |
| `node scripts/run-typecheck.mjs` | exit 0, **0 diagnostics** (6.48 s, 4.6 GiB peak) |
| ad-hoc probe: `node scripts/run-vitest-safe.mjs run --workspace /private/tmp/viborm-n3-recheck3-tmp/probe.workspace.ts` | the new cell's batch composition, §4(b) — 1 batch, 7 statements, P P W P W W read; rejection message = the registered race sentence; exit 0 |
| `npx biome check src/query-engine/raptor3/shared/operation-context.ts` | Found 6 errors — 1 assist, 4 `noParameterProperties`, 1 format |
| `npx biome check tests/raptor3/g4/parity/lax-to-one.test.ts` | clean |
| `git status --untracked-files=all --porcelain -- src tests scripts`, `git diff --numstat -- src tests scripts` vs `receipts/numstat.txt`, `git diff -- … plan` | as §8 |
| `grep -rn supportsBatch src/drivers/`, `grep -rn batchMayContainAssertionCollision src/`, `grep -rn FALSIFICATION src/ tests/ scripts/` | two batch drivers (D1, Neon); one use in this file, gating `soleGuard`; no marker left behind |

The probe's two files are `/private/tmp/viborm-n3-recheck3-tmp/probe.workspace.ts`
and `probe-order.test.ts`, its output `/private/tmp/viborm-n3-recheck3-tmp/probe-order2.log`.
They are outside the repository by construction; nothing was written under
`src/`, `tests/` or `scripts/`.

## 11. Unverified

- The Docker provider lanes (MySQL 3307, PG 5434) were not run, as in the
  note and in both earlier rounds.
- I did not re-run the estate comparison, the core lane (8,434), the coverage
  lanes (88 / 91.19 / 90.9 / 88) or `coverage:policy`. I read
  `receipts/round2/RESULTS.txt` and the round-2 coverage logs and they agree
  with the note's prose; `receipts/regress/cells-vs-n2-head.txt` is round 2's
  evidence, unchanged.
- `series-member-premise.test.ts`, `uncertain-outcome-meta` and
  `m8-race-retry` were not re-run this round (round 2's receipts show 4 / 4,
  8 / 8 and 4 / 4; the unit's source has not moved since).
- "the operation re-plans and **converges in two batches**" (`note.md` §2):
  the falsified run proves the recovery is granted, not the batch count — the
  cell fails at `assert.rejects` before `batchCalls` is read.
- I did not re-run the falsification myself; deleting the bound means editing
  `src/`. I verified the recipe, the single-occurrence assertion, the
  byte-identical restore, the log's two failures and the live source instead,
  and I derived the same outcome independently from the measured statement
  order.
- The collision residual is read from the code, the predicate and the driver
  inventory. I did not build a transport that is both non-atomic and
  index-free to fire it — that is the witness D-53 owes.
- Neon HTTP and D1 still have no transport witness of their own, so the
  position rule stays unqualified for them, as the note says. My claim that
  D1 cannot be affected by the bound at all rests on reading
  `supportsOrderedCommittedSegments` at `d1/index.ts:158` against the
  uncertainty branch; it is not measured.
- I did not re-survey the pre-existing raceable premises outside this diff
  (`operation-context.ts:2626`, `:2720`, `execution.ts:131`); they are
  unchanged by the unit.
