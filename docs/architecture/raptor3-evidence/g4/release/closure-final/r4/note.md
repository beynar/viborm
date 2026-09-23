# R4 — the evidence owners and the release-record scaffolding

Preparation for the final local closure: the D-64 witness registered where the
gate can see it, the checkpoint directory and the two tools that assemble its
index and its recount, the bundle/LOC readings confirmed to run on this tree,
and the decided contracts written into the CHANGELOG and the drivers overview
as contracts, marked pending until R1, R2 and R3 land.

Branch `closure-r4` from `cdd787ac8`, worktree `/private/tmp/viborm-r4`,
`TMPDIR=/private/tmp/viborm-r4-tmp`. No database. Nothing committed, staged,
checked out or pushed. **No engine change**: `git diff cdd787ac8 -- src/` is
empty and `git status --porcelain src/` is empty.

The frozen gate, the final bundle numbers and the final inventory/verdict text
are the integrator's, after R1–R3 land. Nothing here claims them.

---

## 1. The failing witness

Not a red behaviour — a red *inventory*. FC-04 measured it and the handoff §6
item 1 states it: the only pin behind ruling D-64,
`tests/raptor3/g4/review/cutover/d14-publication.review.test.ts`, **executes in
no vitest project**. Re-measured here, in the tree:

- `scripts/credential-free-test-manifest.mjs:263` excludes every path under
  `tests/raptor3/g4/review/` from the file walk that builds
  `EXTENDED_LOCAL_TESTS`;
- no manifest list names the file: `grep -rn "d14-publication" scripts/
  vitest*.ts tests/inventory.ts` is empty.

So the accepted read-only build contract — reads publish one statement, every
write refuses, and the folded single-statement write the previous engine could
build is **not** restored — had no gate coverage at all. An excluded review file
is not coverage.

## 2. The fact, and its owner

**The fact.** *`buildStatement()` / `QueryEngine.build()` answer the one
statement a READ compiles to, and refuse every WRITE with the registered
sentence.*

**The owner is unchanged and was not touched.** `QueryEngine.build()`
(`src/query-engine/query-engine.ts:126`) asks
`PendingOperation.buildStatement()` (`src/query-engine/pending-operation.ts:750`)
for the prepared read's own statement and raises
`Operation '…' does not compile to one SQL statement. Execute the operation
instead.` when there is none. The vocabulary the two accessors range over is
owned by `ROUTED_OPERATIONS` / `isReadOperation`
(`src/query-engine/routed-operations.ts`) — the same set the client, the
official cache and the extension surface consume.

**What R4 added is the witness, not a second owner:**
`tests/raptor3/g4/parity/read-only-build-contract.test.ts`, 3 cells,
credential-free, provider-free.

1. Every READ name in the vocabulary builds one `SELECT`; asking twice answers
   the SAME `Sql` object (identity, not equality — a second lowering would
   answer an equal but distinct one); `build()` answers the same text.
2. Every WRITE name answers `undefined` from `buildStatement()` and the exact
   sentence from `build()`, a nested relation payload included.
3. On a RETURNING dialect (`PostgresAdapter`, `postgresql`) the write the
   CHANGELOG names — a scalar `delete` the previous engine could fold into one
   statement — is refused exactly the same way, while the same engine still
   builds a read.

The cell list is not a hand copy: cell 1 asserts the file's payload table is
**exactly** `ROUTED_OPERATIONS`, so a verb added to the engine that neither
builds nor refuses fails here rather than at a caller. And the driver under all
three cells throws from every `initClient`/`execute`/`executeRaw`/`transaction`
entry point, so "without executing provider work" is enforced rather than
asserted.

### The registration

`scripts/raptor3-manifest.mjs`, `G4_PARITY_COUNTS` (the one edit the brief
authorises):

```
"tests/raptor3/g4/parity/read-only-build-contract.test.ts": 3
```

`G4_PARITY_TESTS` derives from that map, so the file joins
`RAPTOR3_DETERMINISTIC_TESTS` (projects `raptor3` and `coverage-raptor3`) and
`RAPTOR3_FIXED_LOCAL_TESTS`, and leaves the `extended-local` walk. Measured, not
inferred: **before** the registration the runner placed it under
`|extended-local|`; **after**, under `|coverage-raptor3|` and `|raptor3|`.
Registered count 3 = runtime count 3. The map now totals 24 files / 213 cells.

**The review file is kept where it is.** It is not a duplicate: five of its
nine cells — `prepareSingle` against `prepareBatch`, the array `$transaction`
member, the malformed member refused before dispatch, the provisioned route's
reach on a bare engine, and the three deleted direct-runtime arms — assert
facts the new parity file does not, and they need a live SQLite world the new
file deliberately does not open. It stays as history under
`tests/raptor3/g4/review/`, still outside every project, as the brief allows.

### Falsified three ways

`receipts/falsifications.log` — each mutation applied to a **backup copy**
(`cp` to `$TMPDIR`, restore by `cp`; no `git checkout`), `src/` clean
afterwards:

| mutation | result |
| --- | --- |
| `+ "createManyAndReturn"` in `ROUTED_OPERATIONS` | cells 1 and 2 red ("the engine's operation vocabulary changed; this contract has no answer for the new name") |
| the refusal sentence reworded in `query-engine.ts` | cells 2 and 3 red |
| `buildStatement()` answers a structural copy | cell 1 red (identity) |

## 3. The second consumer

The rule "the registered inventory, not a file walk, decides what the gate
runs" already had one consumer in this unit's reach and now has two:

1. `G4_PARITY_COUNTS` → `G4_PARITY_TESTS` → the vitest projects and the
   credential-free stages (the registration above).
2. `scripts/closure-final-index.mjs`'s **harness identity**: it hashes every
   test path ANY registered manifest names, from the manifest modules
   themselves, and lists a named-but-absent path rather than dropping it. The
   same list that decides what runs decides what the release record attests.
   Neither restates a file list of its own.

Likewise for measurement: `scripts/closure-final-recount.mjs` does not define a
token line, a charged file or a perimeter. It invokes
`scripts/measure-raptor3-baseline.mjs` (which itself executes
`query-engine-structure.mjs`'s own `countTokenLines`) and groups the answer.
`closure-final-index.mjs` in turn consumes the recount's output. One definition,
three readers.

## 4. The deliverables

### (a) `closure-final/README.md` — what the final index will contain

Source identity (commit, head, working tree, the `calibrationSourceIdentity`
hash and its scope), harness identity, Node/pnpm/lockfile identity, each gate
stage's raw log + exit code + resource/teardown line, the manifests, the bundle
table and the LOC table — with the exact command sequence that produces them,
and the rule that a stage whose source changed afterwards is invalid and must be
rerun.

### (b) `scripts/closure-final-index.mjs` — the assembler (new, 432 lines)

`--gate <dir> --out <dir> [--measurement <json>] [--recount <json>] [--label]`.
It measures nothing: it copies each raw log verbatim into `<out>/logs/` with its
own sha256, reads the exit codes from the gate's own `summary.log`
(`=== <stage>` / `exit=<n>`, the stage name being the WHOLE line after `===`,
so a multi-word stage such as `native mysql2 (docker)` keeps its code) and
reports a stage with no recorded code as **`unrecorded`**, never as zero. Every
header line resets the open stage, so an `exit=` can only belong to the header
directly above it; a code recorded under a name no `<stage>.log` carries is
listed under **summary stages with no log** rather than dropped. `summary.log`
is those codes' owner, not a stage of its own, so it is not walked as one. No existing receipts tool fits — nothing under
`scripts/` reads a gate log directory today — so this is a new owner, not a
second one.

**Dry run** on the integrator's last gate logs
(`…/scratchpad/fc/gate-closure/`, read-only), into
`closure-final/dry-run/`, **then deleted** as the brief requires. Receipt:
`receipts/closure-final-index-dry-run.md` — 40 stages, 663 registered test
files, index.md 21 KB / index.json 105 KB / 40 logs copied. 20 of the 40 stages
carry no exit code in that gate's `summary.log` and are reported `unrecorded`;
the tool never substitutes zero. Two further exit codes in that summary belong
to stage names no log file carries (`native mysql2 (docker)` and `native pg
(docker)`, **exit 1 each**): they are listed under "summary stages with no log"
rather than dropped or attached to a neighbouring stage. That gate ran against
`833318c5a` and is NOT a qualification of this tree.

### (c) Bundle and package measurement readiness

Both run on this tree, one run each, receipts kept. **Exact commands:**

```sh
node scripts/run-node-safe.mjs 2048 300000 \
  scripts/measure-raptor3-baseline.mjs --output <file>            # source only
node scripts/run-node-safe.mjs 3072 600000 \
  scripts/measure-raptor3-baseline.mjs --bundle --output <file>   # + bundles
pnpm package:build && pnpm size                                   # the fixtures
```

- `receipts/source-size-r4.json` — `source-accounted-bundle-pending`. The
  charged table reproduces FC-06's exactly: engine 38 files / **16,040** token
  LOC / 20,446 physical / 764,450 bytes; charged total 63 files / **23,833**.
- `receipts/source-size-r4-bundle.json` — `measured-source-and-bundles`: engine
  359,900 runtime / **101,309** gzip / 180 modules; `pg-simple` 655,957 /
  193,000 / 313; `pg-relations` 656,238 / 193,128 / 313.
- `receipts/size-run-r4.txt` — `pnpm package:build && pnpm size`, exit 0, all
  seven fixtures reported.

**One readiness gap the integrator must know about, and it is not mine to
close.** The 0.646 / 0.735 RATIOS divide by the frozen bundle baseline
`docs/architecture/raptor3-evidence/baseline.json` (commit `3a291a59`), which is
**untracked** and exists only in the primary worktree — it is absent here and
from the other sparse worktrees. The tool produces the final tree's own bundle
bytes without it; the division has to happen where that file is readable. Stated
in the README.

### (d) `scripts/closure-final-recount.mjs` — the recount (new, 316 lines)

`--out <dir> [--measurement <json>] [--unit <name>=<base>..<tip>]…`. It reports
the charged perimeter with FC-06's denominators — engine, integration, adapter
integration, the like-for-like total, `charged-g3-prep-shared` apart, and the
charged total — and divides by the three recorded old-engine readings, which it
carries as declared constants **with their provenance** because a revision whose
engine no longer exists cannot be re-measured from this tree.

Per unit it runs `git diff --numstat <base>..<tip>` over the whole tree and
buckets every path by the measurement's OWN classification, so a rule moved out
of the engine into a driver, an adapter, a codec or a migration lands in
`excluded-shared-boundary` where it is visible, instead of being absorbed. A
`src/` path the range DELETED is absent from the final tree's classification, so
it is bucketed as `removed-or-unclassified-production` rather than called
uncharged: a removed engine file is what the per-unit table exists to show. `tests/`, `scripts/`, `docs/` and `benchmarks/` are
reported beside it as the non-production volume they are.

**Dry run on `cdd787ac8`, receipt kept** (`receipts/recount/recount.md`,
`recount.json`): engine **0.3485** of the frozen 146-file census (target ≤ 0.60),
**0.3418** physical of `ff5e77ca5` (target ≤ 0.70) — the same numbers FC-06
reached by hand. Two sample ranges are bucketed (`36c87710a..cdd787ac8`:
charged-engine +291/−164; `a9e62d8dc..cdd787ac8`: no charged file touched). The
integrator supplies the four real unit ranges on the final tree.

### (e) The documents, marked pending

- **`CHANGELOG.md`** — three `[closure-final]` entries under a blockquote that
  says plainly they describe the tree once R1, R2 and R3 land and that the
  integrator strikes the marker: a connection must be representable (the shared
  reference requirement, both directions, found and create arms, single and
  compound, with the controls named); a selected bulk mutation carries its
  selector to the effect and a nested captured series is bounded (D-65's two
  bounds, with failure and commit kept separate and `FOR UPDATE` not
  over-claimed); native MySQL is part of local qualification (with the deadlock
  victim a failed transaction and the unique-key race unchanged).
- **`CHANGELOG.md`, the refusal paragraph** — rewritten to tell the three kinds
  apart, as §6 item 5 asks: an **invalid request** (nothing written, correct the
  request), an **operational database failure** (the provider's, normalized by
  the driver, may succeed next run), a **capability refusal** (a boundary that
  will not move by retrying); `EngineInvariantError` is none of the three. The
  23 is kept, said to be a count of sentences and explicitly **not** a coverage
  figure, and coverage is handed to the behavioural inventory. The wording
  follows the census's own three-outcome paragraph.
- **`docs/content/docs/drivers/index.mdx`** — a marked "Captured-set mutations,
  per route" section (both routes give the same answer; the difference is what a
  failure leaves behind, which is the transport's fact; the nested worklist is
  bounded; `FOR UPDATE` locks rows and does not exclude phantoms) and a marked
  "MySQL, locally qualified" section. The existing per-driver table is
  untouched — it states what is verified TODAY, and R2 has not landed.

Nothing dated and historical was rewritten, and no sealed receipt was edited.

## 5. The deletion

**No deletion.** This unit adds a witness, a checkpoint directory, two readers
and four document sections. It removes no rule, because it changes no rule: the
build contract, the vocabulary owner and the measurement owners are all
unchanged, and the one thing that was missing — the registration — is an
addition by nature. The review file is retained deliberately (§2); deleting it
would lose five facts nothing else asserts.

## 6. Retained cost

**Engine: unchanged.** `node scripts/query-engine-structure.mjs` before and
after: 38 files, 20,446 lines, **16,040 token lines**, 1,093 functions
(`receipts/query-engine-structure-after.json`; `git diff cdd787ac8 -- src/` is
empty). The charged perimeter is likewise unchanged at **23,833**.

**Non-engine, `git diff --numstat cdd787ac8`:**

| file | + | − |
| --- | --- | --- |
| `CHANGELOG.md` | 78 | 7 |
| `docs/content/docs/drivers/index.mdx` | 48 | 0 |
| `scripts/raptor3-manifest.mjs` | 1 | 0 |

**New files:**

| file | lines |
| --- | --- |
| `tests/raptor3/g4/parity/read-only-build-contract.test.ts` | 242 |
| `scripts/closure-final-index.mjs` | 432 |
| `scripts/closure-final-recount.mjs` | 316 |
| `docs/architecture/raptor3-evidence/g4/release/closure-final/README.md` | 87 |
| this note and `receipts/` | evidence |

The evidence tree adds ~1.5 MB, 1.4 MB of which is the two measurement JSONs the
two readers emitted.

## 7. Runs, and what they say

`receipts/runs.log`, `receipts/falsifications.log`,
`receipts/manifest-consumers-after.log`, `receipts/coverage-policy-after.log`,
`receipts/docs-validate-after.log`, `receipts/biome-after.txt`,
`receipts/typecheck-after.log`.

| run | result |
| --- | --- |
| the new pin, `run-vitest-safe run …/read-only-build-contract.test.ts` | 2 files / **6 cells** passed (3 cells × `coverage-raptor3` + `raptor3`), exit 0 |
| its three falsifications | 4 / 4 / 2 cells red respectively, then restored |
| one neighbour family — `cacheable-read-vocabulary` + `published-key` | 4 files / 30 cells passed, exit 0 |
| the manifest's own consumers — `raptor3-cli.test.mjs`, `raptor3-campaign-receipts.test.mjs` | 10/10 and 41/41, exit 0 each |
| `pnpm test:coverage:policy` (four script self-tests) | 11+16+6+7 pass, 0 fail, exit 0 |
| `pnpm --filter docs validate` (the docs site's validator) | exit 0, 11 warnings — identical to the base receipt `g4/release/closure/fc06/receipts/docs-validate-after.log` apart from the four-line pnpm invocation header this capture carries (5,278 vs 5,214 bytes); the validator's own output is unchanged |
| `node scripts/run-typecheck.mjs`, whole estate | **0 diagnostics**, 5.50 s, 5,119.6 MiB peak |
| Biome, per changed file against its base copy | the three NEW files clean; `raptor3-manifest.mjs` NOT formatted and rule-for-rule identical to its base copy (1 `useTopLevelRegex`, 71 `noMisplacedAssertion` on both) |

**Census: not run, and not owed.** No sentence and no error class changed;
`git diff cdd787ac8 -- src/` is empty. The CHANGELOG's refusal paragraph
reclassifies in prose and quotes the census's existing 23 without moving it.

No wide run was launched, one vitest at a time, no second validator beside the
shared lock, no lock file removed, no connection string touched (this unit has
no database).

## 8. Unverified, and out of scope

1. **The three `[closure-final]` document entries are unexecuted by
   construction.** They state the DECIDED contracts of the handoff §1 as R1, R2
   and R3 will implement them. They are marked as such and the integrator
   strikes the marker; if a unit lands a narrower contract, the entry must be
   corrected to what landed, not the reverse.
2. **The dry-run index was assembled from the integrator's 2026-09-21 01:22
   gate logs**, which ran against `833318c5a`. It proves the tool, not this
   tree. The dry-run directory was deleted.
3. **The bundle RATIOS are not computed here** — the frozen baseline file is
   untracked and absent from this worktree (§4c). The bundle BYTES are measured.
4. **A stale docblock I did not touch.**
   `tests/raptor3/g4/unit02/decimal-having-operand.test.ts:15–18` still says
   "The cutover makes `PendingOperation.buildStatement()` answer `undefined` for
   every operation", which is false of this tree under D-64 — reads publish. It
   is another unit's file, narrating what the cutover did at its own date, and
   the cell it guards is green. Reported rather than edited, to keep this unit's
   hunks local; the integrator may fold a one-line correction.
5. **Two current-state claims are now stale and are the INTEGRATOR's to
   strike, not mine.** `g4/final-report.md:373` item 13 and
   `g4/release/closure/fc06/release-verdict-draft.md:152` item 3 both say
   "D-64's own pin executes in no vitest project". That is true of
   `d14-publication.review.test.ts` and no longer true of the CONTRACT: it is
   registered as of this unit. The brief assigns the final inventory and
   verdict text to the integrator after R1–R3 land, so both are left as they
   are and flagged here and in the ledger's Adopted D-64 record. The sealed
   FC-04 and FC-06 receipts that state the same measurement are historical and
   correct at their own date; they are not touched.
6. **`pnpm --filter docs check` is red at the base** (324 errors, mostly
   TypeScript in archived evidence `.ts` files) and was not run again; `validate`
   is the step that covers content, and it is unchanged.

## 9. Blockers

**None.** No hard blocker, no exhausted repair budget, no second repair attempt
of the same minimized failure. The single readiness gap (§4c, the untracked
bundle baseline) is a location problem with a stated workaround, not a missing
mechanism.

---

## 10. Repair round (2026-09-21)

Six review findings, all applied; none declined. Two were real defects in the
two readers this unit contributes, four were claims in this note, the ledger or
the CHANGELOG that did not match what the tools or the census actually do. **No
`src/` and no `tests/` file changed in this round** — the engine stays at 16,040
token-bearing LOC, the registered inventory stays at `G4_PARITY_COUNTS` 24 files
/ 213 cells, and no test was deleted, skipped or weakened.

### (1) major — the exit-code parser dropped the multi-word native stages

`scripts/closure-final-index.mjs`. `SUMMARY_STAGE` was `/^===\s+(\S+)\s*$/`,
one token, so the integrator's own `=== native mysql2 (docker)` and
`=== native pg (docker)` headers matched nothing. Worse, the open `stage` was
cleared only after an exit was consumed, so a dropped header's `exit=n` was
attributed to the PREVIOUS stage. The reviewer's synthetic probe made the
consequence exact: a gate whose summary reads `=== alpha` (no exit) then
`=== native pg (docker)` / `exit=0` printed `` | `alpha` | 0 | `` — a zero
substituted for a stage that recorded none, which is precisely what the tool's
docblock and README item 4 promise never happens. On the integrator's real gate
directory the two RED native lanes (`exit=1` each) vanished from the index
entirely.

The header is now the WHOLE line after `===`, and EVERY header line resets the
open stage — a header this reader cannot parse now loses its own code rather
than lending it to its neighbour. A code recorded under a name no `<stage>.log`
carries is listed in its own **summary stages with no log** table (and in
`index.json` as `stagesWithoutLog`) instead of being dropped; no mapping from
`native mysql2 (docker)` to `mysql2.log` is invented here, because the
integrator's stage names are the integrator's, not this reader's.

Re-run: 40 stages, 20 `unrecorded`, 20 recorded, and
`| native mysql2 (docker) | 1 |` / `| native pg (docker) | 1 |` now visible.
Probe re-run: `alpha` is `unrecorded`.

### (2) minor — `summary.log` was walked as a stage of its own

Same file. The readdir walk filtered on `isFile()` only, so `summary.log` became
a phantom `summary` row whose `Test Files` / `Tests` cells were scraped from the
counts it had copied from the mysql2 lane. It is the exit codes' OWNER, not a
stage; it is now excluded from the walk. The advertised count was 40 stages plus
the summary file, so the dry-run receipt, this note and the ledger now say
**40 stages / 40 logs copied / 20 unrecorded**.

### (3) minor — a deleted production file was reported as uncharged

`scripts/closure-final-recount.mjs`. `classificationOf` is built from
`measurement.files`, which the reader measured on the FINAL tree, so a `src/`
file a unit DELETED is absent from it and `bucketOf` fell through to
`uncharged-production` — an engine file a unit removed was reported as not
charged, in the very table handoff §6 item 4 asks to show actual removed rules.
The reviewer's probe on a commit that deletes
`src/query-engine/raptor3/program/{index,program}.ts` reported
`| uncharged-production | 3 | 26 | 652 |` and no `charged-engine` bucket.

Unmatched `src/` paths now bucket as **`removed-or-unclassified-production`**.
No class is re-derived from a path rule here: that would make this script a
second owner of the classification it exists not to restate. The kept dry run
was re-captured; totals and both ratios are unchanged (engine 0.3485 of the
frozen 146-file census, 0.3418 physical of `ff5e77ca5`), only the bucket name
moved.

### (4) minor — the CHANGELOG credited the census with the wrong three

The refusal paragraph attributed its invalid-connection /
operational-failure / capability-refusal reading to
`scripts/raptor3-refusal-census.mjs`. The census tells a DIFFERENT three apart
by construction — invariant, internal (private fit), refusal, the last split
inherited vs candidate — and classifies nothing as an invalid request or an
operational database failure. The paragraph now says the three kinds are the
changelog's own reading and attributes to the census only what it reports:
23 distinct CANDIDATE sentences (30 sites), the number its own Counts table
carries.

### (5) minor — "byte-identical" was not true of the docs-validate receipt

`cmp` of R4's receipt against FC-06's fails at char 1: R4's carries four extra
leading lines (the `> docs@ validate …` / `> blume validate` pnpm header),
5,278 vs 5,214 bytes. `diff` is `0a1,4` and nothing after it, so the validator's
OUTPUT is unchanged — only the word was wrong. note.md §7, `g4.md` and
`receipts/biome-after.txt` now say "identical apart from the pnpm invocation
header", with the byte counts.

### (6) minor — the review file's unique-cell count was five, and is seven

Only two of `d14-publication.review.test.ts`'s nine cells are covered by the new
parity file: its read-verb build cell and its write-refusal cell. The other
SEVEN are unique. Two of the seven matter beyond history, and the note now says
so plainly:

- its first cell asserts the publication contract's central fact — the published
  `Sql` IS the statement the execution submits (`driver.submitted[0].statement
  === published.toStatement("?")`, one execution, no transaction). The parity
  file cannot assert it: its driver throws from every execution entry point,
  which is how "no provider work" is enforced there. `grep -rln buildStatement
  tests/` finds no other registered file asserting published-equals-submitted.
  **Publication-equals-execution therefore remains unregistered in every vitest
  project.** The new witness does not close that gap; it closes D-64's read-only
  BUILD contract, which is the clause the ruling asks to register.
- its fourth cell pins the unknown-verb sentence, the malformed-payload refusal
  at the accessor and `Schema registry is required for query engine`.

The reviewer offered a second remedy — add a cell using a recording, non-
throwing in-memory driver. Not taken, and why: that driver would remove from
that one cell the mechanism the whole file relies on to PROVE no provider work
happens, and this witness's registered scope is D-64's build contract, not the
publication seam. Stating the gap where the reader looks for it is the honest
answer and leaves the seam visible for whoever registers it.

### Runs

| run | result |
| --- | --- |
| `closure-final-index.mjs` on the integrator's gate directory | 40 stages, 2 summary stages with no log (**exit 1 each**), 20 `unrecorded`, exit 0; dry run deleted again |
| the reviewer's misattribution probe, re-run | `alpha` now `unrecorded`, the multi-word stage's code under its own name |
| `closure-final-recount.mjs` deletion probe | `removed-or-unclassified-production` 3 files / +26 / −652 |
| `closure-final-recount.mjs`, kept dry run re-captured | engine 16,040 / charged 23,833, ratios unchanged |
| Biome, the repaired files | 3 files checked, no fixes applied |
| `node scripts/run-typecheck.mjs`, whole estate | **0 diagnostics**, exit 0, 5.62 s, 5,078.1 MiB peak |

No vitest run discriminates this round: no `src/` and no `tests/` file changed,
so the new pin (6 / 6), the neighbour family (30 / 30), the manifest's consumers
(10 / 10, 41 / 41) and `test:coverage:policy` (40 / 40) stand on §7's runs. The
census is still not owed — `git diff cdd787ac8 -- src/` is empty and no sentence
or error class moved. No database, no connection string, no wide run, one
vitest at a time (none needed), no lock file touched.

---

## Commit message draft

```
test(raptor3): D-64's witness registered where the gate can see it, and the closure-final record's scaffolding (R4)

FC-04 measured that the only pin behind ruling D-64 —
tests/raptor3/g4/review/cutover/d14-publication.review.test.ts — executes in
no vitest project: the credential-free walk skips tests/raptor3/g4/review/ and
no manifest names the file. An excluded review file is not gate coverage.

Register the read-only build contract in the normal inventory as
tests/raptor3/g4/parity/read-only-build-contract.test.ts (3 cells,
credential-free, provider-free): every read name in the engine's own
vocabulary builds one SELECT and answers the same Sql object twice; every
write name answers undefined from buildStatement() and the registered
"does not compile to one SQL statement" sentence from build(), nested payloads
included; and the write the previous engine could fold into one statement — a
scalar delete on a RETURNING dialect — stays refused. The payload table is
asserted to be exactly ROUTED_OPERATIONS, so a new verb that neither builds
nor refuses fails here; the driver throws from every execution entry point, so
"no provider work" is enforced rather than asserted. Falsified three ways.
One manifest registration: G4_PARITY_COUNTS += that file at 3.

The review file is kept as history: SEVEN of its nine cells assert facts the
parity file does not — only its read-verb build cell and its write-refusal cell
are covered here. Two of the seven matter beyond history. Its first cell pins
the publication contract's central fact, that the published `Sql` IS the
statement the execution submits (`driver.submitted[0].statement ===
published.toStatement("?")`, one execution, no transaction); this parity file
cannot assert it, because its driver throws from every execution entry point,
and no other registered file does either. **Publication-equals-execution
therefore remains unregistered in every vitest project**, and this witness does
not close that gap: it closes D-64's read-only BUILD contract, which is what the
ruling asks for. Its fourth cell likewise pins the unknown-verb sentence, the
malformed-payload refusal at the accessor and `Schema registry is required for
query engine`, none of which are registered here.

Add the closure-final checkpoint directory with its README (what the final
release index contains and the exact commands that produce it), and two
readers that assemble it: closure-final-index.mjs, which copies a gate's raw
logs verbatim, reads the exit codes from the gate's own summary.log — whole
multi-word stage headers included, an unrecorded stage reported as unrecorded
rather than zero and a code whose stage has no log listed rather than dropped —
and hashes every test path the manifests name as the harness identity; and
closure-final-recount.mjs, which reports the charged perimeter and the
per-unit git diff --numstat bucketed by the measurement's own classification.
Neither defines a token line, a charged file or a perimeter: both read
measure-raptor3-baseline.mjs, which executes query-engine-structure.mjs's own
countTokenLines. Dry-run on the integrator's last gate logs and on cdd787ac8;
the index dry run was deleted, the recount receipt kept.

Confirm the bundle and package readings run on this tree
(measure-raptor3-baseline.mjs with and without --bundle, pnpm package:build &&
pnpm size) and record that the 0.646/0.735 ratios need the untracked frozen
baseline that lives only in the primary worktree.

Write the decided contracts into the CHANGELOG and the drivers overview as
contracts — the shared reference representability requirement, D-65's two
bounds, native MySQL as part of local qualification — each marked
"closure-final, pending the units' landing" for the integrator to strike, and
rewrite the CHANGELOG's refusal paragraph to tell an invalid request, an
operational database failure and a capability refusal apart as the changelog's
OWN reading — the census separates a different three by construction
(invariants, private-fit internals, refusals), and is credited only with the 23
distinct candidate sentences it reports, kept as a count of sentences and said
not to be a coverage figure.

No engine change: git diff -- src/ is empty, engine 16,040 token lines and the
charged perimeter 23,833, both unchanged. Whole-estate typecheck 0
diagnostics.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
