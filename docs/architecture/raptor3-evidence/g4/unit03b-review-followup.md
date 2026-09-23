# G4-03b independent review — follow-up after repair 3

Reviewer: independent (did not author the unit; author of
[`unit03b-review.md`](unit03b-review.md), which returned **REVISE**).
Unit: **G4-03b route follow-up**, repair 3.
Brief: [`briefs/unit03b-route-followup.md`](briefs/unit03b-route-followup.md),
[`briefs/common.md`](briefs/common.md), [`briefs/review.md`](briefs/review.md).
Unit record: [`unit03/note.md`](unit03/note.md) §"Repair 3" (RP.0–RP.8) and
FU.6 D-5 / D-6, [`unit03/handoff.md`](unit03/handoff.md).
Source reviewed: main tree at `0cc61e61` + the unit's working-tree diff.
Receipts: [`unit03b-review-followup-receipts/`](unit03b-review-followup-receipts/).

## Outcome: **ACCEPT**

Both must-fix findings were answered exactly as the review prescribed —
**measured, pinned on BOTH routes, recorded as a decision for Arnaud** — and
nothing was repaired in the candidate, which was the point. The three notes are
addressed. **No production file changed**: all four carry the exact SHA-256 my
first review verified, so the repair cannot have moved a public answer, an error
identity or committed state, and the cost recheck is zero on every axis by
construction.

I did not take the author's falsifications on trust. I mutated production
myself, three ways, each on a scratchpad copy-restored file with the restored
SHA re-verified in the same command:

- **the exact repair the review forbade** (re-raw only the two delegated
  `upsert` arms, admitted envelope untouched) makes **the D-6 pin and only the
  D-6 pin** red;
- **the exact refusal the review forbade re-introducing** (the candidate throws
  the shipped `TransactionError` for any multi-statement package) makes **the
  D-5 pin and only the D-5 pin** red in its file;
- the broader r1-style mutation (routed `#preparedInput` answers the
  client-prepared args again) reds the D-6 pin plus the LX-12 and admission
  parity cells, as the author reported.

Both pins are therefore decision alarms, not snapshots: parity in **either**
direction fails them, and so does a change on the shipped side.

I also attacked the one genuinely new claim the repair introduces — D-6's scope
("`upsert` is the ONLY diverging verb"), which the author correctly labelled
unverified because it is carried from my own flat-payload sweep. A new probe
publishes **nested relation payloads** (`create` with `books: { create: [...] }`,
`update` with a nested create beside a scalar assignment, and a `findMany`
carrying a nested `include`/`where`/`orderBy`) and compares the interceptor
input on both routes: **byte-identical**, with non-vacuity assertions on the
three public results. The scope claim survives the attack.

Two reds remain on this tree. Both are recorded, both are somebody else's
action, and neither belongs to this repair: the B-1c witness cell
(`g4-lifecycle-admission` 3/4, waiting on a one-line change in another stream's
`shared/query.ts`) and the four stale manifest counts (waiting on the manifest
owner). The D-5 and D-6 decisions are open for Arnaud by design.

---

## Per-finding status

| # | Round-1 severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | must-fix | the `upsert` interceptor `input` differs between the routes; LX-12 declared COVERED on a one-verb cell | **RESOLVED as recorded** |
| 2 | must-fix | on a batch-only driver the candidate executes a multi-statement array member the shipped route refuses; a registered refusal disappears unpinned | **RESOLVED as recorded** |
| 3 | note | B-1c causation ("inherited red") is generous; brief outcome 2 not met | **RESOLVED** |
| 4 | note | registered cell counts stale → three `g4-route-*` campaign modes red | **RESOLVED as a request** (now four modes; manifest is not this unit's file) |
| 5 | note | "incremental core semantic cost is 0" excludes the unit's own directory | **RESOLVED** |

### 1 — `upsert` published payload (now divergence D-6) — RESOLVED as recorded

**Recorded.** `note.md` FU.6 D-6 names both owners from source
(`src/query-engine/write-engine/routing.ts` `case "upsert"` validates the
envelope only; `PendingOperation.#preparedInput`,
`src/query-engine/pending-operation.ts:569`, consumed at `:300` and `:696`),
prints the two payloads, states the scope, and gives Arnaud two resolutions with
the reason each belongs where it does. I re-checked every cited line number
against the current source: **all exact**.

**Pinned.** `tests/raptor3/g4/route-lifecycle.test.ts:399` — "D-6 PIN the
interceptor input for upsert is the caller's raw arms on the shipped route and
the ONE admission on the candidate". It asserts identical public results, an
identical envelope outside the two arms, each route's exact arms
(`{ email, id: undefined, name, score: 0, secret: "hidden" }` /
`{ name: { set: "Updated" } }` on the candidate), and `notDeepEqual` on the
whole payloads.

**My falsification (independent, surgical).** I patched `#preparedInput()` to
re-raw ONLY `create` and `update` from the caller's args while leaving the
admitted envelope alone — i.e. precisely the "fix" the review forbade:

```
node scripts/run-vitest-safe.mjs run tests/raptor3/g4/route-lifecycle.test.ts \
  tests/raptor3/g4/route-admission.test.ts tests/raptor3/g4/route-cache.test.ts
→ 1 failed | 21 passed — only "D-6 PIN …", at route-lifecycle.test.ts:478
```
[`falsify-b-d6-pin-arms-reraw.log`](unit03b-review-followup-receipts/falsify-b-d6-pin-arms-reraw.log).
The broader mutation (routed `#preparedInput` answers `#resolveArgs()`) reds the
D-6 pin, the LX-12 parity cell and the admission-seam cell
([`falsify-a-d6-pin-raw-input.log`](unit03b-review-followup-receipts/falsify-a-d6-pin-raw-input.log),
3 failed / 32 passed; the author's own variant also reds NS-04 because it cut
deeper). `pending-operation.ts` was restored to
`1e19986c…6df85ef` in the same command each time.

**Row moved.** FU.11.1's LX-12 row now reads PARTIAL, FU.11.2 carries the
pending half, and the section-D banner says so too.

**Scope, re-attacked.** New probe
`tests/raptor3/g4/review/unit03b/route-nested-payload.review.test.ts` — nested
relation payloads on `create` and `update` and a nested read payload publish
identical `context.input` on both routes (green, with the three public results
asserted literally):
[`probe-nested-payload.log`](unit03b-review-followup-receipts/probe-nested-payload.log).
The 16-verb enumeration in `route-admission.test.ts` is the complete client verb
set, so "every verb but `upsert`" is now supported by a flat sweep, a nested
sweep and a per-verb enumeration.

### 2 — batch-only multi-statement array member (now divergence D-5) — RESOLVED as recorded

**Recorded.** `note.md` FU.6 D-5 names the shipped owner at
`src/query-engine/write-engine/OperationExecutor.ts:1515–1519` (verified: that
is the `stepUsesInsertIdScratch` refusal and its message) and the candidate
mechanism at `pending-operation.ts:601–604` + `:371–379` (verified), prints the
measured table, bounds the substrate, and states the two resolutions —
including the explicit warning that option (b) belongs to the candidate's
packaging rule because a refusal re-derived in the route would be a second plan
authority. RP.3 repeats it for the integrator; `handoff.md` leads with it.

**Pinned.** `tests/raptor3/g4/route-transactions.test.ts:442` — "D-5 PIN a
MULTI-statement array member is refused by the shipped route and packaged by
the candidate on a batch-only driver". One scenario on both substrates: on the
interactive driver both routes answer `ok:[{"email":"d5@example.test"}]`
(asserted, not asserted about); on the batch-only driver the shipped refusal
text verbatim with 0 batches and 0 rows against the candidate's `ok:[…]`, 1
native batch, the author row and both book rows; plus `notEqual` on the two
outcomes.

**My falsification (independent, surgical).** I made the candidate re-introduce
the shipped refusal for multi-statement packages only (routed `prepareBatch`
throws `TransactionError` with the shipped sentence when
`batch.queries.length > 1`):

```
node scripts/run-vitest-safe.mjs run tests/raptor3/g4/route-transactions.test.ts
→ 1 failed | 12 passed — only "D-5 PIN …", at route-transactions.test.ts:498
```
[`falsify-c-d5-pin-candidate-refuses.log`](unit03b-review-followup-receipts/falsify-c-d5-pin-candidate-refuses.log).
The two single-statement LX-04 packaging cells stay green under it, so the pin
isolates exactly the divergence it names (the author's broader mutation — refuse
every package — reds those two as well, as their receipt shows).

**Row corrected.** FU.11.1's LX-04 row now says it measured the READ half and
points at D-5 for the multi-statement write member; FU.11.2 gains the D-5 row.

### 3 — B-1c causation — RESOLVED

FU.6 B-1c now says the witness red is **produced** by this unit's refusal and
only **owned** elsewhere, states that `g4-lifecycle-admission` stays red at 3/4
until the one-line `shared/query.ts` change lands, and scopes brief outcome 2 to
the key half (NS-04 key parity and RF-10 hold; LX-07's store/materialize half
does not). The one-line requested change and the ~35-line composition it
enables are still written out exactly. Reproduced unchanged on this tree
([`repro-route-suites.log`](unit03b-review-followup-receipts/repro-route-suites.log)).

### 4 — stale registered counts — RESOLVED as a request

FU.12 is rewritten: **all four** counts move —
`route-transactions` 11 → 13, `route-lifecycle` 7 → 8, `route-cache` 6 → 7,
`route-admission` 5 → 7 — and the section states why the campaign modes are red
until applied (`scripts/run-raptor3.mjs:1025–1036` asserts
`assertionResults.length` per file). I re-read
`scripts/raptor3-manifest.mjs:509–532` (registered 7 / 5 / 6 / 11) and measured
13 / 8 / 7 / 7 on this tree: the request is correct and complete. The unit
correctly did not edit the manifest (another stream's file, currently dirty).
**Integrator action item, still open.**

### 5 — the cost sentence — RESOLVED

FU.9 now reads "0 outside the new route adapter", names the adapter as the
exception and charges it in full (+144 token-lines / +234 physical / +9,170
bytes of the unit's +242 / +380 / +14,653).

---

## What I verified about the repair itself

**Production identity — nothing changed.** All four files carry the SHA-256 my
first review verified:

| File | SHA-256 (round 1 = now) |
| --- | --- |
| `src/query-engine/raptor3/route/client-route.ts` | `82ba9c9e…7490b111` |
| `src/query-engine/pending-operation.ts` | `1e19986c…6df85ef` |
| `src/query-engine/query-engine.ts` | `bb07f7a0…80d5b612` |
| `src/client/client.ts` | `76433612…d57459bf` |

Only `route-lifecycle.test.ts` and `route-transactions.test.ts` changed
(`route-cache.test.ts` and `route-admission.test.ts` are byte-identical to round
1), which matches "one cell added to each of two files" exactly.
[`source-identity.log`](unit03b-review-followup-receipts/source-identity.log).

**No existing cell was weakened.** The 12 cell names my round-1 falsification
receipt enumerated for `route-transactions.test.ts` are all still present, in
order, with the D-5 pin inserted as the 7th; `route-lifecycle.test.ts` keeps its
7 names with the D-6 pin inserted after LX-12. I re-read the two D-1 parity
cells (the statement-atomic unit sequence, the multi-statement region count and
the LX-02 poisoning cell): their assertions are intact, including the literal
`UniqueConstraintError` / `savepoints === 1` answers my round-1 falsification
made fail.

**Suites, reproduced serially.**

| Suite | Author receipt | My receipt | Result |
| --- | --- | --- | --- |
| 4 route suites + C13 witnesses | `followup-repair/final-route-and-witness-suites.log` 41/1 | [`repro-route-suites.log`](unit03b-review-followup-receipts/repro-route-suites.log) | **41 passed / 1 failed** — identical; transactions **13**, lifecycle **8**, admission 7, cache 7; the single red is the B-1c cache-bypass cell |
| my 6 round-1 probes | `followup-repair/review-unit03b-probes-after.log` 18/3 | [`repro-review-probes.log`](unit03b-review-followup-receipts/repro-review-probes.log) | **18 passed / 3 failed** — identical; the 3 reds are my parity assertions on D-5/D-6, red **by design** now that the divergences are recorded rather than repaired |
| prior reviewer's unit03 probes | `followup-repair/review-unit03-probes.log` 19/19 | [`repro-review-unit03-probes.log`](unit03b-review-followup-receipts/repro-review-unit03-probes.log) | **19 passed (8 files)** — identical |
| whole-estate typecheck | `followup-repair/typecheck-final.log` | [`typecheck-with-probes.log`](unit03b-review-followup-receipts/typecheck-with-probes.log) | **exactly 2 diagnostics**, both the permitted `pattern/pack.ts` TS2345, with all **seven** of my probe files in the program |

I did not re-run the shipped client falsifier batches (519 + 128, both green in
round 1 and re-run green by the author at 11:34): production is byte-identical
to the tree those runs measured, so a re-run could only re-measure the same
bytes.

**Patch fidelity, re-verified independently.** `git archive 0cc61e61 src tests`
into a scratch directory, then `git apply production-followup.patch` and
`git apply tests-followup.patch`: all nine files (plus the reviewer probe the
tests patch carries) come out **byte-identical** to the working tree —
[`patch-reconstruction.log`](unit03b-review-followup-receipts/patch-reconstruction.log).
`tests-followup.patch` is `068e03f6…`, `production-followup.patch` is
`209f8e5e…`, both as the note claims.

**Cost.** `unit-cost-recheck.json` claims zero on every axis for repair 3. The
four production files hash-match the tree whose figures I recomputed from
`countTokenLines` in round 1, so the delta is zero by identity, and the unit
total stands at **+242 token-lines / +380 physical / +14,653 bytes** vs
`0cc61e61`.

**Biome.** Clean on all eight files under `tests/raptor3/g4/review/unit03b/`.

---

## Notes for the integrator (no action from the author)

1. **The two decisions are open.** D-5 (a registered refusal the candidate route
   removes on a batch-only transport) and D-6 (the `upsert` published payload)
   are recorded for Arnaud with both resolutions each. Until one is taken, three
   of my probe cells stay red on purpose — that is the recorded state, not a
   regression. If D-5 is refused, the refusal belongs to the candidate's
   packaging rule, never the route.
2. **Manifest counts (finding 4) are still unapplied**, so
   `g4-route-transactions`, `-lifecycle`, `-cache` and `-admission` fail as
   campaign modes on this tree.
3. **B-1c's one-line `shared/query.ts` change is still unrouted**, so
   `g4-lifecycle-admission` stays red at 3/4 and LX-07's store/materialize half
   plus NS-04's codec half stay pending.
4. **Falsification receipts carry no mutation text or restore hash.**
   `falsify-6-…log` and `falsify-7-…log` contain vitest output only; RP.4 states
   the mutation and says the restore was hash-verified "in the same command",
   but that command's output is not in the receipt. The restore itself is
   evidenced by `followup-repair/source-identity.log` (timestamped after both
   runs) and by my own re-hash today, so nothing is in doubt — but a
   falsification receipt that does not name its own mutation cannot be replayed
   from the receipt alone. Worth fixing as a habit, not as a repair.
5. **Two small staleness spots in `note.md`.** FU.11.2's falsification-2
   paragraph still says "all 12 route-transaction cells" (13 now), and the
   section-D banner's shorthand "LX-04's coverage is the READ half only" is
   slightly lossier than FU.11.1, which correctly says the write half is covered
   except for a multi-statement member on a batch-only driver. FU.11 is the live
   row status; read it, not the r1–r4 table.
6. **D-6's scope claim can be upgraded.** The author lists it as unverified
   ("carried from the reviewer's sweep"). Between my flat all-verb sweep
   (`route-seams.review.test.ts` cells 1–2), the new nested-payload probe and
   the 16-verb enumeration that covers the whole client surface, "`upsert` is
   the only diverging verb" is now measured on two payload shapes across every
   verb. It remains SQLite-only, like everything else in this estate.

---

## Probes I ran

Kept under `tests/raptor3/g4/review/unit03b/` (7 files, 22 cells: 18 green, 3
red by design — my round-1 parity assertions on D-5/D-6 — and 1 new green).

- **New:** `route-nested-payload.review.test.ts` — the D-6 scope attack
  described above (green).
- Re-run unchanged: `route-seams`, `route-envelope-array`, `route-array-verbs`,
  `route-write-outcome`, `route-admission-seam`, `route-upsert-payload`.

Falsifications (all applied to a scratchpad copy, all restored and re-hashed in
the same command):
[`falsify-a-d6-pin-raw-input.log`](unit03b-review-followup-receipts/falsify-a-d6-pin-raw-input.log),
[`falsify-b-d6-pin-arms-reraw.log`](unit03b-review-followup-receipts/falsify-b-d6-pin-arms-reraw.log),
[`falsify-c-d5-pin-candidate-refuses.log`](unit03b-review-followup-receipts/falsify-c-d5-pin-candidate-refuses.log).

---

## Unverified claims (carried forward, all correctly labelled by the author)

1. **Both divergences are measured on SQLite only.** D-5's batch-only substrate
   is a synthetic SQLite subclass (`supportsTransactions = false`,
   `supportsBatch = true`); no PG/MySQL lane ran this session, so neither
   divergence is confirmed on a native non-interactive transport.
2. **Falsification 2** (granting `operationRegion` on the array `driverOverride`
   arm) still does not falsify locally; the array arm's "no grant" rests on
   G4-02's native `scope-composition-pg/-mysql` measurement.
3. **Performance** is still unmeasured; no benchmark in this repair either.
4. **D-3'** remains source-read: in this estate no credential-free cell can
   distinguish a package prepared on the factory driver from one prepared on the
   array owner's, because they share an adapter (I confirmed the mechanism in
   round 1 — unverifiable rather than unverified).
5. **B-2** remains MySQL-only and unreachable here.
6. **The two `g4-read-contracts` reds** (SC-13, RF-16) are still attributed to
   `unit02/note.md` P.11.1 by matching cell/file/line rather than re-measured on
   a tree without this diff; I confirmed in round 1 that neither file imports the
   route, and this repair changes no production byte, so the attribution is
   unchanged and safe.
7. **D-6 scope** — see integrator note 6: now measured on flat and nested
   payloads across the full 16-verb client surface, still SQLite-only.
