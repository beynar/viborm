# Release unit "n3" — independent re-check of the two BLOCKs (round 2)

Reviewer: independent (Opus), main tree `/Users/arnaud/code/viborm` on
`pattern-engine` @ `eca417a4e`, unit still uncommitted. Read: my own
`review.md` in full, the author's `note.md` in full, `receipts/repair/`,
`receipts/regress/` (`RESULTS.txt`, `cells-vs-n2-head.txt`), `receipts/numstat.txt`,
the plan's §3, `src/query-engine/raptor3/AGENTS.md`'s N3 paragraph,
`engine-unification/DESIGN.md` §7.3–§7.4, `ELEGANCE.md` §§5/6/8,
`g4/briefs/common.md`, and the live diff (`git diff -- src tests scripts`
plus the two untracked test files).

Nothing under `src/`, `tests/` or `scripts/` was edited, staged, committed or
reverted by me; my only write is this file. `TMPDIR=/private/tmp/viborm-n3-recheck-tmp`
for every run, one file per `run-vitest-safe` call, never two vitest processes
at once.

## Verdict: REVISE

**Both BLOCKs are closed, by reading and by measurement.** §1's raceable mark
is now lax-only and no other site marks the strict form raceable; §2's
position claim is bounded by the last registered premise exactly as specified.
Every measurement the brief asks for is green, at the numbers the note claims
(24, 4, 793/793, m8 4/4, typecheck 0).

What remains is four documentation corrections, one false clause in a new
`src` comment, and one overstated pin claim. No blocker. Resolutions R1–R6
below are exact and minimal; only R5 touches `src` (a comment), and only R6 is
optional.

---

## 1. §1's resolution — confirmed, and pinned

`relation-body.ts:258-260` sets the raceable failure under `if (lax)` alone:

```ts
if (lax)
  outgoing.retained = () =>
    membershipRaceFailure(verb, edge.name, "removed");
```

`lax === payload === true` is decided ten lines above (`:227`), so the guarded
branch can never carry a selector. For the strict form nothing assigns
`retained`, so `requireLookup`'s `lookup.retained ??= lookup.required`
(`:716`) supplies the non-raceable identity sentence — unchanged from HEAD.

**No other site marks the strict form raceable.** All three
`membershipRaceFailure` call sites: `relation-body.ts:260` (lax only),
`execution.ts:744` (`requireNoAddedMember`, "added"), `execution.ts:856` (the
series member's presence at capture). The only other `retained` assignment on
a lookup is the pre-existing `connectOrCreate` one (`relation-body.ts:528-533`,
byte-identical to HEAD) and it constructs a plain `NestedWriteError` — no
`raceable`. The remaining `raceable = true` marks in `raptor3/` (`execution.ts:131`
`onUpdate` occupancy, `operation-context.ts:2626` and `:2720` the singular
polymorphic membership, `commands.ts:1356` conditional skip) are all untouched
by this diff and none of them is the disconnect/delete target's premise.

The counter-example is now a cell: **"the strict form keeps its identity"**
(`lax-to-one.test.ts:156-203`) plants exactly my §1 probe — `pa` moved to `u2`
and stripped of `slug: "x"`, `pb` given `slug: "x"` and left under `u1` — then
`delete: [{ slug: "x" }]`, and requires the registered refusal, `meta.raceable
=== undefined`, **one** batch, and the three rows intact. That is the HEAD row
of my §1 table, written as absolute values, not as "whatever the engine does".
It is green (measured below), and it is red under the blocked first shape (that
is where I measured `B` deleted in 2 batches).

## 2. §2's resolution — the bound is exactly as specified; the fold differs in one respect

**The bound.** `operation-context.ts:1249-1275` is my resolution, line for
line: `providerIndex` from `error.meta.statementIndex`, `rejectedIndex =
providerIndex ?? attributedIndex`, and

```ts
let positionBound = rejectedIndex;
if (providerIndex === undefined && typeof attributedIndex === "number") {
  let last = -1;
  for (const [index, statement] of statements.entries())
    if (assertionFailures.has(statement)) last = index;
  positionBound = last;
}
```

with `rejectedBeforeAnyWrite` now testing `index > positionBound`. Read against
HEAD: for a provider-indexed rejection the computation is unchanged; for an
unattributable abort `rejectedIndex` stays `undefined` and the claim is refused
as before (the m8 floor keeps its uncertainty); the only new way to reach the
claim is the re-probe path, and there it is bounded by the last premise.

**The fold.** I asked to "fold `batchMayContainAssertionCollision` into the
re-probe branch, or say in the note why it is not needed there". The integrator
folded the *sole guard* into the walk's condition
(`present !== assertion.present || soleGuard`, `:1234-1246`).

*Equivalent for the sentence.* `soleGuard` implies `assertionFailures.size ===
1`, so the walk visits exactly one assertion statement; "the first changed
premise" and "the sole guard" are then the same statement, the same
`failure`, and the same one re-probe read. The old two-step (walk, then
fallback) and the new disjunct pick the identical error in every case. No
`indexOf`, no non-null assertion, one walk. I do not ask for a different
shape.

*Not equivalent for the position claim.* The collision predicate now gates only
the `soleGuard` disjunct. When a premise genuinely changed, the walk attributes
it without asking whether an ordinary statement in this batch could have
arrived as the assertion class — and that attribution now decides commit
certainty. The residual shape is `P… W W(colliding)`: all premises lead (so
`every` passes with `positionBound` = the last premise), a premise has since
changed, and the statement that actually failed is a *write* further down, with
another write committed ahead of it. `rejectedBeforeAnyWrite` is then true for
a batch that did dispatch a write.

**Does it matter?** Not on anything shipped, today. The only drivers with
`supportsBatch = true` are D1 (`drivers/d1/index.ts:156-157`) and Neon HTTP
(`drivers/neon-http/index.ts:136-137`), and both are atomic — D1's `batch()`
and Neon's `transaction()`, as the fixture now models — so nothing survives the
abort for the claim to be wrong about. The exposure is latent: it needs a batch
transport that is non-atomic *and* reports no statement index, which is exactly
the class D-53 says owes a per-driver witness. So this is not a blocker, and
the optional hardening is R6.

**The comment's justification is not sound, though, and that part I do ask
for.** `:1257-1260` says:

> "A colliding ordinary statement is a WRITE: ahead of the last premise it
> defeats the claim; behind it, it is the statement that failed, and nothing
> after it ran."

The first half is true (`every` fails). The second half answers the wrong
question: what defeats the claim is what ran *before* the colliding statement,
not after it — and statements between the last premise and the collision are
writes that did run. See R5.

## 3. The retained comment I called false — now true of the code

`:1227-1233`:

> "Fresh-state diagnostics after rollback refine the error, not its original
> statement index: a premise found false NOW may have held when the batch ran
> (state moved on between the abort and the re-probe, DESIGN §7.3 step 4), so
> the position they name is a sentence, and the position claim below is bounded
> by the LAST premise instead."

Checked against every consumer of the re-probe's index: `attributedIndex` feeds
`rejectedIndex`, whose surviving uses are (a) the `typeof rejectedIndex ===
"number"` existence test and (b) the initial value of `positionBound`, which is
overwritten by `last` on exactly the branch the comment describes. So the
re-probe's position is never used as a claim about the past. The comment is
now a true description. Accepted.

## 4. DESIGN §7.3 step 4, and the two registries — corrected

- `note.md` §2, `AGENTS.md` (the new N3 paragraph) and the `staleness.ts`
  comment (`tests/raptor3/transitions/staleness.ts:214-217`) all now say
  **§7.3 step 4**. Verified against `DESIGN.md:985-1008`: step 4 is the typed
  fallback and its own parenthesis is "state moved on between abort and
  re-probe" — the exact condition the note leans on. §7.4 is the retry wrapper.
- `AGENTS.md` now names which registry owns which case: "a lookup's own
  `Selection.retained`, which `runSelection` asserts on the spot, and
  `attempt.retained` for a row bound by `capture()` (a series member, the
  connect path) whose premise its owner queued directly." That is the sentence
  I asked for, and it matches `execution.ts:284-288`, `:451`, `:862`.
- `AGENTS.md` also states the lax/strict split and D-34 explicitly.

## 5. The §9 corrections — four of five landed; one recurs, and two docs still carry the blocked rule

Applied and verified: the §7.3 citation (item 3); the hunk list's disclosure of
the lax/strict split (item 4 — `note.md` §3 now names it, with the measured
reason); the reach-vs-firing wording for the Docker lane (item 5 — `note.md`
§5: "route-independent in REACH … even though they fire only on the batch
route"); the single fixed-stage figure (item 2 — §3 carries `793 / 793 (758 +
35: 6 + 1 + 24 + 4)`, §4 defers to `receipts/repair/`, which says 793).

Not applied, or newly introduced:

- **`note.md:102` still miscounts the lax pin: "the lax pin 21 / 21 on three
  transports".** The file has 8 cells × 3 routes = **24**, which is what the
  same note says in §3 (`6 + 1 + 24 + 4`), what `G4_PARITY_COUNTS` registers,
  what `receipts/repair/pins.log` printed, what `g4.md` says ("pins 24 + 4"),
  and what I measured. This is §9 item 1 recurring with a different wrong
  number. **R1.**
- **The plan's "3 as landed" paragraph states the rule I blocked as if it
  landed** (`docs/architecture/raptor3-nesting-and-refusals-plan.md:187-188`):
  "(3b) attribution comes first and the attributed premise's position decides
  the uncertainty where the provider reports none". Where the provider reports
  no index the attributed premise's position decides *nothing*; the claim is
  bounded by the last premise. The same paragraph's "`retained` on the deletion
  lookup" (`:190`) also omits the lax-only restriction that `note.md` and
  `AGENTS.md` now disclose. **R2.**
- **`g4.md:2858` repeats the blocked formulation** ("attribution first with the
  attributed premise's position deciding the uncertainty") in its "Landed:"
  clause; the paragraph's later "Resolutions applied exactly" sentence states
  the bound correctly, so the ledger contradicts itself about what the unit
  does. And **`g4.md:2864` keeps "the lax pin 12 / 12"** — the number §9 item 1
  corrected: the file was 18/18 on three routes when I reviewed the first
  shape. **R3.**

## 6. The fixture — its documented claim now matches its behaviour

`batch-only-drivers.ts` `BatchOnlyDriver.executeBatch` now runs `BEGIN`, the
batch, `COMMIT`, and `ROLLBACK` on any throw, with `supportsTransactions =
false` and `supportsBatch = true`. So it is an atomic native batch presented to
the engine as a weak one — which is what D1's `batch()` and Neon's
`transaction()` are, and the header says exactly that. Claim and behaviour
agree; the D-53 fidelity objection in my §2 is answered for these two
transports.

`NoIndexBatchOnlyDriver` rethrows a **fresh** `NestedWriteAssertionError`
(floor message, original as `cause`), so `meta.statementIndex` is absent; and
the base's post-hoc index recovery cannot put one back, because
`findUniqueExecutionContextIndex` (`drivers/driver-diagnostics.ts:26-51`)
returns `undefined` for a VibORM error with no trusted execution context
whenever there is more than one candidate statement. The "no index" property
holds end to end.

**One consequence the note should own.** Making the fixture atomic removes the
mechanism of my §2 counter-example: the batch's own writes can no longer
survive its abort, so on neither fixture driver can the re-probe now see a
premise that this batch falsified. That is the right fidelity choice — but it
means the unit ships the position bound with no cell that can tell whether it
is there. See §7 and R4.

## 7. The two counter-example cells — faithful; one does not discriminate

**"The strict form keeps its identity"** (`lax-to-one.test.ts:156-203`). Encodes
my §1 counter-example with HEAD-outcome expectations: the registered refusal by
message, `meta.raceable === undefined`, `batchCalls === 1`, and the full row
triple list `[["pa","u2",null],["pb","u1","x"],["po1",null,null]]`. Nothing in
it is phrased as "what the implementation returns". It discriminates: under the
blocked shape it fails on all three of those assertions.

**"A premise placed after a write keeps its uncertainty … no statement index"**
(`:205-236`). Same payload as my §2 counter-example, expectations at the HEAD
outcome (rejects, `batchCalls === 1`, `user` not renamed, `p1.userId === "u1"`).
As an end-to-end pin it is fine. As an instrument for the position bound it is
not, and the note names it as one twice (`note.md` §2 and the §3 hunk list).
Derivation (from the statement order I measured in round 1, `P0 P1 W2 W3 P4 W5
read`, which neither resolution moves):

1. the fixture is now atomic, so `W2`/`W3` roll back and `P0`, `P1` probe true
   again; only `P4` (the deleted connect target) differs, so the walk attributes
   index **4** — which is also the last registered premise, so `positionBound
   === attributedIndex` and the new branch computes nothing new;
2. `every(index > 4 || isAssertion)` is false anyway, because statements 2 and
   3 are writes — so `rejectedBeforeAnyWrite` is false with or without the bound;
3. and after §1's resolution the attributed failure is the connect lookup's
   non-raceable not-found, so no recovery could be granted even if it were true.

All three assertions therefore hold with the `positionBound` branch deleted.
**R4** asks for one sentence or one cell — not both.

**No existing cell is weakened.** The only edit to a pre-existing cell is
`slug: null` added to a `deepEqual` (forced by the new model field, and one key
stricter). The strict-selector cell still addresses by `id`, so the new unique
column does not change what it means. The whole file gained a third transport,
which strengthens the six older cells. The `staleness.ts` re-expression is the
one I accepted in round 1 (§3) and is unchanged.

## 8. Nothing else moved

`git status` shows precisely the unit: modified `commands.ts`, `execution.ts`,
`relation-body.ts`, `operation-context.ts`, `AGENTS.md`, `lax-to-one.test.ts`,
`staleness.ts`, `raptor3-manifest.mjs`, `credential-free-test-manifest.mjs`,
the plan, `g4.md`, `n2/note.md`; untracked `tests/raptor3/g4/parity/batch-only-drivers.ts`,
`tests/raptor3/g4/parity/series-member-premise.test.ts`, `g4/release/n3/`. No
other file under `src/`, `tests/` or `scripts/` is modified or new
(`git status --untracked-files=all -- src tests scripts`). The unrelated dirty
and untracked files (`CONTEXT.md`, `memory.md`, the pre-G4 evidence archives,
the root corpus JSONs) are untouched by me. `receipts/numstat.txt` matches the
live `git diff --numstat` for `src`/`tests`/`scripts` line for line.

## 9. Exact minimal resolutions

- **R1** (`note.md:102`): "the lax pin 21 / 21" → **24 / 24**.
- **R2** (plan `:187-190`): replace "the attributed premise's position decides
  the uncertainty where the provider reports none" with the landed rule — where
  the provider reports no index the re-probe's answer is a sentence and the
  "nothing but premises ahead" claim is bounded by the LAST premise in the
  batch — and write "`retained` on the deletion lookup **for the lax form**".
- **R3** (`g4.md:2858`, `:2864`): same correction to the "Landed:" clause, and
  "the lax pin 12 / 12" → **18 / 18** (the first shape's file on three routes).
- **R4** (`note.md` §2 and §3, or one new cell): either drop the claim that
  "a premise placed after a write keeps its uncertainty" pins the bound —
  saying instead, in §5, that the bound narrows the unit's own behaviour and
  that no cell discriminates it because the fixture is atomic — or add the cell
  that does. The cheapest discriminating shape: a batch whose FIRST premise is
  raceable and falsifiable by the plant, with a write before a LATER premise
  (e.g. a lax `profile: { delete: true }` plus a `posts: { connect: [...] }`,
  plant re-parenting the profile); bounded, the claim is refused and the
  operation surfaces the race sentence, unbounded it converges in two batches.
  Confirm the statement order first — the claim is only worth pinning if the
  later premise really follows a write.
- **R5** (`operation-context.ts:1257-1260`): correct the second half of the
  colliding-statement sentence. What defeats the claim is a write *before* the
  failing statement, not after it; behind the last premise a collision is not
  covered by the `every` test at all, and the reason the unit tolerates that is
  that both shipped batch transports (D1, Neon) are atomic — say that instead.
- **R6** (optional, `src`): if the tolerance in R5 should not be left to the
  transports' atomicity, hoist the predicate once and refuse the bound when an
  ordinary statement could arrive as the assertion class:
  `const mayCollide = batchMayContainAssertionCollision(statements, this.driver.dialect);`
  → `soleGuard = assertionFailures.size === 1 && !mayCollide;` and
  `positionBound = mayCollide ? undefined : last;`. Two lines, no new owner, no
  policy boolean; `typeof positionBound === "number"` already refuses the claim.

## 10. What I ran

`TMPDIR=/private/tmp/viborm-n3-recheck-tmp`, one file per call, sequentially.

| command | result |
|---|---|
| `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/lax-to-one.test.ts` | **24/24** per project (48 across `raptor3` + `coverage-raptor3`), exit 0 |
| `node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/series-member-premise.test.ts` | **4/4** per project (8 across both), exit 0 |
| `pnpm test:all --only "Raptor 3 fixed"` | **793 / 793**, 69 files, exit 0 |
| launcher `tests/query-engine/shared/query/m8-race-retry.test.ts` | path does not exist — "No test files found" |
| launcher `tests/contracts/engine/query/m8-race-retry.test.ts` (the path `git ls-files` gives) | **4/4**, exit 0 |
| `node scripts/run-typecheck.mjs` | exit 0, **0 diagnostics** |
| `git diff -- src tests scripts`, `git status --untracked-files=all -- src tests scripts`, `git diff --numstat` vs `receipts/numstat.txt` | as §8 |

Probes: **§1's identity probe was not re-run ad hoc — it is now the pin cell
"the strict form keeps its identity", which I ran and which is green.** §2's
stale-attribution probe **cannot** be re-run against the repaired unit: its
mechanism was a committed write surviving the abort, and the fixture is now
atomic (§6). I did not build a non-atomic variant, because doing so would have
meant writing under `tests/`.

## 11. Unverified

- The Docker provider lanes (MySQL 3307, PG 5434) were not run, as in the note.
- I did not re-run the author's whole estate comparison, the core lane (8,434),
  the coverage lanes (88 / 91.19 / 90.9 / 88) or `coverage:policy`; I read
  `receipts/regress/RESULTS.txt` and `cells-vs-n2-head.txt` and they agree with
  the note's prose (140 → 137 failing cells, 0 newly red, 3 newly green, 3
  moved).
- `nested-m2m-parent-pk-dataflow` and the two conformance families were not
  re-run in this round; round 1 reproduced them.
- The positionBound derivation in §7 is an argument from a measured statement
  order plus the fixture's new atomicity, not a fresh execution. I did not
  falsify it by deleting the branch, because that would have meant editing
  `src/`.
- The collision residual in §2 is read from the code and from the driver
  inventory; I did not construct a driver that is both non-atomic and
  index-free to fire it.
- I did not survey the pre-existing raceable membership premises outside this
  diff (`operation-context.ts:2626`, `:2720`, `execution.ts:131`) for the
  identity question §1 asks; they are unchanged by the unit, so nothing here
  turns on them.
- Neon HTTP and D1 still have no transport witness of their own; the position
  rule stays unqualified for them under D-53, as the note says.
