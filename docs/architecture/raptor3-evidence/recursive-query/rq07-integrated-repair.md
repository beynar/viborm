# RQ-07 — integrated repair round (source-bound)

2026-09-23. This is the author record of the repair round that answers the
integrated adversarial review of the recursive-query feature (verdict REVISE:
4 major and 6 minor findings). **All ten requested changes were applied, and
none was declined.** It is not an acceptance verdict: the integrated
reviewer's re-check and the frozen gate still belong to their owners.

## Identity

| Fact | Value |
| --- | --- |
| Tree | `/Users/arnaud/code/viborm`, branch `pattern-engine`, HEAD `076fad02b1c77435ce7389a51996163c66aad819`, with the uncommitted feature tree preserved. Nothing was staged, committed, stashed or checked out. |
| Runtime / runner | Node `24.21.0`; `scripts/run-vitest-safe.mjs --heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000`; `scripts/run-typecheck.mjs`; `scripts/run-node-safe.mjs 512 60000`. `TMPDIR=/private/tmp/viborm-rq-int-repair-tmp`, which holds every log and probe named below. One run at a time, each started only after the process table showed no other vitest or typecheck. |
| Backups | Every edited file was copied to `$TMPDIR/backup-before/` before its first edit (`sha-before.txt`). |
| Falsification | Only out-of-tree copies, served by a Vite `resolveId` redirect (`$TMPDIR/witness/redirect-any.mjs`), each printing a load marker. No working-tree file was mutated. |

| File | SHA-256 before | SHA-256 after | Lines |
| --- | --- | --- | --- |
| `src/query-engine/raptor3/shared/query.ts` | `140edb00…9cf21` | `658afd6187ca4c0c7dc38f54ab31a1fd7566740978d8d81c61f578afe34a3908` | +9 / −8 |
| `src/validation/relations/recurrence.ts` | `31cfe13c…90af3` | `f638cb160394d9fbca1b0441c2387ed47765d996d822c01178b65756f810e8bc` | +13 / −0 |
| `src/query-engine/result/cache-value-codecs.ts` | `324d612c…c3484` | `2f3526108d5635d863e52194ec83a381d68b141435ba72b5446fac06394ff364` | +2 / −1 |
| `tests/raptor3/recursive-query/carrier-boundary.test.ts` | `5b680217…78605` | `90fe2463c99bf2726c1a5f403ee23145aa2e9b26bfa01c0160903accdfa0eb39` | +17 / −0 |
| `scripts/raptor3-manifest.mjs` | `e6e50f1e…ca82` | `e312fae664988aa5b9653fa523d19636d7974aece76be8a639b2ddf905bf873e` | +2 / −2 |
| `scripts/credential-free-test-manifest.mjs` | `6b69fd7e…d7eb` | `2a543444886278662d4ab96f8dd8373f55878bd4da53be49dcea12fed4036981` | +5 / −0 |
| `scripts/raptor3-refusal-census.mjs` | `0fca0aa3…7128b` | `13d2c5032e8bdcc5b48960ef321e8bc4948e96b4b13e7c8b67a27759f06b622d` | +4 / −4 (comment) |
| `docs/architecture/raptor3-evidence/recursive-query/rq6-campaign-sqlite.json` | `86da2ebd…2926` | `881ba8994d4020cf47832f919c408e17110f319d345fae1ebd60cc3f9203275f` | regenerated |
| `docs/architecture/raptor3-evidence/recursive-query/rq6.md` | `63aa7848…ab02` | `e6a039dbd62f37db2b418f1030c33cc1d986df0013540edf1ffc6efb1d9df9e9` | +1 / −1, plus the addendum |
| `docs/architecture/raptor3-evidence/recursive-query/rq07-release-verdict.md` | `fe84befb…d77d` | `0c7f289fb97e024fe9017d54d554a3bf334f633b48983f9c0b1808bfda3bbf73` | +18 / −8 |
| `docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md` | `2026b2f7…7085` | `19e3fb63e517c796986c01ae609ca8ab2a4527b80a0a8167613f7a2e61347e77` | +2 / −2 |
| `src/query-engine/raptor3/AGENTS.md` | `351273cc…fc71` | `0abd1f028b23abba14e54b94e839282b280ac20b81bf72578082e994b14d7dc0` | +21 / −18 |
| `CHANGELOG.md` | `ad5e3513…e042` | `99d6e6205d232326e333a247a67be3d5946b732833a3a271cab30f47668cfbbb` | +10 / −5 |
| `docs/content/docs/client/selecting.mdx` | `8b02ae2b…fcabd` | `f890670536e71c53c1148e022d8742b11f5011a384b330131a7be0164139225c` | +6 / −0 |
| `features-docs/recursive-query.md` | `24ec3985…47aa` | `f6de1b39cf884ae6d7217357b13d4487bac8bb1b78b92c29e597043accec5432` | +3 / −2 |
| `README.md` | `6a85a0ed…add2f` | `7f00d18e708e4464974882d4df707f55b80f8639b5bc5d81b97aedc98f8bb17c` | +1 / −3 |

Unchanged and still final: `campaign-harness.ts` `beec8325…`,
`campaign-sqlite.test.ts` `fd13bb5b…`, `graph-oracle.test.ts` `6fd84700…`,
`fixed-cases.ts` `6a0691a5…`, `graph-oracle.ts` `b16b9298…`,
`cache-codec.test.ts` `b882822f…`, `cache-lifecycle.test.ts` `1eaa0a2b…`.

## Finding → change → file → run

### F1 (major, RQ-07 integrator with the rq6 ledger) — undocumented post-review edits and a stale receipt

- **Change.** A dated addendum was added to `rq6.md`: "Post-review addendum
  (2026-09-23, RQ-07 integrated repair round)", sections A1–A3. For each of
  the three edits (the `orderOnly` guard, the 7th cell, and the graph-oracle
  ring and ORACLE-ONLY change) it gives the reconstructed before-bytes, the red
  and green witness, the reviewer and the final SHA-256.
  - `rq6.md:316`: `campaign-sqlite.test.ts` now reads **7** cells.
  - `rq6-campaign-sqlite.json` was regenerated on this round's frozen tree
    with `VIBORM_RQ06_RECEIPT_DIR=$TMPDIR/receipt`, then copied into place.
    Its `source.files` now names `campaign-sqlite.test.ts` `fd13bb5b…`, the
    bytes on disk.
- **Reconstruction.** The working harness minus the three guard lines hashes
  to `3bfe24eeb91c368baef6e1e31ad356394607b308f505aaaf9bc597078640c809`. The
  working `campaign-sqlite.test.ts` minus the cell, the two regex constants
  and the `judgeOutcome` import hashes to
  `0ec4d9abdbccbdb1eec260a86ccf9eb13564fde5c6848ee634eef8af9c1e10d8`. Both
  match the abbreviations at `rq6.md:33`. The pre-edit `graph-oracle.test.ts` is the
  preserved `322c757ad79a7c48…686f` copy (the rq34 review tree), which
  `rq01-sql-placement.md:29` records.
- **Runs.**
  - `run-b-finding1-witnesses.log`: one invocation, six projects.
    - The 7th cell against the pre-guard harness: **red**, owner
      `sibling order: …`.
    - The old graph-oracle file passes 9/9 on the working corpus, 9/9 on the
      pre-CM002 corpus and 9/9 on a self-consistent ring-less corpus.
    - The new file is **red** at `:307` on the pre-CM002 corpus and **red** at
      `:319` on the ring-less corpus.
    - Totals: 3 failed (the expected reds), 43 passed, 6 skipped.
  - `run-d2-green-affected.log`: `campaign-sqlite` **7/7** and `graph-oracle`
    **9/9**, with the receipt written.
  - Receipt against the replaced one, field by field: only `source` differs.
    The `src/` digest moves from `7668803d…` to `824cdafb…d893` because this
    round changed `query.ts`, `recurrence.ts`, `cache-value-codecs.ts` and
    `src/query-engine/raptor3/AGENTS.md` (F5–F8; the guide is hashed with
    `src/`). Corpus, runtime, chunking, totals (300/300/0/300) and all 300
    verdicts are identical.
- **Typecheck.** The one typecheck below covers these bytes.

### F2 (major, RQ-07 integrator) — stale cache counts; the recursive SQLite suites had left `pnpm test:all`

- **Change.**
  - `scripts/raptor3-manifest.mjs:502–503`: `cache-codec.test.ts` 9 → **10**,
    `cache-lifecycle.test.ts` 6 → **7**.
  - `scripts/credential-free-test-manifest.mjs`: `RAPTOR3_FIXED_LOCAL_TESTS`
    gains `...RQ06_GRAPH_ORACLE_TESTS, ...RQ06_CARRIER_BOUNDARY_TESTS,
    ...RQ01_SQLITE_TESTS, ...RQ05_CACHE_TESTS, ...RQ06_COMPOSITION_TESTS`,
    appended after `...G1_TRANSPORT_TESTS`.
- **Runs.**
  - `run-d2-green-affected.log`, through the registered `raptor3` project:
    `cache-codec` **10/10**, `cache-lifecycle` **7/7**. Both match the new
    counts.
  - `manifest-membership.txt`: the fixed stage lists 96 files (was 89), with
    no duplicates. Seven of them are recursive-query files: graph-oracle,
    carrier-boundary, provider-sql-sqlite, cache-codec, cache-lifecycle,
    composition and campaign-sqlite. All seven are in the `raptor3` project,
    none is in `EXTENDED_LOCAL_TESTS`, and no native or PGlite list entered
    the stage.
  - `campaign-receipts-selftest.log`: `scripts/raptor3-campaign-receipts.test.mjs`
    **41/41**. This includes "G4 suites stay outside credential-free discovery
    while they are red", which keeps `G4_NATIVE_PG/MYSQL` (now carrying
    `provider-sql-native` and `campaign-native`) out of the fixed stage.
- **Not run.** The fixed stage itself (`pnpm test:all --only "Raptor 3
  fixed"`). It is a wide run and belongs to the frozen gate (see
  Unverified).

### F3 (major, RQ-07 docs) — the CHANGELOG over-claimed qualification

- **Change.** `CHANGELOG.md` old lines 21–25 are replaced by the requested
  text, verbatim: "Not yet qualified. Executed on SQLite … has not yet been
  observed natively." It is re-wrapped to the entry's 80-column indent and
  sits at lines 23–30. F4's size sentence precedes it at lines 21–23.
- **Run.** None, since this is prose. A grep for the retired relation
  spellings the relation-language census bans finds none in the added text.

### F4 (major, RQ-07 docs) — the public docs omitted the exponential-output limit and the clause limits

- **Change.** `docs/content/docs/client/selecting.mdx` gains the requested
  paragraph, verbatim, as its own paragraph at lines 184–188. It sits
  immediately after the paragraph that contains line 176 (lines 170–182).
  Line 176 itself is mid-sentence ("… the node's
  `select`/`include`/`omit` — including other"), so inserting right after it
  would have split that sentence.
- The size sentence is repeated at the start of the CHANGELOG entry's closing
  text (`CHANGELOG.md:21–23`).
- **Run.** None, since this is prose.

### F5 (minor, RQ-01 decoder / RQ-03 query author) — the `raw === undefined` guard caught nothing new

- **Change.** In `query.ts` `decodeOccurrence`, the two lines
  `if (raw === undefined) throw new TypeError("Invalid provider recursive node reference");`
  are deleted. That sentence is also removed from refusals-map RQ-3 (see F9).
- **Red/green witness.** The probe `$TMPDIR/probe/rq07-repair.probe.test.ts`
  prints outcomes and asserts nothing, so the same file ran before and after
  the edit. For a node without `__rq_row`:
  - before (`probe-before.log`): `TypeError: Invalid provider recursive node reference`;
  - after (`run-d1-probe-and-falsifications.log`, project `p0-probe-after`):
    `InvalidScalarResult: Invalid provider row`.
  The input is still refused, now by the ordinary row decoder. The
  well-formed control is accepted both times. `carrier-boundary` passes
  **12/12** after the edit.
- **Deleted.** The guard and its sentence. The census on the repaired tree no
  longer lists the sentence (`census-after.md`).
- **Second placement.** None: this is a deletion. The refusal that remains is
  the row decoder's own.

### F6 (minor, RQ-03 query author) — an unreachable state was published as a refusal

- **Change.** In `query.ts` `required()`, the
  `if (!shape.many && !shape.optional) throw new QueryEngineError("Required relation '…' returned no record.")`
  is replaced by
  `assertInvariant(shape.many || shape.optional, "A singular recursive slot may be empty: CM002 refuses a required self foreign key.");`.
  The line `return shape.many ? [] : null;` is kept.
- **Refusals-map.** RQ-2's kind is now **invariant**, as RQ-5's already was.
  The row's sentence, site, guard, reachability and disposition now describe
  the invariant at that site, `shared/query.ts:4673` on the repaired tree.
  The replaced sentence no longer exists anywhere in `src/`.
- **Red/green witness.** The same probe forces the admitted singular slot's
  published shape to `optional: false` (no admitted schema publishes one) and
  decodes an empty carrier:
  - before: `QueryEngineError: Required relation 'next' returned no record.`;
  - after: `EngineInvariantError: A singular recursive slot may be empty: CM002 refuses a required self foreign key.`.
  The admitted slot publishes `optional: true` and answers `null` both
  times. After the edit, campaign-sqlite's CM002 cell (the required schema is
  refused before any projection) and carrier-boundary's "answers an empty
  singular carrier with null" are green.
- **Census.** The site is counted under `assertInvariant`. Biome's
  `useSimplifiedLogicExpression` count on `query.ts` drops from 6 to 5,
  because the De Morgan form is gone.
- **Deleted.** The refusal sentence (its only site).
- **Second placement.** None, because nothing else stated that fact.

### F7 (minor, RQ-05 cache with the RQ-03 query author) — one rule spelled in two runtime places

- **Change.**
  - `src/validation/relations/recurrence.ts:18` exports
    `carriesRepeatedKey(depth: number | false, level: number): boolean`,
    which returns `depth === false || level < depth`. It carries a doc comment
    naming its two readers.
  - `query.ts:4688–4689`: `cutoff = (depth) => !carriesRepeatedKey(shape.recurrence.depth, depth)`.
  - `cache-value-codecs.ts:346`: `continues = carriesRepeatedKey(slot.depth, frame.level)`.
  - The type-only import in `query.ts` becomes a value import of the same
    module. `cache-value-codecs.ts` imports the module directly, not through
    a barrel.
  - `recurrence.ts` imports only `@schema/model` and validation primitives,
    and neither the schema layer nor the validation layer imports the query
    engine (only comments mention it). So the new value imports close no
    cycle, and every run below loads both readers.
- **Behaviour unchanged.**
  - The probe's cutoff table (depth 1, depth 2, `depth: false`) is
    byte-identical before and after.
  - `carrier-boundary` 12/12, `cache-codec` 10/10, `cache-lifecycle` 7/7.
  - `campaign-sqlite` 7/7, with 300 identical verdicts.
- **One-owner witness.** One out-of-tree mutation of the owner (`level <= depth`)
  turns both readers red in the same run (`run-d1…`, project
  `m1-carriesRepeatedKey-off-by-one`):
  - `cache-codec` **6/10 failed**: hit equality, cutoff-key round trip,
    singular null round trip, malformed-value refusal, two-place restore and
    the 1,000-level chain;
  - `carrier-boundary` **2/12 failed**: the root self-loop's cutoff
    occurrence, and the accepted depth-3 junction shape whose `near` node is
    reached at two levels.
- **Deleted.** The two inline spellings of the rule.
- **Second placement.** The cache walker, as described above.

### F8 (minor, RQ-03 and RQ-07 docs) — architecture guides and status lines still described the deleted fit or an unbuilt feature

- **Change.**
  - `src/query-engine/raptor3/AGENTS.md`:
    - The private-fit paragraph (old lines 800–810) is replaced by one
      paragraph on the ordinary recursive projection (new lines 799–814). It
      covers `lowerRecursiveRelationProjection`'s edge-fact CTE in the
      relation column, the `__rq_*` carrier, `completeOrder` as the per-parent
      tie-break, `decodeRecursiveCarrier` and `recursiveRelationCodec`, and
      points to the RQ ledgers.
    - The old range ends mid-sentence: the measurement sentence runs to old
      line 812. That sentence ("Measure statement/bind/provider-row/output
      growth … do not invent an allocation metric API") is kept as the new
      paragraph's last sentence, because §6 still requires it. The stale
      "Keep provider rows flat when useful" is dropped with the fit.
    - Old lines 1164–1168: the census's third bucket (private fits) is now
      stated as empty, and D-54's fit as retired.
    - Line 707: the link is now `recursive-query/rq-cache.md`.
    - Old line 709: the "no fixed codec" sentence is dropped. `shapeCodec`
      has no such refusal; only `leafCodec`'s invariant remains.
  - `scripts/raptor3-refusal-census.mjs:95–102`: the `PRIVATE_FITS` comment
    now says the list is empty and why. This is a comment only, and the census
    still exits 0 with `0 internal`.
  - `features-docs/recursive-query.md:3`: the status line now reads
    "implemented through the ordinary projection; not qualified: native
    PostgreSQL/MySQL lanes owed".
  - `README.md`: the recursive-query entry moves from "Future features" to
    the list of working features (line 595), with the same caveat. The
    "Future features" heading, left empty, is removed.
- **Runs.**
  - `census-after.stdout`: exit 0, `36 unmatched candidate sentences …, 75
    inherited, 0 internal, 23 invariant, 203 sites`.
  - `census-selftest.log`: `scripts/raptor3-refusal-census.test.mjs` **7/7**.

### F9 (minor, RQ-07 map and RQ-01 decoder witnesses) — RQ-3 listed part of the carrier sentences and claimed witnesses it lacked

- **Change.**
  - Refusals-map RQ-3 now lists eleven `TypeError`s:
    - added: `recursive carrier`, `recursive identity`, `recursive edge
      endpoint`;
    - dropped: `recursive node reference`;
    - kept: `Invalid provider recursive depth`, listed separately.
  - Their sites are `shared/query.ts:4545`–`4683` on the repaired tree, and
    the guard column names the two added conditions.
  - The existing malformed-carrier cell of `carrier-boundary.test.ts` ("rejects
    sparse node and edge containers and a cyclic JavaScript carrier") gains
    two assertions:
    - `__rq_row: null` must match `/Invalid provider recursive row/` (lines
      396–406);
    - a carrier without `__rq_edges` must match
      `/Invalid provider recursive carrier/` (lines 408–411).
  - The cell count stays **12**.
- **Every RQ-3 sentence is now pinned by `carrier-boundary.test.ts`:**
  - carrier (new) and identity (`:164`, `:196`);
  - node (`:387`) and duplicate node (`:185`);
  - edge (`:393`) and edge endpoint (`:211`);
  - exhaustive depth (`:281`) and depth (`:262`, `:328`, `:343`);
  - duplicate edge (`:226`) and singular relation (`:460`);
  - unreachable node (`:215`, `:241`) and row (new).
- **Discriminating power.** Two out-of-tree mutants ran in `run-d1…`.
  - With the `recursive row` guard removed, the new assertion is **red**: the
    decoder throws `TypeError: Cannot set properties of null (setting
    'children')`.
  - With the carrier array guard removed, the other new assertion is **red**:
    `TypeError: rawEdges is not iterable`.
  - Each mutant turns only that one cell red (1/12).
- **Green.** `carrier-boundary` **12/12** (`run-d2…`). Biome's
  `useTopLevelRegex` count on this file moves from 18 to 20. The two new
  regexes are inline, like the file's other 18. The file was not Biome-clean
  before this round (24 diagnostics).

### F10 (minor, RQ-07 integrator) — the draft verdict over-stated RQ-01's review and under-stated what is owed

- **Change.** In `rq07-release-verdict.md`:
  - Lines 11–18 now say that every unit except RQ-01 was reviewed as a whole.
    They add that RQ-01's whole-unit independent review is owed until the
    native receipts exist, and that only its decoder repair was reviewed.
  - "Owed" now lists `read-envelope-native` › `g4-native-recursive-read-fit`.
  - It names the only commands that run the native work:
    `node scripts/run-raptor3.mjs g4-read-envelope-pg-contracts` and
    `node scripts/run-raptor3.mjs g4-read-envelope-mysql-contracts`. They
    declare 12 cells per provider: `read-envelope-native` 5,
    `provider-sql-native` 3, `campaign-native` 4.
  - The `@STATUS@`, `@IDENTITY@`, `@COST@` and `@GATE@` placeholders are left
    for the integrator's gate, as the finding describes. They were not asked
    to change.
- **Run.** None, since this is prose.

## Runs, in order

| # | Scope | Result | Wall / peak RSS | Log (`$TMPDIR`) |
| --- | --- | --- | --- | --- |
| 1 | F1 witnesses: 7th cell × pre-guard harness; old/new `graph-oracle.test.ts` × working, pre-CM002 and ring-less corpora (6 projects, `-t "names lowering or decoding\|independent recursive graph oracle"`) | 3 failed (the three expected reds), 43 passed, 6 skipped | 3.31 s / 424.2 MiB | `run-b-finding1-witnesses.log` |
| 2 | Boundary probe, **before** the production edits | 1/1; outcomes recorded | 1.38 s / 315.4 MiB | `probe-before.log` |
| 3 | Refusal census on the repaired tree (read-only) | exit 0; 36 candidate / 75 inherited / 0 internal / 23 invariant sentences; 203 sites | — | `census-after.stdout`, `census-after.md` |
| 4 | Boundary probe **after** the edits, and three falsifications (4 projects) | probe 1/1; `m1` cache-codec 6/10 failed + carrier-boundary 2/12 failed; `m2` 1/12 failed; `m3` 1/12 failed; 10 failed / 37 passed, every red expected | 5.16 s / 491.9 MiB | `run-d1-probe-and-falsifications.log` |
| 5 | Affected cells, registered `raptor3` project, receipt written: carrier-boundary, cache-codec, cache-lifecycle, graph-oracle, campaign-sqlite | **45/45** (12 + 10 + 7 + 9 + 7) | 5.07 s / 657.0 MiB | `run-d2-green-affected.log` |
| 6 | Manifest self-test `scripts/raptor3-campaign-receipts.test.mjs` | **41/41** | 0.61 s / 69.5 MiB | `campaign-receipts-selftest.log` |
| 7 | Census self-test `scripts/raptor3-refusal-census.test.mjs` | **7/7** | 4.54 s / 270.8 MiB | `census-selftest.log` |
| 8 | Biome `check`, read-only, on the seven edited code files, before and after | no new category. `query.ts` 19 → 18 errors; `carrier-boundary.test.ts` 24 → 26 (two inline regexes); the other five unchanged, with `recurrence.ts`, `cache-value-codecs.ts` and the census script clean | — | `biome-before/`, `biome-after/` |
| 9 | `node scripts/run-typecheck.mjs` (native TS7, whole estate incl. `tests/**`), once, after every code edit | **exit 0, 0 diagnostics** | 8.72 s / 5,737.2 MiB (ceiling 8,192) | `typecheck.log` |

The edited files' SHA-256 were the same before and after the typecheck
(`sha-before-typecheck.txt`, `sha-after-typecheck.txt`). After it, only
Markdown ledgers were written: `rq6.md`'s addendum and this note.

**Not re-run, as only the affected cells are:**

- `composition.test.ts`, `provider-sql-sqlite.test.ts`, the PGlite stage, the
  four migrated pins and the admission/introspection suites. F5–F7 change no
  admitted-input behaviour. The real-SQL cutoff placement is pinned by
  `campaign-sqlite`'s 300 cases, which ran green with identical verdicts.
- The fixed stage, the frozen gate's inventory and every native lane.

## Registrations

No new test file and no cell-count change beyond the two corrected in the
manifest (`cache-codec` 10, `cache-lifecycle` 7). `carrier-boundary.test.ts`
stays at 12 cells. `RAPTOR3_FIXED_LOCAL_TESTS` gains the seven
recursive-query files listed under F2.

## Measured / not measured

- **Measured.**
  - Every run above, with its wall time and peak RSS.
  - The receipt's field-by-field identity with the receipt it replaces.
  - The census counts on the repaired tree.
- **Not measured.**
  - The fixed stage's wall time and peak with its seven new files. Its last
    recorded run was 89 files in 13.95 s at 852.7 MiB
    (`compact-found-consumption/checks/fixed.log`), under a 120 s wall and a
    1,536 MiB ceiling in one fork.
  - Five of the seven added files ran together here at 657.0 MiB and 5.07 s.
    `composition` and `provider-sql-sqlite` were not in that run. For
    reference, `provider-sql-sqlite` alone peaked at 496.3 MiB in rq34, and
    `composition` with `campaign-sqlite` at 602.7 MiB in rq6.
  - Whether the combined stage stays inside its ceiling is the frozen gate's
    `fixed` stage to establish.

## Unverified, and observations for the integrator (no action taken)

1. **Refusals-map census figures predate this round.** The addendum's
   measured sentence ("the candidate count moves from 23 to 38 distinct
   sentences") and the RQ-1, RQ-4 and RQ-5 line numbers are those of the
   earlier census run, and they were not asked to change. Against that run's
   report (`/tmp/rq-census-after.md`, 01:36), this round's census differs in
   exactly three sentences: the two candidates removed
   (`…recursive node reference` and `Required relation '…' returned no
   record.`) and the one invariant added. Candidates go from 38 to **36**
   distinct (48 → 46 sites), invariants from 22 to 23 distinct (23 → 24
   sites), and total sites from 204 to 203. On the repaired tree RQ-1 sits at
   `:4731`, RQ-4 at `:5203` and RQ-5 at `:4139` (`census-after.md`). The
   rewritten RQ-2 and RQ-3 rows cite repaired-tree lines and say so.
2. **`selecting.mdx:179–182` states an unobserved behaviour as fact.** It
   still says a provider cap failure "is reported as the provider's error,
   never as a truncated result" (MySQL's `cte_max_recursion_depth`). This is
   the same unobserved claim F3 corrected in the CHANGELOG. The finding asked
   for no change to the page, so none was made.
3. **The F1 before-bytes are reconstructions, not preserved copies.** Two of
   them were rebuilt in this round by removing the edit from the working
   file: the harness and `campaign-sqlite.test.ts`. Each hash matches the
   abbreviation the RQ-06 ledger recorded (8 hex digits of prefix and 4 of
   suffix). The old `graph-oracle.test.ts` is a preserved copy, and it
   matches `rq01-sql-placement.md`'s 16-hex prefix. The intermediate
   `a777834a…` bytes of `campaign-sqlite.test.ts` were not recovered, and no
   claim rests on them.
4. The native PostgreSQL and MySQL lanes are unchanged and still owed; see
   the verdict draft's "Owed".

## Blockers

None for this round. No repair failed, and no representation attempt was
spent. The feature's qualification stays incomplete under §7 until the
native lanes run.

## Cost

- **Production:**
  - `query.ts` +9 / −8 physical lines: +3 for the multi-line import, −2 for
    the guard, the invariant and the cutoff line for line;
  - `recurrence.ts` +13, the owner function and its doc comment;
  - `cache-value-codecs.ts` +2 / −1.
- **Deletions:** one guard (F5), one unreachable refusal (F6) and one duplicate
  spelling of the repeated-key rule (F7).
- **Tests:** `carrier-boundary.test.ts` +17 (two assertions).
- **Manifests:** +7 / −2.
- **The rest is ledgers and docs.**
