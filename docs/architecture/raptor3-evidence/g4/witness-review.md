# Independent review — G4 unit "Independent witnesses C01/C12/C13"

Reviewer: independent adversarial review stream. 2026-09-15, working tree
`/Users/arnaud/code/viborm`, branch `pattern-engine`. Nothing was applied or
repaired; the tree already contained the unit. Probes are under
`tests/raptor3/g4/review/witness/` and review receipts under
`docs/architecture/raptor3-evidence/g4/witness-review-receipts/`.

Reviewed: `g4/witness/note.md`, `g4/witness/handoff.md`, the unit's untracked
witness tree `tests/raptor3/g4/**` (excluding the G4-03 `route-*` files and this
review's own subtree), and the tracked diff of
`scripts/raptor3-manifest.mjs`, `scripts/run-raptor3.mjs`,
`scripts/raptor3-campaign-receipts.test.mjs`, `scripts/raptor3-cli.test.mjs`,
`scripts/credential-free-test-manifest.mjs`, `vitest.workspace.ts`.

## Outcome

**REVISE.**

The fixed estate is real and it reproduces exactly: 68 cells, 28 green, 40 red,
with the failing message the note states for every row I checked. The
differential oracle works — I broke a hand value and the shipped assertion
fired first, as designed (finding 11 probe). Registration is coherent and
self-tested; both required self-tests pass; the whole-estate typecheck adds no
diagnostic; the charged-LOC claim is correct (I recomputed the perimeter). Five
adversarial probes into rows the brief names and the witnesses do not cover
found **no hidden candidate defect** — the red list in `handoff.md` is honest
and usable.

What blocks acceptance is not the fixed witnesses; it is the three artefacts
built around them. One of the five required C13 falsifiers asserts nothing at
all about the candidate route. The generated campaign's profile axis — the
thing that makes a child 200 cells instead of 100 — has zero distinguishing
power. The campaign's *subject* (candidate vs shipped) is chosen by an ambient
environment variable the runner never sanitises, and no runner artefact records
which subject ran. The native lane cannot pass even when unblocked. And one
retained archive receipt states a replay command that provably fails.

None of this is a false green, which is why this is REVISE and not BLOCK.

## Reproduction

| Suite | Command | Result | Receipt |
| --- | --- | --- | --- |
| Fixed estate (8 read families + 2 lifecycle + generation self-tests) | `node scripts/run-vitest-safe.mjs run tests/raptor3/g4/read-*.test.ts tests/raptor3/g4/lifecycle-*.test.ts tests/raptor3/g4/generation/harness.selftest.test.ts` | **68 cells, 28 passed, 40 failed** — identical split and identical per-cell reasons to `g4-fixed-witnesses.attempt3.json`; 9.82 s wall, 807.0 MiB peak RSS | `witness-review-receipts/g4-fixed-witnesses-reproduction.log` |
| Registration self-test | `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs` | **37/37 pass**, 0.40 s, 66.7 MiB | `witness-review-receipts/campaign-receipts-selftest-reproduction.log` |
| Registered mode end-to-end | `node scripts/run-raptor3.mjs g4-generation-selftests` | **5/5 pass**, gate verified | `witness-review-receipts/g4-generation-selftests-mode.log` |
| Campaign child, shipped subject | `VIBORM_RAPTOR3_G4_SUBJECT=shipped node scripts/run-raptor3.mjs g4-seed-batch 20000` | exit 0, 200 cells, 5.53 s, 721.8 MiB (author measured 5.36 s / 719.1 MiB) | `witness-review-receipts/subject-leak/` |
| Whole-estate typecheck | `node scripts/run-typecheck.mjs` | only the two permitted historical `pack.ts` TS2345 diagnostics; **this unit and these probes add none** | `witness-review-receipts/typecheck.log` |
| Review probes | `node scripts/run-vitest-safe.mjs run --workspace=tests/raptor3/g4/review/witness/review.workspace.ts tests/raptor3/g4/review/witness/` | **8 files, 18 cells, all pass** (each passing probe confirms a finding) | `witness-review-receipts/review-probes.log` |

The author's `raptor3-cli.test.mjs` receipt (286 s) was not re-run; its 8/8 result
is consistent with the three new `parseRaptor3Request` assertions I exercised
directly through the receipts self-test.

## Findings

### 1. blocking-for-qualification / must-fix — the C13 cache-bypass falsifier makes no assertion about the candidate route

`tests/raptor3/g4/lifecycle-admission.test.ts:173-180`.

The unit brief names cache-bypass as one of the five required C13 falsifiers,
and `note.md` §2 lists it as a C13 row whose red status is handoff evidence.
The test proves its oracle on the shipped route with three real assertions
(first read reaches the provider, second is served from cache, a read inside
`$transaction` reaches the provider again). The candidate section is then:

```ts
const routed = createRoutedClient({ schema: admissionSchema(), driver });
const routedCached = routed.$extends(extension).$withCache();
await routedCached.record?.findMany({ where: { score: { gte: 10 } } });
await Promise.all(background.splice(0));
await routed.$disconnect();
```

There is no second read, no transaction, and no assertion. The cell is red today
only because `$withCache` on the route throws `UnsupportedOperationError`. The
moment G4-03 lands a cache result encoder this cell goes **green while testing
nothing about cache bypass** — the exact failure mode the C13 falsifiers exist
to prevent.

Probe: `tests/raptor3/g4/review/witness/cache-bypass-blindness.review.test.ts`
runs that block verbatim against a stand-in route that always serves a stale
cached row, inside and outside a transaction, and never reaches a provider. The
block passes.

Resolution: give the candidate section the same three assertions the shipped
section has (statement count after the first read, unchanged after the second,
increased after a read inside `$transaction`), against the same recorder.

### 2. must-fix — the generated campaign's four "transport profiles" are one profile with four names

`tests/raptor3/g4/generation/world.ts:251-275`; constants at
`scripts/raptor3-manifest.mjs:692-707`.

`ProfileDriver` stores `profile` and branches on it exactly once, for
`scripted-returning-weak` (a shallow row copy). `sqlite-interactive`,
`sqlite-atomic-batch` and `scripted-returning-ack` are byte-identical code
paths, and the one branch that exists has no observable consequence for a read.
So each child runs 200 cells to obtain 100 cells of evidence, and the receipt's
`assert.deepEqual(receipt.profiles, campaign.profiles)` cannot notice.

This makes three statements in the unit's own record misleading:
`note.md` §1 question 3 ("The generated campaign runs the same recipe on four
transport profiles and requires one answer"), §4's "200 cells / 600 replays"
per child, and §12.5, which discloses that all four execute real SQLite but not
that three of the four differ in *nothing*. The names are frozen in `g4.md`
(`sqlite-atomic-batch` means a batch transport; `scripted-returning-ack` means
an ack-shaped returning transport) and G3 implements both distinctions for
real (`tests/raptor3/g3/generation/suppression-scenario.ts:84`,
`transaction-array-scenario.ts:119-127`).

Probe: `tests/raptor3/g4/review/witness/campaign-profile-power.review.test.ts`
runs 20 campaign seeds through all four profiles and compares both the published
public value and the exact physical statement stream. Every profile is
identical on every seed.

Resolution: either build the two missing transport models (the G3 spellings are
available and this is the reuse the "one rule" law asks for), or halve the
frozen profile lists and re-measure child cost, receipt size and disk
projection. Do not leave four names denoting one behaviour.

### 3. must-fix — a campaign's subject is set by an unsanitised ambient variable and is recorded nowhere the runner writes

`scripts/run-raptor3.mjs:731-742` (sanitisation), `:946-951` (assertion
selection), `:978-989` (per-run `verified.json`), `:592-601` (per-campaign
`verified.json`), `tests/raptor3/g4/generation/sqlite-campaign.test.ts:17-18`.

`note.md` §4 presents "a shipped-subject receipt can never qualify" as the
invariant that keeps the oracle-validation lane out of the candidate's evidence.
The invariant holds *inside* `assertG4GeneratedBatchReceipt`. It does not hold
around it:

- The child chooses its subject from `VIBORM_RAPTOR3_G4_SUBJECT`. The runner
  deletes `VIBORM_RAPTOR3_REPLAY_PATH`, `…GENERATED_FIRST_SEED`,
  `…EXTENSION_SLICE` and `…SPECIMEN` from the child environment precisely so an
  ambient value cannot change what a child does. `VIBORM_RAPTOR3_G4_SUBJECT` is
  not in that list and the runner never mentions it.
- The runner then picks *which* assertion to apply from the receipt's own
  `subject` field, so a shipped child self-selects the weaker assertion.
- Neither `verified.json` records `subject` or `qualifying`, and both success
  lines read "verified" / "campaign verified".
- The generated replay command for a G4 corpus
  (`run-raptor3.mjs:582`) omits the subject, so replaying a shipped corpus
  re-runs a different subject.

Consequence: a full `g4-seeds` run performed with `VIBORM_RAPTOR3_G4_SUBJECT=shipped`
inherited from the shell produces 250 passing children, a `verified.json` and a
"campaign verified" line that are indistinguishable from a candidate campaign.

Probe: `tests/raptor3/g4/review/witness/campaign-subject-authority.review.test.ts`,
plus the executed receipt in `witness-review-receipts/subject-leak/`
(`VIBORM_RAPTOR3_G4_SUBJECT=shipped node scripts/run-raptor3.mjs g4-seed-batch 20000`
→ exit 0, `Raptor 3 g4-seed-batch contract gate verified`, `subject: "shipped"`
only inside `generated-campaign.json`).

Resolution: let the runner own the subject (a mode or flag, defaulting to
`candidate`, with `delete environment.VIBORM_RAPTOR3_G4_SUBJECT` beside the
other four); assert the receipt's subject against what the runner asked for
rather than reading it out of the receipt; record `subject`/`qualifying` in
both `verified.json` shapes and in the printed line; add the CLI assertion in
the same shape as "test:all cannot replace the required lane through inherited
specimen variables" (`scripts/raptor3-cli.test.mjs:225`).

### 4. must-fix — the native read-envelope suite cannot pass even when unblocked, and covers less than its header claims

`tests/raptor3/g4/native/read-envelope-native.test.ts:74` versus `:89`, `:100`,
`:111`.

The fixture declares `payload_value <blobType> NOT NULL` and every one of the
three seeded rows supplies `payload_value: null`. The live harness inserts every
key present on the row (`tests/raptor3/transitions/live-world.ts:404-414`), so
the NULL is sent explicitly and both PostgreSQL and MySQL-in-strict-mode reject
it at seeding. The suite is therefore not merely "blocked by an absent
provider": it would fail on the first provider that answered.

The same reads project only `id, big, amount, moment, status`. `payload` (blob),
`document` (JSON), date, time, list, `point` and `vector` are never projected
and no spatial column exists in the file, yet the file header claims "the scalar
codecs at their real native types (SC-01…SC-12) … plus the spatial tiers
(SC-13, SC-14, Q-O02), which SQLite cannot witness positively at all", and the
unit brief's outcome 4 names "DateTime, decimal, bigint, JSON, blob, vector,
GeoPoint, lists". The fourth cell, `g4-native-recursive-read-fit`, is an
ordinary nested self-relation read, not the `Queries.recursive` fit that
`read-recursive-fit.test.ts` exercises.

Probe: `tests/raptor3/g4/review/witness/native-fixture-consistency.review.test.ts`
reproduces the fixture's own DDL and INSERT on SQLite (identical NOT NULL
enforcement) and shows the seed is rejected; it also pins the projected and
unprojected field sets.

Resolution: seed real bytes and a real JSON document (or drop the NOT NULL),
project the codecs the header claims, add the spatial cells or delete the claim
from the header, and either lower the fit cell to `Queries.recursive` or rename
it. Then re-state §12.1 to say exactly which rows the file asserts.

### 5. must-fix — the retained SQLite archive receipt states a replay command that fails, and the new `replayCommand` parameter has no falsifier

`docs/architecture/raptor3-evidence/g4/witness/receipts/g4-seed-batch-20000-shipped/generated-corpus.archive.json`;
`scripts/run-raptor3.mjs:507-548`.

`note.md` §1 (decision table, row 2 of the §7 answers) and §7 claim the optional
`replayCommand` parameter exists so that "the G4 archive receipt carries its own
working command (§10)". The transport lane's retained receipt does
(`… g4-transport-seed-batch 50000`). The SQLite lane's retained receipt carries
the G0/G3 default, `node scripts/run-raptor3.mjs replay "$g3_corpus_restore_dir/generated-corpus.json"`,
which routes a G4 read corpus into `tests/raptor3/gate.test.ts`. I ran it: it
fails with a `ZodError`
(`witness-review-receipts/archive-replay-command-fails.log`). The receipt is
dated 23:34, ten minutes before the parameter landed, and was never regenerated.

Separately, nothing falsifies the new parameter. The existing archive self-test
(`scripts/raptor3-campaign-receipts.test.mjs:145-177`) calls
`archiveG3GeneratedCorpus(directory)` with one argument and pins the default
spelling, which is the *old* invariant; no test calls it with two arguments or
checks that a G4-lane receipt carries a G4 command. Per the §7 gate, a replacing
invariant needs a falsifier that fails when it is broken — and here the
invariant is already broken in the retained evidence without anything noticing.

Resolution: regenerate (or relabel as superseded) the SQLite archive receipt,
and add one self-test asserting that `archiveG3GeneratedCorpus(dir, command)`
puts `command` in the receipt while the one-argument call keeps the G3 default.

### 6. note — the generated campaign publishes no codec-bearing value, so it cannot witness any codec but `enum`

`tests/raptor3/g4/generation/recipe.ts:260-266`.

`SELECTED_FIELDS` projects `{id,label,count,status,note}` (codec family),
`{id,name,weight}` (relation) and `{region,code,label,score}` (compound). The
scalar-rich world seeds `bigInt`, `decimal`, `dateTime`, `json` and two list
columns, and the recipe uses some of them in *predicates* — but no cell ever
publishes one. `canonical()` in `campaign.ts:53-69` would erase a `Buffer`
versus `Uint8Array` distinction in any case.

Probe: `tests/raptor3/g4/review/witness/campaign-codec-blindness.review.test.ts`
walks 500 seeds and finds no `Date`, `bigint`, `Decimal` or byte array anywhere
in the oracle's answers; the entire publishable surface is 17 field names.

This matters for how the artefact is described, not for whether it works: the
handoff calls it "the fastest whole-envelope probe there is" and the note calls
the world "scalar-rich", while the 200-cell shipped child validates the oracle
over five projected fields per family. Either widen `SELECTED_FIELDS` to the
codec columns (the natural fix, and it would give the campaign real power over
the largest red block in the handoff) or state the observable surface plainly in
§4 and §12.

### 7. note — one refusal is witnessed on the shipped engine only

`tests/raptor3/g4/read-filters.test.ts:506-511`.

The Q-W05 cell ends by observing that `count: { has: 7 }` (a list container on a
scalar column) is refused — but only through `world.shipped`. The candidate is
never asked, which departs from this stream's own stated method (`expectRefusal`
compares both engines). I put the same request to the candidate: it raises the
same `ValidationError` today (`Unknown key: has`), so the omission hides
nothing — but nothing would notice if that stopped being true.

Probe: `tests/raptor3/g4/review/witness/candidate-refusal-holes.review.test.ts`.

Resolution: replace the one-sided `observeFailure` with `expectRefusal`.

### 8. note — four adversarial cases the brief names are absent from the estate (none hides a defect today)

Probe: `tests/raptor3/g4/review/witness/coverage-gap.review.test.ts`, 5 cells,
all passing against the current candidate.

- **Nested pagination with two parents sharing children.** Q-P03 windows
  `posts`, where every child has exactly one parent. The one genuinely shared
  collection in the world is the `tags` junction (tag 2 belongs to `acme/ada`
  *and* `acme/bob`) and no witness windows it. The candidate gets it right.
- **Mapped compound key omitted from projection while a nested collection is
  stitched.** OP-R01 omits the key on a flat row only. The candidate stitches
  correctly when `tenant`/`handle` are unselected.
- **`mode: "insensitive"` with a non-ASCII value.** Q-W04 is ASCII-only. SQLite
  folds ASCII only, so the shipped engine finds nothing for `"école"` — an
  unpinned boundary a candidate could silently change either way.
- **A NULL beside non-NULL in a filtered nullable column.** Pinned indirectly by
  Q-W03's `notIn`; the direct `where: { bio: null }` case is not witnessed. The
  candidate agrees with the shipped engine.

Resolution: add these four cells (they are cheap, the worlds already carry the
rows, and three of the four are one `expectRead` each).

### 9. note — reported test cost is stale

`note.md` §1 question 4 reports 5,643 physical lines under `tests/raptor3/g4/`
owned by this unit and "684 added / 12 removed" across the registration files.
Measured now: **5,711** owned lines and **688 added / 12 removed**. The census
receipt (`receipts/query-engine-structure.json`, 23:44) predates the last
witness edits (23:49). The **charged** figures are correct and I re-derived them
independently: every one of the 171 charged files in
`g3/structure-correction/qualified-final/support/source-cost.json` is under
`src/`, `excludedNonProductionRoots` contains `tests/`, `scripts/` and `docs/`,
`vitest.workspace.ts` is outside the perimeter, and this unit edited no `src/`
file. **Incremental core charged LOC 0 / complete charged LOC 0 is confirmed.**

### 10. note — small internal inaccuracies

- `tests/raptor3/g4/read-schema.ts:5-9` says the relation world is "restricted
  to the four scalar domains the frozen candidate can already decode
  (`string`, `int`, `float`, `decimal`)", but it declares
  `score: s.number()` — which `handoff.md` §3.1 correctly identifies as *not*
  one of those four and which is the sole reason the `{ sort, nulls }` witness
  is red.
- `tests/raptor3/g4/read-pagination.test.ts:146` names `distinct` in the cell
  title ("gives each parent its own where, skip, distinct and omit"); the
  request has no nested `distinct`.
- `tests/raptor3/g4/route-contract.ts:43` exports an unused
  `RAPTOR3_ROUTE_AVAILABLE = true`.
- `scripts/raptor3-campaign-receipts.test.mjs:976` —
  `contract === "Q-S" ? "relation" : contract === "Q-A" ? "codec" : "codec"`
  has two identical arms.
- `note.md` §1's falsifier cross-reference for the archive receipt points at
  "§10", which is the blockers section.
- The retained campaign receipts carry identity `production 8704dcea… /
  harness ae2d5032…`; the tree now reads `86dbac36… / d6472b91…`. The author
  records this as blocker 2 and it is an orchestration fact, not a defect — but
  every campaign figure in §4 is evidence about a source state that no longer
  exists, and must be re-measured when `src/` is quiet.

### 11. note (positive) — mechanisms I attacked and could not break

Recorded so the next reviewer does not repeat the work.

- **`expectRead`'s ordering guarantee holds.** A deliberately wrong hand value
  fails with `Disputed row: the shipped engine disagrees…` before the candidate
  is executed (`evidence-integrity.review.test.ts`).
- **The registration is single-authority and tight.** Every mode resolves to
  one `…_COUNTS` object; `Object.keys` derives the file lists for the runner,
  the workspace and the credential-free manifest; the 57-cell total is pinned;
  every G4 file is asserted out of both credential-free lanes; all 18 mode
  names refuse filters; the seed-batch boundary check reuses the existing
  `campaignFor` mechanism and correctly rejects 19999 / 45000 / a transport
  batch at 20000. The route counts registered for G4-03 (7/5/6/8) match the
  actual files.
- **The frozen ranges match `g4.md`** (20000–44999, 50000–74999, batch 100,
  disjoint, G3's 8000–17999 untouched).
- **No §7 violation in the diff.** No second public-syntax walker, per-verb
  codec, duplicated result-shape preparation, recreated lifecycle, projection
  rebuilt for a decoder, policy-boolean bag, per-feature interpreter, legacy
  import, cached absence or public-contract change. The only new mechanism is
  the optional `replayCommand` parameter (finding 5). The closest thing to a
  fixture-named flag in the diff is the profile list of finding 2.
- **The red handoff is accurate.** I checked every failing message in the
  reproduction against `note.md` §2 and `handoff.md` §3; they agree row by row,
  including the two bare-`Error` refusal identities reported to G4-02 and the
  three silently-wrong answers (cursor, negative take, distinct) that
  `handoff.md` §3.4 correctly calls the most dangerous entries in the list.

## Unverified author claims (carried forward)

1. Native provider behaviour is entirely unverified (author §12.1) — and see
   finding 4: the file would not reach the point of testing it.
2. The campaign has executed 100 seeds per lane, not 25,000 (author §12.2).
3. No candidate-subject child has ever completed, so candidate child cost is
   unmeasured (author §12.3).
4. The `raptor3-cli.test.mjs` 8/8 receipt was not re-run by this review.
5. That no `src/` file was edited by this stream rests on the author's
   declaration; the three dirty `src/` files are attributed to G4-03 and I did
   not independently attribute them.
6. Author §12.5 ("`sqlite-atomic-batch` and the two scripted transport profiles
   are transport *models*") is now **contradicted** by finding 2 — they are not
   models, they are names.
