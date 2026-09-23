# G4 witness follow-up — independent review of the round-3 verification pass

Reviewer: independent; did not author the unit, either repair round, or the
verification pass under review. Reviewed source: main tree
`/Users/arnaud/code/viborm`, branch `pattern-engine`, already containing the
change (nothing applied, nothing repaired here). Date 2026-09-15, 08:06–08:30
local.

**Filename.** The prompt asked for `g4/witness-followup-review.md`. That path
is already the round-1 review (REVISE, 05:37) and `witness-followup-review-followup.md`
is the round-2 review (ACCEPT, 06:22). Overwriting either would destroy a
receipt, so this round is written beside them under the chain's own naming.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`,
`g4/briefs/witness-followup.md`, `g4/witness/note.md` §§14–16 in full plus the
§13/§15 repair record, `g4/witness/handoff.md`, both prior reviews, the
cumulative patch, every JSON and log under
`g4/witness/receipts/{followup,followup-verify,repair}/`, and the current source
of every file the stream owns.

Review receipts: `g4/witness-followup-review3-receipts/`.
New probes (kept): `tests/raptor3/g4/review/witness-followup3/` — four suites,
18 cells. The round-1 and round-2 probe directories were **not** touched, so the
counts §15.8 and the round-2 review quote stay reproducible.

---

## Outcome: **REVISE**

The unit's substance holds. Everything the brief asked for is present, and
every deliverable reproduces at the **current** production identity
`a830d713…`, which is one identity newer than any number in the note: both
native modes 5/5, both landed G4-01 modes 83/83 and 200/200, the SQLite write
child byte-for-byte the same corpus length, the receipts self-test 39/39, the
typecheck clean apart from the two permitted Pattern TS2345, the archive →
restore → replay path green end to end, and the cumulative patch byte-current
with zero `src/` files. I went past the author at three points and found no
defect: the far end of the SQLite write range (99900–99999, never run before)
is green with identical quotas; the widened generator ceiling is inclusive and
admits seed 124999, the last seed of the transport lane, while refusing 125000;
and the write-transport red reproduces with the identical signature at the
identical recipe offset as G3's own untouched twin.

What fails review is the **record**, not the work. §16 says it exists because
"§15.7 measured every accepted claim at production `7475621b…` [and] the G4-02
phase-2 author has kept landing `src/` since". Its own receipts say production
was **still `7475621b…`** when it ran — the same fingerprint §15.7 carries —
and that the tree moved to `a830d713…` at 07:52, after every table row except
CLI attempt 2 had already been measured. The round therefore closes with its
numbers at an identity its closing bracket does not name, which is precisely
the condition it was opened to remove, and is the same class of error §15.4 was
a must-fix for. Two probes pin it and both are red. A third finding is that the
test corpus this unit owns is untracked and has no recorded bytes in any round,
so §16.3's "nothing in the fixture changed" cannot be checked by anyone.

None of this is blocking: I have supplied the missing measurement at
`a830d713…` and it all reproduces, so the fix is prose plus a citation.

### Suites run (serial, through the bounded runner and the workspace lock)

Opening identity `a830d713…` / `7da70665…`
([identity-before.json](witness-followup-review3-receipts/identity-before.json)).
Harness moved only as I added probe files; production never moved during a run
except where noted.

| Command | Result | Wall / peak RSS | Receipt |
| --- | --- | --- | --- |
| `g4-unit01-author` | **83 / 83**, gate verified | 4.35 s / 675.8 MiB | `mode-g4-unit01-author-attempt1.log` |
| `g4-unit01-review` | **200 / 200**, gate verified | 5.75 s / 748.3 MiB | `mode-g4-unit01-review-attempt1.log` |
| `g4-read-envelope-pg-contracts` (port **65504**) | **5 / 5**, receipt identity `a830d713…` | 3.71 s / 512.8 MiB | `native/pg-attempt1.log`, `native/pg-attempt1/` |
| `g4-read-envelope-mysql-contracts` (port **65515**) | **5 / 5**, receipt identity `a830d713…` | 3.82 s / 521.0 MiB | `native/mysql-attempt1.log`, `native/mysql-attempt1/` |
| `g4-write-seed-batch 75000` | green — 100 seeds / 200 cells / 600 replays, C08–C11 50 each, 40 two-actor, 40 faults, corpus **62,116,444 B** (the author's length exactly) | 6.70 s / 962.6 MiB | `write-seed-batch-75000-attempt1.log`, `write-campaign/sqlite-75000/` |
| `g4-write-seed-batch 99900` — **never run by anyone before** | green — last legal batch of the lane, max seed **99999**, same quotas, corpus 55,925,107 B | 6.37 s / 726.9 MiB | `write-seed-batch-99900-attempt1.log`, `write-campaign/sqlite-99900/` |
| `g4-write-seed-batch 75100` + `archiveG3GeneratedCorpus` + its own `restoreCommand` and `replayCommand`, verbatim | green; archive receipt carries **no `--subject`**; restored sha256 matches; **"Raptor 3 replay contract gate verified"** | 6.67 s / 857.7 MiB, replay 5.00 s / 808.2 MiB | `write-seed-batch-75100-attempt1.log`, `write-campaign-archive-attempt1.log`, `write-corpus-gate-replay-attempt1.log` |
| `g4-write-transport-seed-batch 100000` | **red, kept red** — `g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0; actual=INSERT; expected=INSERT,SELECT` | 4.77 s / 681.4 MiB | `write-transport-seed-batch-100000-attempt1.log`, `write-transport-100000-red/` |
| `g3-generated-transport-smoke` (G3's own, untouched) | **red** at `g3-c11-8027-0:recurrence-0` — offset 27 in both lanes, at `a830d713…` | 4.00 s / 531.9 MiB | `g3-transport-smoke-twin-attempt1.log` |
| `scripts/raptor3-campaign-receipts.test.mjs` | **39 / 39** | 0.40 s / 67.7 MiB | `campaign-receipts-selftest-attempt1.log` |
| `scripts/raptor3-cli.test.mjs` | **8 pass / 2 fail** — one is identity drift caused by another stream mid-run, one is the author's own `test:all` cell with the identical 11 failed / 747 passed signature. **All three G4 cells green.** | 227.37 s / 223.9 MiB | `raptor3-cli-selftest-attempt1.log` |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 at `pack.ts:1443` and `:2633` | 6.63 s / 5,853.4 MiB | `typecheck-attempt2.log` |
| round-3 review probes (18 cells) | **16 pass / 2 fail** — both failures are finding 1 | 0.91 s / 269.7 MiB | `review-probes-attempt2.log` |

`typecheck-attempt1.log` and `review-probes-attempt1.log` are **kept failed and
unrelabelled**: attempt 1 of the typecheck carried two TS18046 diagnostics in my
own new probe (an untyped `.mjs` import), which I fixed in my own file before
attempt 2. They are receipts of my mistake, not of the unit.

### Static checks

| Check | Result |
| --- | --- |
| `git diff 0cc61e61` over the patch's ten files vs the stored patch | **byte-identical**, 88,236 B; `grep -c '^+++ b/src/'` = **0** |
| Landed G4-01 vs `/private/tmp/viborm-g4-unit01` (43 files) | **one** file differs — `review/unit01-followup2/cursor-refusal.test.ts`, 1,574 → **1,670 B (+96)**, and the diff is exactly the three-line TS2638 repair |
| Registered G4 files vs the tree | 59 registered, **0** registered-but-absent; the 46 unregistered files are all `review/unit02`, `review/unit03`, `review/witness*` and `unit02/`, every one covered by a walk skip |
| `EXTENDED_LOCAL_TESTS` | 251 files, **0** under `tests/raptor3/g4/` |
| Frozen seed ranges enumerated from the manifest | **16**, the write lanes disjoint from all of them (see finding 8 for the four pre-existing twin overlaps) |
| `route-transactions.test.ts` | registered **11**, file declares **11** `test(` cells |
| Skips/only/todo in every landed or registered G4 suite | **none** |
| Non-`docs/` files written in the §16 window (07:49–08:06) | **0** — the "this round edited nothing" claim holds independently of the fingerprint |

---

## Findings

### 1. must-fix — §16's stated purpose is contradicted by §16's own receipts

**Location.** `g4/witness/note.md` §16 preamble and §16.1;
`g4/witness/receipts/followup-verify/README.md`, "Why the round exists".

§16 says: "§15.7 measured every accepted claim at production `7475621b…`. The
G4-02 phase-2 author has kept landing `src/` since, so the integrator would
otherwise carry accepted numbers taken against a tree that no longer exists."

The receipts say otherwise:

| Receipt | production | harness |
| --- | --- | --- |
| `repair/identity-after-repair.json`, `repair/native/pg-attempt1/attempt.json` (§15.7) | `7475621b…` | `ebe1f7e6…` |
| `witness-followup-review2-receipts/identity-before.json` (round-2 review open) | `7475621b…` | `ebe1f7e6…` |
| `witness-followup-review2-receipts/identity-after.json` (round-2 review close) | `7475621b…` | `7da70665…` |
| `followup-verify/identity-before.json` (§16 open) | `7475621b…` | `7da70665…` |
| every `followup-verify/**/{attempt,verified}.json` | `7475621b…` | `7da70665…` |
| `followup-verify/identity-after.json` (§16 close) | **`a830d713…`** | `7da70665…` |

So (a) production had **not** moved between §15.7 and §16 — the only difference
at the opening bracket is the harness half, and that moved because the *round-2
reviewer* added one probe file, which their own review states; (b) every §16
number except CLI attempt 2 was measured at exactly the identity §15.7 already
covered; and (c) production moved to `a830d713…` at 07:52, inside CLI attempt 1,
and **no table row was re-run afterwards**. The round closes with numbers at an
identity its closing bracket does not name — the condition it exists to remove.

**Probe.**
`tests/raptor3/g4/review/witness-followup3/evidence-identity.review.test.ts`,
cells "measured the accepted claims at a DIFFERENT production identity than the
round it re-measures" and "closes at the identity its own runs were taken at",
both red:

```
node scripts/run-vitest-safe.mjs run \
  --workspace=tests/raptor3/g4/review/witness-followup3/review.workspace.ts \
  tests/raptor3/g4/review/witness-followup3/
→ AssertionError: the verification pass ran at the repair round's own production identity 7475621b…
→ AssertionError: …/followup-verify/native/mysql-attempt1/attempt.json was measured at
  production 7475621b…, the round closed at a830d713…
```

**Resolution.** Correct the §16 preamble and the README to state what the
receipts state: the re-measurement was taken at the same production identity as
§15.7, the only new variable being the harness file the round-2 reviewer added;
production moved once, mid-round, and the table was not re-taken after it. Then
either re-run the table at the closing identity or cite this review's own
measurements at `a830d713…` (suites table above, receipts in
`witness-followup-review3-receipts/`), which reproduce every accepted claim.
The §15.4 correction is the model; this is the same class recurring.

### 2. must-fix — the two "changes vs the accepted record" are already in the accepted record

**Location.** `g4/witness/note.md` §16.3 bullets 1 and 2, and the summary handed
to the integrator ("Two findings the integrator needs… CHANGE VS THE ACCEPTED
RECORD").

§15.7 — inside the round that was **accepted** — already records
`g4-read-envelope-pg-contracts` at **5/5 "including the recursive fit"**, and
`g4-unit01-review` at **200/200, "the three finding-K probes of §14.5 are green
now"**. §15.4 consequence 2 says of the PostgreSQL `42883` in as many words:
"it is not red now at all". Presenting both as what this round discovered
overstates the round and understates §15: relative to §14.2/§14.5 they are
changes, relative to the accepted record they are unchanged.

**Probe.** Direct comparison of §15.7's table with §16.2's; no executable cell.
`grep -n "5 / 5 green" note.md` and `grep -n "200 / 200" note.md` both land in
§15.7 first.

**Resolution.** Say "unchanged since §15.7" for both bullets, and move the
attribution to phase 2 to §15 where it was first measured. The integrator needs
to know that the recursive-fit closure is **older** than this round, because it
tells them which phase-2 landing to associate it with.

### 3. must-fix — the test corpus this unit owns has no recorded bytes in any round

**Location.** `g4/witness/receipts/repair/witness-harness-vs-0cc61e61.patch`
(ten tracked files only); `g4/witness/production.patch` (six files only);
`note.md` §15.10 "the untracked G4 files this round changed are …".

`tests/raptor3/g4/**` is untracked (`git status` shows `?? tests/raptor3/g4/`).
The unit's **first** brief outcome is a repair to
`tests/raptor3/g4/native/read-envelope-native.test.ts`, and its second is the two
write children — none of the three appears in any patch, and no receipt records
their bytes at any round. Consequences the integrator inherits:

- §16.3's "nothing in the fixture changed" between the `42883` red of §14.2 and
  the green 5/5 is **unverifiable**: the fixture's §14 bytes no longer exist
  anywhere, and §15.5 did edit that file (`nativeDateTime` split into
  `pgDateTime`/`mysqlDateTime`, a fifth cell added).
- §15.8's "the probe files are the reviewer's and were not edited" is verifiable
  only while the round-1 probe files sit in the tree unchanged.
- The 43 landed G4-01 files are verifiable today **only** because
  `/private/tmp/viborm-g4-unit01` still exists; when that worktree is removed,
  the "one byte change" claim becomes uncheckable too.

**Probe.** `tests/raptor3/g4/review/witness-followup3/landed-unit01.review.test.ts`
— "changed exactly one landed file, and only where the TS2638 was" is green
today and is written to **fail loudly** (`assert.fail`) rather than skip once
the source worktree disappears.

**Resolution.** Per round, write a byte snapshot of the untracked files this
stream owns into its receipts directory — `shasum -a 256` at minimum, or a
`git diff --no-index` against the previous round's snapshot. Nothing needs to be
staged or committed, which the hard rules forbid.

### 4. note — half the disk projection rests on a child that no longer reproduces

**Location.** `note.md` §14.4 "Measured child cost" and "Disk projection, 250
children per lane"; carried forward unqualified in §16.5.

The transport row of the child-cost table (200 cells, 6.21 s, 65,805,021 B raw,
1,342,358 B gzip, **1,433,241 B retained**) was measured **green** at production
`d844ae0f…`. The lane has been red at `7475621b…` (§15.7, §16.2) and is red at
`a830d713…` (my run, same signature). The ≈ 679 MB projection is therefore
1 green child plus 1 child that cannot be reproduced on any tree that still
exists, and §16.5 repeats the figure without saying so while §16.6 claim 3 calls
the projection "the linear extrapolation" as if both halves were alike.

**Probe.** `write-transport-seed-batch-100000-attempt1.log` (red) beside
`receipts/followup/write-campaign/transport-100000/generated-campaign.json`
(green, `d844ae0f…`).

**Resolution.** Mark the transport half of the projection unverified at the
current tree, beside §16.6, and re-measure it when integrator request 5 closes.

### 5. note — the fifth native cell needs no provider, so "5 / 5 native" is 4 + 1

**Location.** `tests/raptor3/g4/native/read-envelope-native.test.ts:604-622`
(`g4-native-datetime-literal-matches-the-adapter`);
`G4_NATIVE_PROVIDER_COUNTS` = 5; `note.md` §16.2 and the followup-verify README,
which both print "5 / 5" with no caveat.

§15.5 discloses it ("The cell needs no provider and runs in both native modes"),
and the cell is sound — I verified the rule it pins holds far beyond its four
instants (probe below). But the headline number now counts the same
provider-free cell twice across the two modes, so a reader comparing §14.2's
"4 of 4 green" with §16.2's "5 / 5" sees a coverage increase that is not one.

**Probe.** `native-authority.review.test.ts` — "holds the duplicated MySQL rule
over far more than the four pinned instants" (406 instants including 1969,
1900, 2038 and 9999) and "registers exactly the cells the native file declares",
both green.

**Resolution.** One clause in the §16.2 row: "5 / 5 — four provider cells and
the provider-free adapter pin".

### 6. note — the landed reviewer suites are excluded from the credential-free lane by only one of the two mechanisms

**Location.** `scripts/credential-free-test-manifest.mjs:114-137` names
`...G4_UNIT01_AUTHOR_TESTS` in `extendedLocalExclusions` but not
`...G4_UNIT01_REVIEW_TESTS`, which is excluded only by the
`file.startsWith("tests/raptor3/g4/review/")` walk skip at `:250`.

There is no leak today — I recomputed `EXTENDED_LOCAL_TESTS` and 0 of its 251
files are under `tests/raptor3/g4/` — but the same fact (29 registered suites
stay out of `test:all`) is now decided in one place for the author half and
another for the review half. Narrowing the walk skip, which is what a later
stream will want when it lands its own review probes, silently adopts 29 suites.

**Resolution.** Add `...G4_UNIT01_REVIEW_TESTS` to `extendedLocalExclusions`
beside its sibling; it is idempotent with the walk skip and costs one line.

### 7. note — the far end of both write ranges had never been exercised; it is correct

**Location.** `tests/raptor3/g3/generation/recipe.ts:34-35`
(`GENERATED_SEED_CEILING = 124_999`, used as `.max()` and `<=`);
`note.md` §14.9 claim 1, §16.6 claim 2.

Only the first child of each lane had ever run, so nothing had ever touched the
seed where an inclusive/exclusive ceiling mistake lives — the transport lane's
last seed is exactly the ceiling. I exercised it: `generateG3Recipe(124999)` is
admitted and `125000` refused, the SQLite lane's last child (99900–99999) is
green with identical quotas, and every one of the 250 batch boundaries per lane
parses. Recorded as a note because the risk was real and is now closed, not
because anything is wrong.

**Probe.** `write-lane-range.review.test.ts`, six cells, all green, including
"admits the LAST seed of every write lane, not only the first" and "gives every
campaign PARENT a child mode that parses at both ends".

### 8. note — the write lanes break the estate's SQLite/transport twin-range convention

**Location.** `scripts/raptor3-manifest.mjs:779-794`.

Enumerating every frozen range in the manifest: `G1`, `G2`, `G3` and `G3P06`
each give their SQLite and transport campaigns the **same** range, so the
transport lane re-runs the SQLite lane's recipes under scripted profiles. The G4
read campaign broke that (20000 vs 50000) and the write lanes follow it (75000
vs 100000), which the brief prescribed. The consequence worth writing down:
the write-transport lane never re-runs the write-SQLite lane's recipes, so the
two lanes' cells are not comparable cell-for-cell the way G3's are, and the pair
consumes 50,000 IDs rather than 25,000.

**Probe.** Enumeration in `witness-followup-review3-receipts/` (the four
overlapping pairs are the pre-existing twins, not a defect).

### 9. note — blocker 2 is still live and it cost this review a run too

Another stream created `tests/raptor3/g4/unit02/decimal-having-operand.test.ts`
at 08:21:48 and rewrote it at 08:25:16 — inside my 227 s CLI self-test — moving
the harness fingerprint from `62b5f02f…` to `ec0c773c…` to `32af4729…`. Two
cells failed with `Stale Raptor 3 evidence`; one of them ("completed G2 progress
survives watchdog termination") is drift alone, the other is the author's own
`test:all` cell. The receipt is kept failed and unrelabelled. All three G4 cells
are green. The note's blocker 2 is accurate and, on the evidence of three
consecutive rounds plus two reviews, the CLI self-test cannot reach 10/10 until
the implementation streams stop.

### 10. note — the §14.6 census total is stale by the fifth native cell

`note.md` §14.6 records "387 cells across 54 files". The registered totals are
now **55 fixed files / 392 cells** (387 non-native, plus the native file's 5).
§16 does not restate 387, so nothing live depends on it; a reader carrying the
number forward would be one cell short per native mode.

---

## The §7 decision-elimination gate, answered against the actual diff

The diff is ten tracked harness files plus untracked tests; **no production
file** (`grep -c '^+++ b/src/'` = 0, confirmed against a regenerated patch).

1. **Does a decision disappear?** Yes, three. `runLiveWorld` no longer decides
   how a pool is configured — `PgPoolFactory`/`MySQLPoolFactory` return the pool
   the driver itself builds (`live-world.ts:347-371`), so `utcSafeTypes`,
   `timezone: "Z"`, `supportBigNumbers` and `dateStrings` have one authority
   (`src/drivers/pg/index.ts:170-186` returns a supplied pool unchanged, which
   is exactly why the old bare `new PgPool(options)` bypassed them).
   `runG3SQLiteBatch`/`runG3TransportBatch` no longer decide which campaign they
   belong to. `run-raptor3.mjs` no longer lets a seed-batch mode run unpinned.
2. **Is a second authority created?** One, named and pinned: `mysqlDateTime`
   duplicates the private `toMySqlDateTime`. `src/adapters/databases/mysql/mysql-adapter.ts:360`
   and `:454` confirm `literals.dateTime` is exactly that function, and the
   fifth native cell holds the copy to it. I widened the check to 406 instants
   and found no divergence. The only removal is a production export the brief
   forbids.
3. **Is the replacing invariant falsifiable?** Yes, and each falsifier was run
   rather than argued: the class guard refuses a mode with no registered count
   (round-2 reviewer, reproduced); the G3 recipe fingerprint is identical before
   and after the widening; the receipt assertion re-derives contract, actors,
   overlap and faults from the seed (I fed it a corrupted receipt through the
   self-test and it throws).
4. **Is any legacy mechanism reintroduced?** No. The native suite builds the
   candidate only, imports no shipped engine and no parity helper (probe cell
   "keeps the native expectations out of reach of either engine", green), and
   its expectations are literal contract values, not either engine's answers.

No second public-syntax walker, per-verb codec, duplicated result-shape
preparation, recreated lifecycle, projection rebuilt for a decoder, JavaScript
arithmetic beside SQL, policy-boolean bag, per-feature interpreter,
fixture-named flag, legacy import, cached absence or public-contract change.

## Cost check

The charged file list is `src/`-only. The regenerated patch contains **zero**
`src/` files and no non-`docs/` file was written in the round's window, so the
incremental core and complete charged cost is **0 LOC / 0 parser tokens /
0 bytes**, as claimed. `scripts/query-engine-structure.mjs` was not re-run: with
an empty `src/` delta the census could only re-measure another stream's absolute
figures, which this unit does not claim.

## Author claims this review could not verify

1. **That `src/` was never edited by this stream.** The patch and the mtime scan
   agree, but production moved twice across the rounds under another author.
2. **That the §14 fixture bytes differed from today's only as §15.5 describes.**
   Untracked, no snapshot — finding 3.
3. **That the two write parents work over 250 children each.** Three SQLite
   children of 250 have now run (75000, 75100, 99900) and zero transport
   children are green. The parents themselves remain unexecuted.
4. **That `watchPgPool` surfaces a real background failure.** The round-2
   reviewer provoked one and their cell is green; I did not re-provoke it.
5. **The three `g2-mysql-contracts` reds and the two `route-transactions` LX
   DIVERGENCE PINs.** Not re-run here; carried forward from §15.7 as the note
   itself carries them.
6. **The `test:all` inner failures.** Matched by signature (11 failed / 747
   passed, same two files), not diagnosed.
