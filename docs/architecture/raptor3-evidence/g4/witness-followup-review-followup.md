# G4 witness follow-up — independent re-review after REVISE (repair round 2)

Reviewer: independent; did not author the unit, either repair round or this
verification. Reviewed source: main tree `/Users/arnaud/code/viborm`, branch
`pattern-engine`, already containing the repair (nothing applied, nothing
repaired here). Date 2026-09-15, 06:08–06:22 local.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`, my own
[`witness-followup-review.md`](witness-followup-review.md), the author's repair
summary, `g4/witness/note.md` §15 in full plus the in-place corrections in the
§14 preamble, §14.1, §14.7 and §14.8, `g4/witness/handoff.md` §6,
`g4/witness/receipts/repair/**` (README, every log, every JSON), the
regenerated patch, and the current source of every changed file.

**Identity.** The tree was at production `7475621b…` / harness `ebe1f7e6…` when
I started — exactly the identity the author's receipts carry — and production
never moved during this review. **Every run below is at the author's own
identity**, so the comparisons are exact rather than approximate. The harness
half moved to `7da70665…` only at the very end, when I added the one new probe
file, after every identity-sensitive run had finished
(`witness-followup-review2-receipts/identity-before.json`, `identity-after.json`).

Review receipts:
`docs/architecture/raptor3-evidence/g4/witness-followup-review2-receipts/`.
New probe (kept): `tests/raptor3/g4/review/witness-followup2/` —
`pool-background-failure.review.test.ts`, `review.workspace.ts`. The round-1
probes under `tests/raptor3/g4/review/witness-followup/` were re-run unedited.

---

## Outcome: **ACCEPT**

All four must-fix findings are repaired, and each was falsified by a run rather
than accepted from the note: I reproduced the author's falsifier for must-fix 1,
built two of my own for must-fix 2, re-derived the identity table of must-fix 3
independently, and executed the archive receipt's own two commands for
must-fix 4. Three of the six notes are fixed, two are disputed on grounds I
checked and accept, one is correctly delegated to the integrator. I supplied
the one falsifier the author labelled unverified (the pool listener) and it is
green. Nothing I found changes a public answer, an error identity, committed
state, or breaks a stated invariant.

The one lane that is still red — `g4-write-transport-seed-batch 100000` — is
red for a reason this round proves and I independently reproduced: G3's own
untouched `g3-generated-transport-smoke` fails with the identical signature at
the identical recipe offset. That is another stream's `src/`, and it is
recorded as an integrator request rather than claimed green.

### Suites run (serial, through the bounded runner and the workspace lock)

| Command | Result | Receipt |
| --- | --- | --- |
| `VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 … g4-write-seed-batch 75000` | gate verified, receipt **`seedCount:100`, 200 cells**, corpus 62,116,444 B | `mustfix1-ambient-count-attempt1.log` |
| `archiveG3GeneratedCorpus(<write child>)` then its own `restoreCommand` + `replayCommand`, verbatim | **"Raptor 3 replay contract gate verified"** | `mustfix4-archive-attempt1.log`, `mustfix4-restore-replay-attempt1.log` |
| `g4-write-seed-batch 75000` with the pinned count mutated to 2 | refused: `Missing candidate/profile/scenario cell … 1 !== 2` | `falsify-pin-effective-attempt1.log` |
| `g4-write-seed-batch 75000` with the count entry deleted | refused: `No registered cell count for g4-write-seed-batch` | `falsify-missing-cell-count-attempt1.log` |
| `g4-read-envelope-pg-contracts` (port 65504) | **5 / 5** | `native-pg-attempt1.log` |
| `g4-read-envelope-mysql-contracts` (port 65515) | **5 / 5** | `native-mysql-attempt1.log` |
| `g2-pg-contracts` (port 65504) | **18 / 18**, 6 files | `inherited-g2-pg-contracts-attempt1.log` |
| `g2-mysql-contracts` (port 65515) | 10 / 13 — the same three `unique-races-live-commands` cells, unchanged | `inherited-g2-mysql-contracts-attempt1.log` |
| `g4-write-transport-seed-batch 100000` | **red**, `g3-c11-100027-0:recurrence-0` | `write-transport-seed-batch-100000-attempt1.log` |
| `g3-generated-transport-smoke` (G3's own, untouched) | **red**, `g3-c11-8027-0:recurrence-0` — same offset 27 | `g3-transport-smoke-twin-attempt1.log` |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | `campaign-receipts-selftest-attempt2.log` |
| `scripts/raptor3-cli.test.mjs` | **9 pass / 1 fail**, no identity drift, 221.25 s | `raptor3-cli-selftest-attempt1.log` |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 (7.38 s, 5,934.4 MiB) | `typecheck-attempt1.log` |
| round-1 review probes (13 cells), unedited | 5 pass / 5 fail / 3 skipped — identical to the author's `review-probes-attempt1.log` | `review-probes-attempt1.log` |
| **new** probe: provoked background pool failure | **1 / 1 green** | `probe-pool-background-failure-attempt1.log` |

The first failed self-test invocation (`campaign-receipts-selftest-attempt1.log`,
exit 2) is mine and is kept: I called `run-node-safe.mjs` with the wrong
argument shape. It is a receipt of my mistake, not of the unit.

---

## Per-finding status

### 1. (was must-fix) Ambient seed count in the two write children — **RESOLVED**

Both repairs are present and each is load-bearing:
`tests/raptor3/g4/generation/write-campaign.test.ts:34` and
`write-transport-campaign.test.ts:29` pass `G4_WRITE_CAMPAIGN.batchSize` /
`G4_WRITE_TRANSPORT_CAMPAIGN.batchSize`; `scripts/run-raptor3.mjs:837` deletes
`VIBORM_RAPTOR3_GENERATED_SEED_COUNT` from every child environment beside the
subject.

My own command from round 1, re-run here, now yields
`{firstSeed:75000, seedCount:100, cells:200, qualifying:true}` and a corpus of
62,116,444 B — the same length as the full child of the follow-up, so the child
really ran the frozen batch rather than reporting it. Grep confirms the delete
is a pure hardening: only G3's two children read the variable (with a `??`
fallback to `campaign.batchSize`) and nothing in the estate sets it.

**The unrepaired half is disputed soundly.** My probe cell "refuses a child that
holds fewer seeds than the frozen batch" is still red, and should be: I checked
the author's reason at source. `scripts/raptor3-campaign-receipts.test.mjs:716-733`
is a registered G3 cell that asserts `assert.doesNotThrow` on a 7-seed receipt
of a 100-seed batch — a truthful short batch is admitted **by design**, and my
own finding said "this finding is not a request to change G3". The leak is
closed at the two doors that are this stream's.

The misleading retained log is handled the right way: `probe-sqlite-1seed.log`
is byte-unaltered and a sibling `…ANNOTATION.md` records what the run covered.

### 2. (was must-fix) Unregistered child cell counts — **RESOLVED**, falsified twice by me

`scripts/run-raptor3.mjs:954-959` registers both write modes, and `:1021-1024`
adds the class guard. I backed the runner up to the scratchpad (sha
`3c4fbcf9…`, the same sha the author recorded), then:

- **the pin is effective** — changing the registered count to 2 makes the mode
  refuse with `Missing candidate/profile/scenario cell in
  tests/raptor3/g4/generation/write-campaign.test.ts / 1 !== 2`;
- **the guard is effective** — deleting the entry makes the same mode refuse
  with `No registered cell count for g4-write-seed-batch` instead of running
  unpinned.

Restored from the copy; `shasum -a 256` is `3c4fbcf9…` again and `git diff`
shows the file back at blob `c9ccaf11`. The guard sits in `run()`'s success
path after the report is parsed, so it is reached for every mode, and my probe
cell confirms all twelve `*-seed-batch` modes are in both maps.

### 3. (was must-fix) The identity narrative — **RESOLVED**

The §14 preamble and §14.8 carry in-place retractions pointing at §15.4, and
§15.4's table is correct: my own walk over every JSON under
`receipts/followup/` reproduces it row for row —
`a50fe487/59a3f6e5` (04:44), `eb93c64d/854ad639` (04:53–04:54, the native runs
including the `42883` red), `d844ae0f/854ad639` (04:56, the write children),
`d844ae0f/72fbd01e` (04:57, the census snapshot only), `08861ba0/c7a5344f`
(05:03), `6c26242c/6e204375` (05:11). No receipt carries `72fbd01e…`, exactly
as the retraction now says.

I also checked the round's own claim rather than accepting it: **21 of the 22
identity-bearing JSONs under `receipts/repair/` read production `7475621b…` /
harness `ebe1f7e6…`**, and the 22nd is `identity-before-repair.json`
(`b100ea77…/b0bcc6cf…`), which is labelled as the round's opening bracket. One
identity for the whole round, as stated.

### 4. (was must-fix) The write lane's archive command — **RESOLVED**

`scripts/run-raptor3.mjs:665-681` routes `g4-write-` children through
`archiveG3GeneratedCorpus(receiptDirectory)`; the ternary order keeps the G4
*read* lane on the subject-bearing command. I did not read this and stop: I
called `archiveG3GeneratedCorpus` on a real write child exactly as the parent
does, took the `restoreCommand` and `replayCommand` it wrote, and ran them
verbatim — `gzip -dc` into a temp dir, then `run-raptor3.mjs replay` on the
restored bytes → **"Raptor 3 replay contract gate verified"**. The restore step
the receipt documents now has a consumer.

### 5. (was note) Duplicated `nativeDateTime` — **RESOLVED, more strongly than asked**

`tests/raptor3/g4/native/read-envelope-native.test.ts:86-90` names the two arms
and `:604` adds `g4-native-datetime-literal-matches-the-adapter`, which pins
**both** arms against `PostgresAdapter`/`MySQLAdapter` `.literals.dateTime(iso).values`
for four instants — my probe only covered MySQL. `G4_NATIVE_PROVIDER_COUNTS` is
5 and is shared by both provider count maps; both native modes ran 5/5 for me,
so the pin is exercised twice per round.

My own probe cell is red for the reason the author gives, which I verified from
the log: it lifts the MySQL arm out of `nativeDateTime`'s **source text** and
evaluates it with `new Function`, so naming the arm put `mysqlDateTime` out of
scope — `ReferenceError: mysqlDateTime is not defined`. That is my probe's
fragility, not the fixture's.

### 6. (was note) The unread background-failure listener — **RESOLVED for PostgreSQL; MySQL scope disputed soundly; I supplied the missing falsifier**

`tests/raptor3/transitions/live-world.ts` now subscribes the fixture
(`watchPgPool`, `:392`) on both the main and the peer pool and files the failure
into the same private slot `assertHealthy()` reads (`transportFailed`, `:208`),
so all existing call sites surface it; the teardown rethrow (`:653-655`) is
guarded by `!bodyFailed` and sits after the close-failure branches, so **it
cannot mask a body failure**.

`note.md` §15.11 claim 3 labels as unverified that the listener would surface a
real failure — no background failure was provoked. I provoked one
(`tests/raptor3/g4/review/witness-followup2/pool-background-failure.review.test.ts`):
on a pool built through the same `PgDriver`-subclass path the fixture uses, with
the same `pool.on("error", …)` subscription, terminating the idle backend from a
second connection delivers to the subscriber in 118 ms. **Green.** The transport
mechanism the repair depends on is real.

MySQL scope is right: `MySQL2Driver.initClient()` subscribes to nothing, so a
borrowed mysql2 pool behaves exactly as the fixture-built one did. The first,
provider-agnostic attempt is kept failed and unrelabelled — I read
`typecheck-attempt1.log` and its errors are genuine (TS2339 `query` missing,
four TS2740 on `Pool`), which is why the repair is PostgreSQL-scoped.

Residual, note only (N3 below): the wiring *inside* `runLiveWorld` is read, not
run against a provoked failure.

### 7. (was note) Stale patch and §14.7's ownership wording — **RESOLVED**

`receipts/repair/witness-harness-vs-0cc61e61.patch` is byte-current: I re-ran
the same `git diff` over the same ten tracked files and `diff -q` reports the
files identical, and `git hash-object` on the working tree matches every `index`
blob the patch records (`live-world.ts` `4b702c67`, `run-raptor3.mjs` `c9ccaf11`,
`raptor3-manifest.mjs` `7a13c895`, `raptor3-campaign-receipts.test.mjs`
`76ab1888`). `grep -c "^+++ b/src/"` is 0. §14.7 now says "no other stream
edited the three files this stream changed" and names `transport-plans.ts` as
the fourth dirty file in that directory.

### 8. (was note) The CLI self-test — **CONFIRMED, no action needed**

Reproduced: **9 pass / 1 fail**, 221.25 s, 217.1 MiB, no identity drift. All
three G4 cells green, including both the follow-up added. The single failure's
inner `test:all` is **11 failed / 747 passed** — the author's exact numbers — in
`core-structure/measurement/extension-campaign.selftest.test.ts` (CS-03 seeds
7133–7313) and `g3/generation/generated-transport-smoke.test.ts`. Nothing
registration-shaped. I also confirmed both write children are excluded from the
credential-free estate (`G4_WRITE_CAMPAIGN_TESTS` /
`G4_WRITE_TRANSPORT_CAMPAIGN_TESTS` are in `extendedLocalExclusions`, and no
exported manifest array contains them), so the new lanes cannot be adopted into
`test:all` by a file walk.

### 9. (was note) Stale §14 numbers and the red write-transport lane — **RESOLVED in the note; the lane is still red, and correctly attributed**

§15.7 re-measures everything at one identity. I reproduced the attribution
independently: `g4-write-transport-seed-batch 100000` fails at
`g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0;
actual=INSERT; expected=INSERT,SELECT`, and G3's own untouched
`g3-generated-transport-smoke` fails at `g3-c11-8027-0:recurrence-0` —
`100027 − 100000 = 27 = 8027 − 8000`. Same recipe, same offset, same production
identity. The red is phase 2's physical change, not `G4_WRITE_TRANSPORT_CAMPAIGN`;
the failure is kept red in `write-transport-100000-red/` and is integrator
request 5.

### 10. (was note) `g4.md` does not carry the new lanes — **PARTIAL, correctly delegated**

`handoff.md` §6.1–6.3 now carries the two frozen ranges, all six modes with
exact cell counts, the native count change, and three numbered integrator
requests. `g4.md` is not this stream's file; the brief's own ownership rule says
to write the request and continue, which is what was done.

### 11. (was note) The hand-listed disjointness set — **RESOLVED**

`scripts/raptor3-campaign-receipts.test.mjs:1073-1093` derives `occupied` from
the manifest, descending one level for the CS-03 slices, and asserts at least 16
ranges were found. I recomputed it: **16 ranges**, including the three CS-03
slices (7100–7399) that the old hand-kept list of three never compared, and both
write ranges are disjoint from all of them. Self-test 39/39.

---

## New notes for the integrator (none blocking)

### N1. (note) The runner's archive-branch choice has no registered pin

`scripts/raptor3-campaign-receipts.test.mjs:193` pins both forms of
`archiveG3GeneratedCorpus` in isolation and `scripts/raptor3-cli.test.mjs:230`
pins the write lanes' boundaries and subject refusal, but nothing pins **which
command `run()` hands which lane** (`scripts/run-raptor3.mjs:665-681`). A future
edit that moved `g4-write-` back under the subject branch — the exact defect
just repaired — would be silent. A cell that runs a `g4-write-` child through
the parent's archive step and asserts the receipt's `replayCommand` matches
`run-raptor3.mjs replay` would close it.

### N2. (note) The Biome delta is exactly as named

`tests/raptor3/transitions/live-world.ts` reports **17** diagnostics against 16,
the new one `lint/correctness/noUnsafeFinally` at `:655`, beside three of the
same rule already at `:647`, `:649`, `:650`. The other counts are unmoved and
exact (`run-raptor3.mjs` "Found 37 errors", `raptor3-manifest.mjs` 70), the two
write children report 0, and `read-envelope-native.test.ts` has no diagnostic at
or after line 600, so the fifth cell adds none.

### N3. (note) Two intended behaviour changes inside `runLiveWorld` worth knowing

`transportFailed` sets the private `failure` slot with `??=`, so a background
transport failure is reported in preference to a later body failure; and the
teardown throw discards the returned observation when `operationFailed` is true
(the fixture's own operation failed but the transport also died). Both are the
repair's intent. No registered PostgreSQL fixture provokes a pool error today —
eleven PG modes are green for the author and I re-ran `g2-pg-contracts` 18/18
and both native modes 5/5 — but a future fixture that deliberately kills a
connection will meet this.

---

## §7 decision-elimination gate, re-applied to the repair diff

Still no production file: `grep -c "^+++ b/src/"` over the byte-current patch is
**0**, and `find tests/raptor3/g4 -newermt "2026-09-15 05:40"` returns exactly
the three files the author names. No second public-syntax walker, per-verb
codec, duplicated result-shape preparation, recreated lifecycle, projection
rebuilt for a decoder, JavaScript arithmetic beside SQL, defensive
re-validation, policy-boolean bag, per-feature interpreter, fixture-named flag,
legacy import or fallback, cached absence, or public contract change.

Three decisions genuinely disappear in this round, each with a falsifier I ran:
a child's seed count is no longer a shell decision (falsifier: the ambient-count
command); an unregistered `*seed-batch` mode can no longer run unpinned
(falsifiers: the mutated pin and the deleted entry); and the write lane's
archived bytes are no longer documented by a command that ignores them
(falsifier: the receipt's own two commands, executed). The one-fact-one-authority
observation from round 1 stands and is now pinned rather than merely noted: the
MySQL datetime spelling is written twice, and a registered cell holds the copy
to the adapter's original.

## Cost

Re-confirmed, not accepted: incremental core and complete charged cost
**0 LOC / 0 parser tokens / 0 bytes**. Every changed file is under `tests/` or
`scripts/`; the patch names ten tracked harness files and no `src/` file; the
three untracked G4 files changed this round are the ones the README lists.

## Author claims still unverified after this review

1. **That no `src/` file was edited by this stream.** Unfalsifiable from here
   while another author writes `src/`, but every available signal agrees: 0
   `src/` files in the patch, only `src/query-engine/raptor3/shared/operation-context.ts`
   touched during the repair window (phase 2's), and production identity
   unchanged across my entire review.
2. **That `mysqlDateTime` and `toMySqlDateTime` stay in agreement.** Pinned for
   four instants against the adapter itself; the fixture still holds a copy,
   and only a production export would remove it.
3. **That a provoked background failure fails a `runLiveWorld` run.** I verified
   the transport half (probe green); the three-line path from
   `observation.transportFailed` to `assertHealthy()` / the teardown throw is
   read, not exercised by any cell.
4. **The disk projection** (≈ 679 MB for 250 children per lane) remains a linear
   extrapolation from one child per lane. The volume reads **3.7 GiB** free now
   against the 4.0 GiB the note recorded, so the recommendation to re-measure
   immediately before the campaign hardens.
5. **Neither write parent has ever been executed** (250 children each) —
   unchanged, and stated as such in §15.10 and handoff request 6.
