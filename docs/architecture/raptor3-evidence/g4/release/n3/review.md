# Release unit "n3" — attribution and the premise's position (independent review)

Reviewer: independent (Opus), main tree `/Users/arnaud/code/viborm` on
`pattern-engine` @ `eca417a4e`, unit uncommitted. Read first: the author's
`note.md` and `receipts/` (including `receipts/probes/`), the plan's §3
(`docs/architecture/raptor3-nesting-and-refusals-plan.md`), the external
review's point 3 (`../plan/review-external.md`), the N2 review's finding 1
(`../n2/review.md`), `ELEGANCE.md` §§5/6/8, `g4/briefs/common.md`,
`engine-unification/DESIGN.md` §7.3–§7.4, and the retired floor
(`git show 5a37bcd7:src/query-engine/batch-error-attribution.ts`).

Nothing under `src/`, `tests/` or `scripts/` was edited. Every falsification
and every statement probe ran in a scratch detached worktree at `HEAD`
(`/private/tmp/viborm-n3-verify-base`, its own `TMPDIR`), removed afterwards;
the reviewed tree's `git status` is byte-for-byte what the brief describes.
`TMPDIR=/private/tmp/viborm-n3-review-tmp` for every run in the main tree.

## Verdict: BLOCK

Two defects, both **measured**, both in `src/`. The first (§1) loses a row the
caller never addressed, on every batch transport, without an error. The second
(§2) is the one the brief asked about: the unit's position claim is false, and
the counter-example is an ordinary payload on the unit's own fixture driver.
Everything else in the unit — the floor, the premise placement, the shared
sentence, the manifest registration — is correct and is accepted (§3–§7).

Exact minimal resolutions are given, and both were applied in the scratch
worktree and measured: with both in place the unit's two new pins stay green
(22/22) and the raptor3 fixed stage is 758/758 on the HEAD manifest.

---

## 1. BLOCKER — a strict nested `delete` / `disconnect` now deletes a DIFFERENT row

`relation-body.ts:249-253` sets the raceable membership-race failure as the
lookup's `retained` for **both** payload forms:

```ts
outgoing.retained = () => membershipRaceFailure(verb, edge.name, "removed");
```

`membershipRaceFailure` sets `meta.raceable = true` (`commands.ts:150-158`),
and a raceable premise is exactly what authorises D-25's one recovery
(`operation-context.ts:1288-1309` → `recoveryRejection` `:1386` →
`batchAttempt` `:872-882`, which re-runs `body()`: a **fresh plan over the same
admitted arguments**, re-reading the payload's selector).

For the lax form (`delete: true`) the payload names no selector, so the re-plan
binds whatever the slot holds — that is the intended converge and it is right.
For the **strict** form the payload names a selector, and another row can
answer it. `captured()` (`selection.ts:195-211`) scopes the premise to the
captured row's identity, but the recovery does not: it re-reads the selector.

**Measured** (scratch worktree, `BatchOnlyDriver` and `NoIndexBatchOnlyDriver`,
one parent `u1`, post `A` with unique `slug: "x"` connected; the plant moves
`A` out of the set and inserts a different post `B` that takes `slug: "x"` and
is connected to the same parent; payload
`user.update({ where: { id: "u1" }, data: { posts: { delete: [{ slug: "x" }] } } })`):

| | error | batches | rows after |
|---|---|---|---|
| HEAD | `NestedWriteError: Cannot delete relation 'posts': target record was not found for this parent.` | 1 | `A(slug old, unlinked)`, **`B` intact** |
| unit | *(no error — the operation succeeds)* | 2 | `A(slug old, unlinked)` — **`B` deleted** |

Identical on both drivers, so this does **not** depend on the statement index,
on §2's position rule, or on a weak batch: it is the `raceable` mark alone and
it reaches every batch transport (PGlite/PostgreSQL, SQLite, MySQL, D1, Neon).
A registered refusal (inventory G, "target record was not found for this
parent") is replaced by a silent deletion of an unaddressed row.

This is the one thing the ladder's own retained comment forbids, five lines
below the code that now authorises it (`operation-context.ts:1300-1307`):

> "A non-raceable premise — the captured row's own presence — is a statement
> about IDENTITY: re-planning it would retry against whatever row now answers
> the selector, which is the one thing a captured-row replacement must not do."

It is also `ELEGANCE.md` §6 read exactly backwards: "identity differs from
membership". The lax form's loss is a *membership* fact; the strict form's is
an *identity* fact, and the unit gives both the membership sentence and the
membership mark.

**Minimal resolution** (applied and measured): mark the race only where the
payload names no selector; let `requireLookup`'s existing
`lookup.retained ??= lookup.required` (`relation-body.ts:709`) keep supplying
the non-raceable identity sentence for the strict form.

```ts
// relation-body.ts, replacing :252-253
if (lax)
  outgoing.retained = () => membershipRaceFailure(verb, edge.name, "removed");
```

`lax === true` implies a to-one edge (admission allows only `true`/`false`
there — the N2 review §3 established this by reading and by execution), so the
lax branch can never carry a selector. With this change the probe above returns
to the HEAD row set and the HEAD refusal, and `lax-to-one.test.ts` 18/18 and
`series-member-premise.test.ts` 4/4 both stay green (measured).

If Arnaud wants the strict form to *say* "removed after the plan-time read"
rather than "not found", that is a separate, legitimate ELEGANCE §6 decision —
but the sentence and the retry authorisation are two facts, and only the
sentence may change without the identity hazard.

---

## 2. BLOCKER — the position rule claims more than the position proves

`operation-context.ts:1219-1259` makes the re-probe (and the sole guard)
supply `attributedIndex`, and `:1258-1269` feeds it to `rejectedIndex`, whose
only consumer is `rejectedBeforeAnyWrite` — which alone decides whether
`mayHaveCommittedSegment` is set, hence `committedProgress`, hence whether
D-25's recovery is allowed at all.

The claim, in the code and in `AGENTS.md`:

> "a batch aborts at its first failing statement, so a rejection attributed to
> a premise with nothing but premises ahead of it dispatched no write."

The conditional is sound. The antecedent is not established, because the
re-probe is a **fresh-state** answer about the present, used as a statement
about the past. Three sources of drift, all named by the estate itself:

- `DESIGN.md` §7.3 step 3 defines the re-probe as producing "the first failing
  premise's `failure.error()`" — a *sentence*; step 4 names "state moved on
  between abort and re-probe" as an expected condition.
- The retired floor's own header states the blindness class verbatim: "a
  premise broken by a SIBLING statement inside the same batch is restored by
  that rollback and probes clean".
- The unit's own retained comment, one line above the code that now takes an
  index from it: *"Fresh-state diagnostics after rollback refine the error, not
  its original statement index."* That comment is now false.

And the base comment the unit builds on justified the whole inference on the
condition the unit removes: "a batch that rejected AT A PREMISE, with nothing
but premises ahead of it, dispatched no write at all, **and the provider said
where it stopped**."

**Premises after writes are ordinary, not exotic.** Measured statement order
(scratch worktree, unit applied, `BatchOnlyDriver`; `P` = premise):

| payload | batch |
|---|---|
| `{ name, profile: { delete: true } }` | `P0 P1 W(update user) W(delete profile) read` |
| `{ name, profile: { update: … } }` | `P0 W(update user) **P2** W(update profile) read` |
| `{ name, posts: { update: { where, data } } }` | `P0 W **P2** W read` |
| `{ name, posts: { disconnect:[p1], connect:[p3] } }` | `P0 P1 W W **P4** W read` |
| `{ tags: { deleteMany: {} } }` (junction series) | batch1 `P P P P P W`, batch2 `P W` |

So the unit's own shapes are fine (all premises lead), but the general shape is
`… write … premise …`, and a mis-attribution to an early premise then claims
"no write dispatched" for a batch that aborted after writes.

**Measured counter-example** (scratch worktree, `NoIndexBatchOnlyDriver` — the
unit's own fixture; payload
`user.update({ where: { id: "u1" }, data: { name: "Renamed", posts: { disconnect: [{ id: "p1" }], connect: [{ id: "p3" }] } } })`,
plant deletes `p3`):

- The batch is `P0 P1 W2 W3 P4 W5 read`; it aborts at `P4` (the connect
  target is gone). The per-statement trace shows execution stopping exactly
  there.
- `BatchOnlyDriver`/`NoIndexBatchOnlyDriver` take the **native** batch path
  (`driver-transaction-base.ts:810-905`) with **no transaction wrapper**
  (`supportsTransactions = false`), so `W2` and `W3` commit. The data proves
  it: `user.name = "Renamed"`, `p1.userId = NULL`.
- The re-probe walks in order and finds `P1` false **because this batch's own
  `W3` falsified it**, and attributes index 1.
- `rejectedBeforeAnyWrite` is therefore `true` (statements 0 and 1 are
  premises), `mayHaveCommittedSegment` is suppressed, and the recovery is
  granted: the trace goes from 17 statements at HEAD to **19 under the unit**,
  the two extra being the re-plan's planning reads. HEAD refuses the recovery
  here.

So the unit re-plans on top of committed effects — against `DESIGN.md` §7.4's
own precondition for a rerun ("A rerun re-probes from clean committed state —
**full rollback preceded it**"), and against `ELEGANCE.md` §8: the ladder *can*
compute a position from the re-probe; that capability is not authority to
decide commit certainty, which belongs to the transport boundary.

A second, transport-independent variant needs no weak batch: a concurrent
writer falsifying an earlier premise in the window between the abort and the
re-probe produces the same mis-attribution. That window is exactly the race
these premises exist for.

**Fixture fidelity (D-53).** `batch-only-drivers.ts` documents
`NoIndexBatchOnlyDriver` as standing for "D1's batch and Neon's transaction",
but those two are atomic and this fixture is not, and atomicity is the single
property the position rule depends on. Under D-53 — in this plan's own
revision 2 — session lifetime, failure attribution and commit certainty are
transport facts with their own per-driver witnesses; a driver without one stays
unqualified. The unit generalises a position rule to every shipped batch
transport on the strength of one SQLite fixture that does not share the
property. The pins are still worth having; the *rule* needs either a witness
per transport or a formulation that does not depend on the transport fact.

**Minimal resolution** (applied and measured): when the index came from the
re-probe or the sole guard, the "no write ahead" claim must hold for **any**
premise that could have fired — i.e. for the last premise in the batch, not the
attributed one. One extra bound at the same site; no new owner, no policy
boolean.

```ts
// operation-context.ts, replacing :1258-1269
const providerIndex =
  isVibORMError(error) && typeof error.meta.statementIndex === "number"
    ? error.meta.statementIndex
    : undefined;
const rejectedIndex = providerIndex ?? attributedIndex;
// A re-probed position is a fresh-state answer: any registered premise could
// have been the one that fired, so the claim must hold for the LAST one.
let positionBound = rejectedIndex;
if (providerIndex === undefined && typeof attributedIndex === "number") {
  let last = -1;
  for (const [index, statement] of statements.entries())
    if (assertionFailures.has(statement)) last = index;
  positionBound = last;
}
const rejectedBeforeAnyWrite =
  typeof rejectedIndex === "number" &&
  typeof positionBound === "number" &&
  this.committedSegments === 0 &&
  statements.every(
    (statement, index) =>
      index > positionBound || assertionFailures.has(statement)
  );
```

Measured with this in place: the counter-example returns to the HEAD outcome
(17 statements, no recovery); `lax-to-one.test.ts` 18/18,
`series-member-premise.test.ts` 4/4, raptor3 fixed 758/758 (HEAD manifest).
Both of the unit's shapes keep their converge behaviour because in both of them
every premise leads.

Also fold `batchMayContainAssertionCollision` into the re-probe branch, or say
in the note why it is not needed there: the sole-guard branch checks it
(`:1247-1251`) precisely because an ordinary statement can arrive as the
assertion class, and a colliding write is a failing *write*, which the position
rule must not silently treat as a premise. This mattered only for the sentence
before; it now decides commit certainty.

---

## 3. Accepted — the floor is exactly the retired one, and the re-expression is legitimate

`operation-context.ts:1310-1323` constructs
`new NestedWriteError(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE, "", { code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED, cause: error })`.
Compared field by field with `5a37bcd7:src/query-engine/batch-error-attribution.ts:84-87`:
same shared message constant (`errors/query.ts:186`), relation `""`, code
`V7006` (`errors/base.ts:55`), cause the driver's error, and — since
`NestedWriteError`'s constructor sets no `raceable` (`errors/query.ts:162-177`)
— non-raceable, so the retry wrapper leaves it alone: one attempt. `m8-race-retry`
cell 1 pins exactly that quartet (`toBeInstanceOf(NestedWriteError)`, `"V7006"`,
`meta.raceable` undefined, `batchCount === 1`) and is **4/4**.

One difference from the retired *implementation*, in the unit's favour: the
retired `:84` floor was reachable only when there were no guards at all, and
`:82` returned the raw internal error when guards existed but disagreed. The
unit translates every un-attributable case. That is `DESIGN.md` §7.3 step 4 as
written ("if no premise fails … throw the generic-but-typed `NestedWriteError`,
non-raceable"), so the unit matches the normative contract more closely than
the retired code did. Accepted.

**`tests/raptor3/transitions/staleness.ts` `g2-key-captured-restored`** (+5/−4):
re-expressing `NestedWriteAssertionError` → `NestedWriteError` while keeping
`V7006` and the same message is a legitimate re-expression, not a weakening.
The corpus expectation pinned the leak the public contract forbids; the code,
the message and the class are all unchanged for every other consumer. The
estate comparison agrees: three cells moved from the internal class to the
typed floor, each still red for its own attribution, none newly red — and I
reproduced the m2m half of that comparison by cell identity (§6).

**Citation nit (note + `AGENTS.md` + `staleness.ts` comment).** All three say
"DESIGN §7.4 step 4". The ladder's four steps are §7.3; §7.4 is the retry
wrapper (which says only that the fallback is never raceable). `m8-race-retry`'s
own header says "§7.3 step 4". Please correct the three citations — it is a
normative reference attached to a re-expressed pin.

---

## 4. Accepted — the premise's position, with one disclosure gap

- **`retained` on the disconnect/delete lookup** is asserted by `runSelection`
  right after the capture (`execution.ts:267-268`), and only when a row was
  actually bound — so an empty lax slot still asserts nothing (N2 preserved;
  measured: the three "no-op" cells stay green on all three routes).
- **The series delete members** assert presence at capture
  (`execution.ts:850-862`), beside `requireNoAddedMember`, and register in
  `attempt.retained` so the record path does not assert a second time.
- **The deletion and removal commands assert nothing.** Read in full:
  `case "delete"` (`execution.ts:538-548`) only re-enters `runSelection` (which
  early-returns on the already-bound selection) and calls `ctx.delete`;
  `case "remove"` (`:526-537`) calls `ctx.remove` and nothing else. Confirmed.
- **Is "asserted where the observation is taken, before any write of the unit"
  one rule or a policy?** One rule, at the two places an observation is taken:
  a lookup's `retained` and a series capture. The series member cannot go
  through `retained`, because `capture()` pre-binds the row and `runSelection`
  returns at its first line — so the direct `requirePresent` there is necessary,
  not a second policy. I would not call it patchwork.
  One smell, pre-existing and merely inherited: "has this located's presence
  already been premised?" now has two registries — `Selection.retained` and
  `attempt.retained` — both read in the same condition
  (`execution.ts:284-288`). The unit adds a writer to the second. Worth one
  sentence in `AGENTS.md` naming which registry owns which case.
- **Statement order.** Measured (table in §2): the premises lead the parent's
  own UPDATE in the lax to-one shape and in the junction series shape. Correct,
  and it is what the earlier shapes (`unit2`…`unit5`, `probe-pin-recovery-gate.log`,
  "premises at 0 and 2, the UPDATE at 1") failed to achieve.
- **Can it assert a premise the plan's own earlier statement invalidates?** No,
  for the shapes it owns. The junction `delete: true` order (removal then target
  delete, both in the `"after"` bucket, `relation-body.ts:288-303`) is untouched
  and the lookup that feeds them is placed `"before"`, so both writes follow
  both premises — the "disconnect then delete" mistake cannot recur here. The
  series capture is a `"capture"` child, which runs before every `"after"`
  child, so a sibling removal cannot invalidate a member premise either.
  (This is the property §2's resolution also relies on.)
- **The UPDATE member's premise** stays the non-raceable not-found at the
  record. The note discloses it in one clause and the plan authorises it.
  Honest, but terse: the note should say plainly that two members of the *same*
  captured set now get different classes for the same loss.
- **Disclosure gap (feeds §1).** The note's hunk list says only "`relation-body.ts`
  (`retained` on the deletion lookup)". It does not say that the **strict**
  form's premise changes from the non-raceable not-found to a raceable race —
  i.e. that a previously non-retryable registered refusal becomes retryable.
  That is the observable change §1 shows to be unsafe, and it should have been
  the note's first sentence about this hunk.

## 5. Accepted — the shared sentence owner

`membershipRaceFailure(verb, edge, "added" | "removed")` (`commands.ts:141-158`)
is one exported function with one message template and one `raceable` mark,
consumed at three sites (`relation-body.ts:252`, `execution.ts:744-748`,
`execution.ts:855-859`). The "added" wording is byte-identical to the sentence
it replaces (`execution.ts:739-745` at HEAD), so `requireNoAddedMember` keeps
its registered sentence. One owner, no second reader. Accepted.

## 6. What I ran

`TMPDIR=/private/tmp/viborm-n3-review-tmp`, one file per call, through the
sanctioned runners.

| command | result |
|---|---|
| `run-vitest-safe tests/raptor3/g4/parity/lax-to-one.test.ts` | **18/18** (×2 projects) |
| `run-vitest-safe tests/raptor3/g4/parity/series-member-premise.test.ts` | **4/4** |
| `run-vitest-safe tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | 8/8, unchanged |
| `run-vitest-safe …/parity/upsert-array-route.test.ts …/increment-key-width.test.ts` | 6/6 and 1/1 |
| `pnpm test:all --only "Raptor 3 fixed"` | **787/787**, 69 files (758+29, 65+4) |
| launcher `…/query/m8-race-retry.test.ts` | **4/4** |
| launcher `…/query/nested-m2m-parent-pk-dataflow.test.ts` | **6/6** |
| launcher `…/query/nested-write-conformance-m2m.test.ts` | 29 passed, **5 failed** |
| `node scripts/run-typecheck.mjs` | 0 diagnostics |
| `npx biome check`, 8 touched files vs base | **identical**, category by category |
| `npx biome check`, the 2 new test files | clean |

**The five m2m cells, by identity and message.** Same five as
`receipts/nested-write-conformance-m2m.log` and `receipts/regress/shard-6.log`,
line for line: `m2m connectOrCreate string-selector array rejects unknown
overlap`, `m2m overlapping set and deleteMany reject membership dependency`,
`m2m disconnect then deleteMany rejects membership dependency`, `m2m multiple
deleteMany filters reject internal dependency`, `self m2m connect then inverse
upsert rejects shared junction dependency`. Messages: four
`expected false to be true`, one `expected true to be false` — boolean
refusal-expectation cells (the §6.2 veto cells N1 inherits), so no error class
can have moved under them. The receipts are truncated logs without messages, so
the message comparison is mine, not a re-check of theirs.

**Biome, exactly.** Base extracted with `git show HEAD:<path>` into a scratch
tree carrying `biome.jsonc`, `.gitignore` and a `node_modules` symlink. Per
file, base → now: `commands.ts` 2→2 (`noParameterAssign`, `noParameterProperties`);
`execution.ts` 4→4; `relation-body.ts` 6→6; `operation-context.ts` 5→5;
`raptor3-manifest.mjs` 20→20; `credential-free-test-manifest.mjs` 0→0;
`lax-to-one.test.ts` 0→0; `staleness.ts` 20→20. Empty symmetric difference —
the note's claim holds.

## 7. Falsification and probes (scratch worktree at `HEAD`, removed)

1. **The unit's own falsifier.** `series-member-premise.test.ts` copied to the
   HEAD worktree: **2 of 4 cells fail**, both "does not delete a member removed
   from the set after the plan-time read", on both drivers, actual `[]` versus
   expected `[8]` — at HEAD the member removed after the plan-time read **is
   deleted**. That is exactly the exposure the N2 review's finding 1 named, and
   the unit closes it. `lax-to-one.test.ts` likewise: its one new cell fails on
   both batch routes at HEAD (16/18). The instrument rule is satisfied: each pin
   is red at HEAD for the reason the unit names.
2. **Statement-order probe** (unit copied into the worktree): the table in §2.
3. **Stale-attribution probe**: §2's counter-example, HEAD 17 statements vs unit
   19, with the committed `W2`/`W3` shown in the data.
4. **Identity probe**: §1's table.
5. **Both resolutions applied**: §1's probe back to the HEAD refusal, §2's probe
   back to the HEAD outcome, both pins green (22/22), raptor3 fixed 758/758.

## 8. Accepted — the manifest registration

Confirmed by reading and by evaluating the manifests.

- The four `g4/parity` SQLite pins were in **no** group at HEAD
  (`git show HEAD:scripts/raptor3-manifest.mjs | grep g4/parity` returns only
  `postgres-identity-scratch.test.ts`, which is `D50_PROVIDER_TESTS`). The
  note's claim that the coverage scope had never seen them is exact.
- After the change, for each of the four: `RAPTOR3_DETERMINISTIC_TESTS` true
  (once), `RAPTOR3_FIXED_LOCAL_TESTS` true (once), `EXTENDED_LOCAL_TESTS`
  false. So each runs once, in the fixed stage
  (`run-credential-free-tests.mjs:157-168`, project `raptor3`), and is in the
  coverage scope (`vitest.workspace.ts:51-59`, `coverage-raptor3`). No
  duplicates introduced; the one duplicate in the deterministic list
  (`tests/raptor3/expanded/compound-falsifier.test.ts`) is pre-existing.
- `G4_PARITY_COUNTS` matches the files exactly: **6 / 1 / 18 / 4** (measured,
  each file run on its own). 6+1+18+4 = 29, and 758+29 = **787** — the fixed
  stage I measured. The `*_COUNTS` shape follows the file's own idiom
  (`G1_CONTRACT_COUNTS` et al.). Observation only: those counts are consumed by
  `run-raptor3.mjs`'s mode map and `G4_PARITY_COUNTS` is not in it, so its
  values are documentation rather than a checked fact; that is fine as long as
  nobody reads them as verified.

## 9. Note corrections asked for

1. §4 "the lax pin 12 / 12 including the new cell" — the landed file is
   **18/18** on three routes (the third, `NoIndexBatchOnlyDriver`, was added
   after `probe-pin-recovery-gate.log`, which still shows the 12-cell shape).
2. §4 "the raptor3 fixed stage 758 / 758" reads as the unit's number; §3's
   "787 / 787 (758 + 29)" is the one that is true after registration. Keep one.
3. "DESIGN §7.4 step 4" → **§7.3 step 4**, in `note.md`, `AGENTS.md` and the
   `staleness.ts` comment.
4. The hunk list must disclose that `retained` on the disconnect/delete lookup
   changes the **strict** form's premise too — sentence and raceability (§1).
5. §5's "route-independent change" is the stated reason for not re-running the
   Docker lane. The `raceable` mark is route-independent in *reach* (every batch
   transport) even though it only fires on the batch route; §1's defect would
   reproduce on PostgreSQL and MySQL. Once §1 is fixed the reasoning stands, but
   say it that way.

## 10. Unverified

- The Docker provider lanes (MySQL 3307, PG 5434) were not run, as in the note.
- The author's whole extended-local estate comparison was not re-run; I
  reproduced `nested-write-conformance-m2m` (cell identity + messages),
  `m8-race-retry`, `nested-m2m-parent-pk-dataflow`, the fixed stage, the pins
  and typecheck.
- The two resolutions were measured against both new pins, the HEAD-manifest
  fixed stage (758/758) and both probes; they were **not** run against the
  launcher families (`m8-race-retry`, the conformance suites) or the provider
  lanes. Both narrow behaviour the unit itself introduces, so nothing green at
  HEAD can depend on them — but that is an argument, not a receipt.
- Neon HTTP and D1 have no transport witness here, so the position rule stays
  unqualified for them under D-53 whichever resolution lands.
