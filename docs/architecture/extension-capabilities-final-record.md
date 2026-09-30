# Extension capabilities v3.1 and `viborm/soft-delete`: final qualification record (U7, amended by the U7 repair, the compression pass and the trusted-definitions decision)

**Section 000 (trusted definitions, owner decision of 2026-09-30, qualified on 45ba55973) supersedes section 00 wherever they differ.**

**Section 00 (the compression pass, qualified on a26cbc8a3) supersedes section 0 and sections 1-12 wherever they differ.**

The qualifier ran on frozen source 572de61f7. Its review found two blockers, two majors and four minors; the U7 repair (commit **654b3df93**, tree e32c2c55a) repaired or re-measured each. **Section 0 below supersedes sections 1-12 wherever they differ**; those sections are kept as the qualification of 572de61f7.

One thing still blocks a clean exit and needs the owner:
1. **The §5.2 bundle budget is breached** (STOP U3R-1, open): base entry +6,343 B gzip over main against +5 KB. Measured in the repair: trimming cannot close it (§0.5).

And one qualification gap remains: **MySQL has never executed a witness** (no server; Docker down). PostgreSQL now has: the repair ran the pg-driver lane on a scratch PostgreSQL 18.3 server (§0.2).

Labels: **MEASURED** means run in the qualification or the repair unless another unit is named. **JUDGEMENT** means reasoning, not measurement.

## 000. Trusted definitions (2026-09-30, owner decision)

The owner decided on 2026-09-30 that an extension definition is trusted. VibORM no longer checks `controls`, `rows` or `deletion` at runtime and has no hostile-input boundary for them. They are bound exactly as the definition writes them, and TypeScript is their only check. In the owner's words, deleting this is fine "as long as we can write powerful extensions". It is not a capability change: an extension can do everything it could before, and only what happens when a definition is wrong has changed. **This section supersedes §00 (and, through it, §0 and §1–12) wherever they differ.** Labels are as above: **MEASURED** means run by this qualification on 45ba55973 unless another revision is named; **JUDGEMENT** means reasoning.

Two results change the open items. First, **the §5.2 bundle budget is now met**: +4,267 B gzip over main in one build and +4,184 B in the other, against +5 KB (§000.4). STOP U3R-1 was opened by the owner, so closing it is the owner's call. Second, **MySQL still has never run a witness** (§000.7).

### 000.1 Identity

| Item | Value |
| --- | --- |
| Qualified source (HEAD before this docs commit) | **45ba55973ebed819df1f6d0e1c57c107724618d3**, tree 653a0385c93840dcbe5ccf47234c6985d1b5c6f8 |
| Base | origin/main = merge-base = 30ff17e69 |
| Compressed tree | b63805451 (the compression repair; same tree 0d06fec24 as §00's a26cbc8a3), then its docs commit e0f36f7f6 |
| Pre-pass tree | 2c1e896bb (§00.1) |
| Commits of this decision | **3c93171d6** refactor(extensions): a declaration is trusted; the hostile boundary and the declaration checks are deleted (owner decision). **00509c9d0** (fold repair): `rows` predicates are bound as written, and the `where` admission is deleted too. **45ba55973** (fold repair, qualify): the raptor3 row-domain memo witness names the predicate as written. |
| Commits over 30ff17e69 | 25 (22 before this decision, 3 for it) |
| Working tree before this commit | Clean. Nothing pushed, nothing amended, no history rewritten. |
| Trailers over main | 22 `Claude Fable 5.1` and 3 `Claude Opus 5.5` (the three commits above), MEASURED with `git log --format=%(trailers)`. Normalising them needs a reword at PR time (owner). |

What the decision deleted, and what it kept:

- **Deleted** in `src/extensions/definition.ts`: `refuse`, `readGuarded`, `emptyCopyOf`, `ControlValidator`, `readValidator`, `copyData`, `record`, `requireName`, `readSchemaModel`, `requireScalarField`, `isControlLiteral`, `assertControl`, `snapshotControls`, `sameNames`, `snapshotRows`, `requireTimestampField`, `assertRemoveWhen`, `assertDeletionEntry`, `snapshotDeletion`, `refuseCoreArgumentNames`, the `Shape` tables (CONTROLS, ROWS, DELETION), `NO_CONTROLS` and `ConstantFields`. The fold repair also deleted `admitWhere`, `admitRows` and `ExtensionSchemaRegistry`, the registry parameter of `normalizeExtensionDefinition` and `appendResolvedExtension`, and the client's `schemaRegistry` field. In `chain.ts`: the refusals "control already declared on this client" and "deletion model already managed". In validation: `SchemaRegistry.argumentNames` (`builder.ts` and `types.ts` are back to main).
- **Kept**: the call-time admission of every control value (oneOf and Standard Schema, including their throw, async, malformed and unreadable paths), placement per (model, operation), `rows` binding, `deletion` binding, rows as the cache key, the official-extension admission, the duplicate-extension-name check, the "rows cannot follow a result consumer" order guard, and the TypeScript types. The six older members (request, query, statement, observe, client, model) keep main's handling byte for byte. `extensions-foundation.core.test.ts` was not touched.
- **Why the `rows` admission went too** (review of 3c93171d6): Raptor 3's `prepareOperations` reads `where` shorthand itself (`null`, a non-object value or an operator-free record means `equals`). Prepared meaning holds no adapter, so no dialect is affected. The review ran 13 predicate shapes end to end on SQLite, with and without the admission, and got identical rows. The only thing the admission did was rewrite the null shorthand.

### 000.2 Lines, MEASURED

Scanner: `elegance/synthesis/loc.mjs` (a line counts only if it holds code outside comments), as in §00.2, run on `git show <rev>:<file>`. Each cell is **TS code lines / runtime lines**. Runtime lines are what remains after `esbuild 0.25.4 --loader=ts --format=esm` strips the types, counted with the same scanner. The perimeters are §00.2's.

| Perimeter | main 30ff17e69 | pre-pass 2c1e896bb | compressed b63805451 | trusted 45ba55973 |
| --- | --- | --- | --- | --- |
| Four extension files (chain, controls, definition, rows) | 770 / 440 | 2,212 / 1,345 | 2,042 / 1,258 | **1,553 / 857** |
| Eight files (the four + validation builder.ts and types.ts, client/client.ts, raptor3 row-scope.ts) | 2,111 / 1,231 | 3,641 / 2,162 | 3,470 / 2,075 | **2,963 / 1,658** |
| Production perimeter (34 files) | 21,528 / 14,379 | 23,882 / 15,847 | 23,649 / 15,706 | **23,142 / 15,289** |
| Test perimeter (34 files), TS lines | 2,698 | 8,215 | 8,222 | **7,745** |

- **Per file, compressed → trusted:** definition.ts 940/590 → 467/203; chain.ts 536/346 → 520/332; controls.ts 445/244 (unchanged); rows.ts 121/78 (unchanged); client.ts 1,076/664 → 1,072/661; validation/builder.ts 183/153 → 170/140 (main's); validation/types.ts 146 → 145 (main's).
- **By commit (four files):** 3c93171d6 took them to 1,600 / 880, and the fold repair to 1,553 / 857.
- **Branch growth in production over main:** +2,354 (pre-pass), then +2,121 (compressed), now **+1,614** TS lines. Runtime lines grew +1,468, then +1,327, now **+910**.
- **The probe's 707 runtime lines:** the probe's "Option T" reached 707 in the four files only because it also deleted main's handling of the six older members. That handling stays here.

### 000.3 Tests deleted, by class

| Class | Count | Where |
| --- | --- | --- |
| Pins of deleted declaration refusals: shape, oneOf, placement, core-argument names, rows modes/default/model/field/purpose, removeWhen, deletion model/`at`/`assign` | About 40 of the 47 cases in the "controls: definitions refused when applied" table | extension-controls.core.test.ts |
| Hostile-definition cases for the three members: revoked proxies (3), throwing getters (2), a cycle, a symbol key, function or instance where plain data stands | The remaining cases of that table | extension-controls.core.test.ts |
| The two deleted chain refusals | 1 test ("names are one space per chain, and one deletion entry per model") | extension-controls.core.test.ts |
| Snapshot and hostile semantics (getters read once, post-binding mutation, Date/Uint8Array copies, a trapped proxy) | 1 test ("a definition is read once …") | extension-controls.core.test.ts |
| **Total deleted** | **49** (extension-controls 71 → 22) | |
| Rewritten, not deleted | extension-deletion's invalid-predicate refusal became an end-to-end witness: raw `{ archivedAt: null, hidden: false }` and `{ NOT: { archivedAt: null } }` filter rows, and a model the schema lacks is ignored (6 → 6). The raptor3 row-domain memo witness now expects the predicate as written, `{ deletedAt: null }` (row-scopes 80 → 80). The numeric oneOf admission joined the existing oneOf test (`level: 2` admitted, `"2"` a ValidationError). | |
| Behavioural witnesses of valid definitions deleted | **0** (the review checked each deleted case) | |

Counts: coverage-extensions 443 → **394**; layer-client 704 → **655**; `test:core` 9,413 → **9,364**. Guard ledger: 7 rows are replaced by "Deleted 2026-09-30, owner decision: the definition is trusted" notes. No manifest counts a changed test file.

### 000.4 Bundle and types, MEASURED

**Bundle.** tsdown + `scripts/measure-bundle.mjs` on path-limited archives (src scripts package.json tsconfig.json tsdown.config.ts benchmarks/internal), built one after another in this session. Cells are raw / gzip / brotli bytes. The trusted tree and the compressed tree were each built twice. Raw bytes are identical between the two builds of each tree. The compressed tree's gzip is also identical between its builds, and matches §00.6 exactly. The trusted tree's gzip moves by 83 B between its builds, so both builds are shown.

| Fixture | main 30ff17e69 | compressed e0f36f7f6 | 3c93171d6 | **trusted 45ba55973** (build 1; build 2) | trusted − compressed | trusted − main |
| --- | --- | --- | --- | --- | --- | --- |
| **pg-representative** | 543,896 / 160,066 / 135,512 | 564,035 / 166,199 / 141,007 | 558,041 / 164,462 / 139,491 | **557,602 / 164,333 / 139,493**; 557,602 / 164,250 / 139,389 | −6,433 raw / **−1,866 gzip** | +13,706 raw / **+4,267 gzip** (+4,184) |
| pg-soft-delete | n/a | 564,931 / 166,528 / 141,149 | 558,937 / 164,804 / 139,784 | 558,498 / 164,660 / 139,581; 558,498 / 164,586 / 139,667 | −6,433 / −1,868 | +4,594 gzip over main's pg-representative |
| full | 917,160 / 267,890 / 221,230 | 937,961 / 274,283 / 226,983 | 931,962 / 272,430 / 225,309 | 931,523 / 272,298 / 225,238 (both builds) | −6,438 / −1,985 | +4,408 gzip |
| soft-delete entry | n/a | 759 / 395 / 349 | 759 / 395 / 349 | 759 / 395 / 349 | 0 | n/a |
| ids-only, decimal-only | 93,221 / 27,891; 93,072 / 27,867 | +1 gzip each | same | same as compressed | 0 | +1 |

**§5.2 base entry ≤ +5 KB gzip: MET.** The two builds measure +4,267 and +4,184 B, 733 and 816 B under 5,000. The pre-pass was 6,374 B over main and the compressed tree 6,133 B. JUDGEMENT: the deleted boundary was the largest single remaining cost. Closing STOP U3R-1 is left to the owner.

**Types.** tsc 5.9.3 `--extendedDiagnostics` under `node --max-old-space-size=1280`, on path-limited archives (src tests tsconfig.json package.json). §00.5's harness was used: `client-2` in main's chunking, and the schema-only `floor.ts`. One round each, compressed e0f36f7f6 then trusted. Every run exited 0 with 0 errors.

| Program | Types compressed → trusted | Instantiations compressed → trusted | RSS MiB |
| --- | --- | --- | --- |
| client-2 | 857,083 → **856,225** (−858) | 3,664,996 → **3,662,216** (−2,780) | 1,422.9 → 1,439.0 |
| schema-only floor | 747,674 → **746,821** (−853) | 2,908,218 → **2,905,463** (−2,755) | 1,443.9 → 1,392.5 |

Both programs are **≤ the compressed tree** (the bar). The compressed column reproduces §00.5's post-pass values exactly.

### 000.5 Gates run, one at a time, MEASURED on 45ba55973

- **Static checks:**
  - Biome on the 12 code files changed since e0f36f7f6: 0 diagnostics.
  - `tsc` (typescript-native, whole tsconfig): exit 0 in 7.8 s.
  - Refusal census, `node scripts/raptor3-refusal-census.mjs --at e0f36f7f6` against the tree: both 240 lines and 203 sites (invariant 25 sites / 24 sentences; inherited 76 / 76; candidate 44 / 35). **Delta 0.** The only differing line is the revision line; the one raptor3 source change is a comment.
- **Direct vitest per layer project:** validation 998, scalars 1,159, operation-schemas 1,364, relations 119, schema-validation 470, schema-json 431, query-engine 739, write-engine 82, adapters 190, drivers 988, client **655**, cache 85, instrumentation 185, migrations 1,899. In total **446 files, 9,364 passed, 0 failed.**
- **raptor3:**
  - Before 45ba55973 the first run had 8 failures. One was new: row-scopes "prepares each row domain a call selects once …" pinned the admitted form `{ deletedAt: { equals: null } }`. It was repaired in 45ba55973.
  - The rerun on the qualified source: 207 files (200 passed, 7 failed), 2,129 tests passed and 7 failed. The 7 are **exactly the known reds**: cs02-structure-measure; g3 sqlite-campaign and transport-campaign; g4 sqlite-campaign, transport-campaign, write-campaign and write-transport-campaign.
  - `run-raptor3.mjs post-g3-row-scopes` 80/80 and `post-g3-deletion-sites` 45/45, both reporting "contract gate verified". raptor3-provider: 9 files, 32/32.
- **Providers and extended-local:** provider-sqlite3, 16 files, 881 passed and 1 skipped. extended-local, 171 files passed and 22 skipped; 2,348 tests passed and 393 skipped.
- **Coverage for extensions:** coverage-extensions, 20 files, 394/394, at 100 / 100 / 100 / 100 with the floors met.
- **Live PGlite** via `node scripts/run-credential-free-tests.mjs --only …`, each run alone with teardown verified (peak RSS in MiB, ceiling 2,560):

| Lane | Passed | Peak RSS (MiB) |
| --- | --- | --- |
| pglite-deletion-capability | 15/15 | 1,753.3 |
| pglite-row-scopes | 24/24 | 1,590.1 |
| pglite-soft-delete | 12/12 | 1,843.5 |
| imported-pglite shard 2/2 (official-cache-extension, a touched file) | 163, 14 skipped | 1,993.1 |
| shared-family shard 5/8 (official-cache-reads; the rows cache identity now holds predicates as written) | 239/239 | 2,259.1 |

- **Lock scripts**, one at a time, each passing on its first run with no reruns (load average about 10):

| Script | Result | Time | Details |
| --- | --- | --- | --- |
| `pnpm test:types` | exit 0 | 10 s | 7,553.7 MiB (ceiling 8,192) |
| `pnpm test:core` | exit 0 | 79 s | 446 files, 9,364/9,364, 1,285.0 MiB (ceiling 1,536) |
| `pnpm test:package` | exit 0 | 29 s | 13/13, including the packed public-surface golden |
| `pnpm test:coverage` | exit 0 | 429 s | every threshold held, see below |
| `pnpm test:layer:client` | exit 0 | 37 s | 655/655; type chunks 1,409.0 / 1,413.7 / 1,391.8 / 1,468.5 MiB |
| `pnpm test:layer:query-engine` | exit 0 | 14 s | 739/739 |
| `pnpm test:layer:instrumentation` | exit 0 | 11 s | 185/185 |

- **Coverage** from `pnpm test:coverage` (statements / branches / functions / lines, floor in parentheses):
  - Public, schema, validation, sql, instrumentation, extensions (394 tests), errors, adapters and CLI: 100 / 100 / 100 / 100 (100).
  - query-engine core: 93.79 / 94.24 / 94.43 / 93.79 (87 / 91 / 90 / 87).
  - drivers: 96.04 / 92.69 / 96.06 / 96.04 (96 / 92.5 / 96 / 96).
  - client: 96.33 / 94.36 / 96.5 / 96.33 (96 / 94 / 96 / 96).
  - cache: 100 (98).
  - migrations: 98.68 / 97.3 / 99.89 / 98.68 (98 / 97.3 / 98 / 98).
  - These are all identical to §00.4 apart from the extensions test count.

### 000.6 What a wrong definition does now, MEASURED

The fold's probe was rerun against a tsdown build of 45ba55973, on in-memory SQLite. Its log is byte-identical to the log from 3c93171d6 except for one timestamp. Every wrong definition below is **applied** without error; what differs is the first call.

| Wrong definition | At the first call |
| --- | --- |
| `rows` names an unknown model (`posts` for `post`) | Ignored: reads are unfiltered. |
| `deletion.at` names a String field | The delete fails with a `ValidationError` from the tombstone's `updateMany`, and no row changes. |
| `removeWhen` names no declared control | Soft deletes still happen. Passing that control is "Unknown key". |
| Two extensions declare the same control name | Both handlers receive the value. Each extension's `oneOf` admits only its own values, so a value one of them lacks is refused. |
| A `rows` entry lacks its default mode (W5a, W5c) | Some reads throw a raw `TypeError: Invalid value used as weak map key`. This is the harshest of the unchecked behaviours. |
| A row predicate names an unknown field | The engine refuses with "'gone' is neither a declared scalar of 'post' …". |
| A control named like a core argument (`where`) | The control takes the argument: `where` is validated as the control. create.mdx says not to take such names. |
| A control member typo (`onn`) | Not flagged by the types. It is applied and ignored. |
| A later `deletion` entry for a model already managed | It replaces the earlier entry. |
| In `softDelete`, a wrong field | Applied silently. |
| In `softDelete`, an unknown model | **Still refused when applied**, through its `restore` methods (a `model` member, main's check). soft-delete.mdx says so after the owner's paragraph. |

The docs carry the owner's paragraph verbatim: "A definition is not checked at runtime. TypeScript flags a misspelt member in your editor; an unknown model name, a field of the wrong type or a `removeWhen` that names no control is not caught and misbehaves at the first call." It appears in create.mdx and soft-delete.mdx. Other records of the decision:
- The v3 plan §2.1 has a dated amendment, and the decisions file has TR-1..TR-9.
- The CHANGELOG has the line "Definitions are trusted: VibORM does not check a declaration at runtime."
- src/client/AGENTS.md has the owner paragraph and table row. `src/extensions/AGENTS.md` does not exist.

### 000.7 Gaps

1. **MySQL** has still never run a witness: there is no Docker and no local `mysqld`. The rerun command is in §00.9.
2. **PostgreSQL** (the scratch-server lane of §00.4) was not rerun for this decision. JUDGEMENT: the change binds `rows` predicates as written. Prepared meaning is adapter-free, and PGlite ran every rows, deletion and soft-delete lane green.
3. **Bundle** STOP U3R-1: now met by measurement (§000.4). Closing it is the owner's call.
4. **The wrong-definition behaviours in §000.6** are accepted by the owner's decision. The raw `TypeError` for a `rows` entry that lacks its default mode, and a control named like a core argument, are the two a reader would notice first.
5. **§00.8 D7 is still open**, and the trailer normalisation is still owed (§000.1). Owner questions §00.9.4–5 about hostile records are moot for the three members, since they are no longer read defensively.
6. **The PR description is not updated.** Nothing was pushed; publishing is the owner's.

## 00. Compression pass (2026-09-30)

The branch was compressed under ELEGANCE.md after the elegance review of 2c1e896bb (scratchpad `softdelete/elegance/report.md`: verdict, 14 ranked proposals, irreducible list, defects D1–D7), reviewed, repaired, then qualified on frozen source. **This section supersedes §0 and §1–12 wherever they differ.** Those sections stay as the qualification of the pre-pass tree. Labels are as above: **MEASURED** was run by the qualifier on a26cbc8a3 unless a unit is named; **JUDGEMENT** is reasoning.

Still open, as before the pass: **the §5.2 bundle budget is breached** (STOP U3R-1, owner): +6,133 B gzip over main against +5 KB (§00.6). **MySQL has never run a witness** (§00.9).

### 00.1 Identity

| Item | Value |
| --- | --- |
| Qualified source (HEAD before this docs commit) | **a26cbc8a3c64d3fcc9abc8dba02a1c71d5f9e3c1**, tree 0d06fec2439f30a8dda4e11bc4f90b1782b92fdf |
| Base | origin/main = merge-base = 30ff17e69 |
| Pre-pass tree | 2c1e896bb (the docs commit on top of the U7 repair ec3f4b6ef). The branch was re-committed after §0/§1 were written: §1's hashes (e151a686f … 572de61f7, 654b3df93) name the same units but are not ancestors of HEAD; the pre-pass commits are e151a686f, 2ac4eae84, 51a259d44, d20451b5a, 0167dda59, 6464b1f69, e7d6cf383, 8fe8c4a56, c8204bcb5, 4d3b40f8e, 2f0b76b98, fac2133aa, ec3f4b6ef, 2c1e896bb. |
| Commits over 30ff17e69 | 21 = 14 pre-pass + 7 of the pass |
| Diff vs main (commit to commit) | 102 files, +13,195 / −1,073 physical lines; vs 2c1e896bb: 29 files, +721 / −902 |
| Working tree before this commit | clean; nothing pushed; nothing amended; no history rewritten |
| Trailers over main | 16 `Claude Fable 5.1`, 5 `Claude Opus 5.5` (MEASURED with `git log --format=%(trailers)`; §0.1's "10 / 3" no longer describes the re-committed branch). In the pass: C1, C2, C5, C6 and the repair carry Opus 5.5 (the harness attribution), C3 and C4 carry Fable 5.1. Normalising needs a squash or reword at PR time (owner). |

The pass's commits:

| Unit | Commit | Review rows | What it is |
| --- | --- | --- | --- |
| C1 | 622ffd740 | D1, D3, D4, D5 | witnesses adopted before compressing (tests only) |
| C2 | 8364330f2 | 1, 10, 11; D1, D2 | each capability declaration read once, checks run on the frozen copy |
| C3 | a18eaeceb | 3, 4 | one control type carries its placement; the chain's rows declarations are the cache key's row identity |
| C4 | cb65aa8dc | 5 | the official cache's control goes through the chain's controls slot; `Client` drops its cache-bit parameter |
| C5 | 12182bd5f | 2, 6, 12 | root delete and deleteMany are one plan; the prepared domain owns its read view |
| C6 | b60daadfe | 7, 8, 9, 13; D6 | tests keep what each owner decides; one `failure()`; the statement-count pin goes to its race twin |
| repair | a26cbc8a3 | review of C1–C6 | C2's unnamed message and admission changes restored; the restrict refusal pins every relation it names |

### 00.2 Lines, MEASURED

Scanner: the review's `elegance/synthesis/loc.mjs`, which counts a line only if it holds code outside comments (.ts only), run with `git show <rev>:<file>` at each revision. Production perimeter = the review's `src-perimeter.txt` (34 .ts files: every production file the branch touches). Test perimeter = the review's `test-ts.txt` (32 files) plus the two files the pass touched that it did not list (`tests/fixtures/failure.ts`, new; `tests/providers/local/sqlite3-fixtures.ts`).

| Perimeter | main 30ff17e69 | pre-pass 2c1e896bb | post-pass a26cbc8a3 | Branch growth pre → post |
| --- | --- | --- | --- | --- |
| Production (34 files) | 21,528 | 23,882 | **23,649** | +2,354 → **+2,121** (−233, 9.9% of the growth) |
| of which the 11 src files the pass touched | 11,976 | 13,882 | 13,649 | +1,906 → +1,673 |
| Tests (34 files) | 2,698 | 8,215 | **8,222** | +5,517 → +5,524 (+7) |

Per unit (production / tests): C1 0 / +143; C2 −147 / 0; C3 −47 / 0; C4 −17 / 0; C5 −45 / 0; C6 0 / −166; repair +23 / +30. Per file (main → pre → post): definition.ts 414 → 1,063 → 940; chain.ts 356 → 575 → 536; controls.ts 0 → 446 → 445; rows.ts 0 → 128 → 121; methods.ts 423 → 422 → 419; client/types.ts 819 → 838 → 824; client/client.ts 1,026 → 1,077 → 1,076; commands.ts 1,649 → 1,813 → 1,770; commands/index.ts 244 → 287 → 272; operation-context.ts 2,426 → 2,453 → 2,459; query.ts 4,619 → 4,780 → 4,787.

Against the review's forecast (−236 production measured on a stacked prototype, −151 tests offset by about +60 witnesses): production lands at −233; the witnesses cost +143, not +60; the repair spent +23 production and +30 test lines to keep refusal bytes identical (§00.3, repair). The C6 commit body's per-row split is wrong; the right split of its −166 is row 7 −128, row 8 −27, row 9 −8, row 13 −3, D6 0 (decision C6-11).

### 00.3 What disappeared, per unit

- **C1** (tests only). Added: two per-model placement tests (D3, extension-controls.core.test.ts, one per application order); two root soft deletes whose projection reads relations (D4, deletion-capability-behavior.ts: to-many include, and a restricted candidate with a projection); `createNonReturningSQLite3Driver` in sqlite3-fixtures.ts and a third consumer call in deletion-sites, row-scopes and soft-delete.core (D5, 56 cells); a callable Standard Schema admitted and run (D1, red until C2). Manifests: deletion-sites 26 → 45, row-scopes 57 → 81.
- **C2**. Gone: `isGuardedRecord`, `requireRecord`, `copyRecord`, `readStringKeys`, `readMemberKeys`, the seven `Runtime*` declaration types, and the rebuild of each control, removeWhen and deletion entry in `snapshotControl`/`snapshotRemoveWhen`/`snapshotDeletionEntry`. Now: `copyData` copies controls, rows and deletion once, whole; `record` is the one shape check; `readGuarded` the one guarded reader (`readOwn` is its one-line delegate); `assertControl`, `assertRemoveWhen`, `assertDeletionEntry` narrow the copy in place (`asserts value is X`, ELEGANCE §5, each right after the `copyData` that established it); the public `ControlDeclaration` and `*Contribution` types are the runtime types. Row 10 folded (the removeWhen oneOf requirement is the value check; one pin moved). Row 11: `rowsModes` is the one derivation of the rows mode list. Fixed D1 and D2.
- **C3**. Gone: `PlacedControlDeclaration`, the copy-then-freeze index protocol (`MutableControlLists`, `copyControlLists`, `freezeControlLists`), `RowsBinding.identity` and `ResolvedRows` (with its unread `extension`). Now: `ResolvedControl` (controls.ts) carries its placement; `ResolvedControls.all` is the flat list the per-(model, operation) index is rebuilt from; `cacheKeyOf` reads `engine.extensionChain.rows`. Rows cache key bytes changed (never shipped).
- **C4**. Gone: `Client`'s `ExtensionCache extends boolean` parameter, `ClientControls`, `OfficialCacheControlState`. Now: `EnableExtensionCache` adds the cache's declaration to `X["controls"]`, the slot every other extension uses. Public type change: `Client`'s third parameter is the controls; `Client<C, D, true>` no longer compiles (CHANGELOG, named by the review, row 5).
- **C5**. Gone: the second root-delete route (`rootUpdate`'s optional selector, the record route and the `root.operation` override) and the second WeakMap memo (`scopedReads`/`readsOf`). Now: root `delete`/`deleteMany` is the hard delete's plan and a soft delete swaps only the effect (`ctx.updateMany` for `ctx.deleteMany`); `OperationContext.updateMany` re-reads a relation projection by identity, the rule `deleteMany` already had; `PreparedDomain.reads` is the one read view; the interactive requirement builds its error with `restrictFailure(model)()`. Statement order changed on the projected soft delete only (C5-2: 45-cell probe, identical results, errors and row states; packaging, ELEGANCE §7).
- **C6** (tests only). Gone: five soft-delete-behavior tests owned by row-scope-behavior and deletion-capability-behavior (and the fixture only they used), five branch copies of `failure()` (tests/fixtures/failure.ts owns it), the RETURNING statement-count pin (its DC10 race twin dies under the same mutation; row-scopes 81 → 80), two redundant type directives. D6: the ForeignKeyError text and the nullability pin re-derived from the plan; the admission ledger count 3 re-derived and kept (not a defect).
- **Repair**. C2 had changed seven refusal messages and refused a Map where 2c1e896bb admitted one, none named by the review. `copyData` now reads positions from one `Shape` table per member (definition.ts:267-277), a misfit is copied as `null` so each position refuses in its own words, and the unknown-member refusal moved into the copy (dropping `record`'s five member lists). Probe of 41 definitions, 2c1e896bb vs repair: 35 byte-identical, the 6 that differ are exactly the review's named changes (D1, three D2 cases, first-fault order, row 10). Four pins added. The restrict refusal now pins the set of relations it names ({comments, notes, tags}, order-free).

### 00.4 Commands, one at a time, MEASURED on a26cbc8a3

- `pnpm exec biome check --max-diagnostics=500` on the 24 code files changed since 2c1e896bb: 0 diagnostics.
- `node node_modules/typescript-native/bin/tsc --project tsconfig.json --noEmit`: exit 0, 0 errors, 8.1 s.
- `node scripts/raptor3-refusal-census.mjs --at 30ff17e69`, `--at 2c1e896bb`, `--at HEAD`, and on the working tree: 240 lines each; 203 sites (invariant 25 / 24 sentences; inherited 76 / 76; candidate 44 / 35; rethrow 58); identical to both earlier revisions modulo line numbers, per-file site counts equal. **Delta 0.** 106 lines differ against 2c1e896bb, all line shifts (query.ts 99, operation-context.ts 16, commands.ts 4, commands/index.ts 1, the revision line).
- Dead-symbol gate (`pnpm exec vitest run --workspace vitest.workspace.ts tests/contracts/engine/write/dead-symbol-gate.core.test.ts`): 3 files, 225/225.
- Manifests: `node scripts/run-raptor3.mjs post-g3-row-scopes` 80/80 and `post-g3-deletion-sites` 45/45, both "contract gate verified"; `node scripts/run-node-safe.mjs 512 300000 scripts/<t>.test.mjs`: coverage-policy 11/11, credential-free-ci 4/4, raptor3-campaign-receipts 41/41, raptor3-refusal-census 8/8, bounded-process 16/16, test-run-lock 6/6; raptor3-cli 10/10 (900 s wall, 224.6 s).
- Direct vitest, one layer project at a time: validation 998, scalars 1,159, operation-schemas 1,364, relations 119, schema-validation 470, schema-json 431, query-engine 739, write-engine 82, adapters 190, drivers 988, client **704** (690 pre-pass: C1 +20, C6 −10, repair +4), cache 85, instrumentation 185, migrations 1,899. **446 files, 9,413 passed, 0 failed.**
- raptor3: 200 files passed, 7 failed; 2,129 passed, 7 failed. The 7 are **exactly the known reds** (cs02-structure-measure; g3 sqlite-campaign, transport-campaign; g4 sqlite-campaign, transport-campaign, write-campaign, write-transport-campaign). raptor3-provider 9 files, 32/32. provider-sqlite3 16 files, 881 passed, 1 skipped. extended-local 171 files passed, 22 skipped; 2,348 passed, 393 skipped.
- Live PGlite via `node scripts/run-credential-free-tests.mjs --only …`, each alone, teardown verified: pglite-deletion-capability 15/15 (1,798.9 MiB), pglite-row-scopes 24/24 (1,552.1), pglite-soft-delete 12/12 (1,931.1), pglite-captured-bulk 8/8 (1,705.3) and pglite-bulk-writes 148/148 (1,756.3) (both because `updateMany` changed in C5), shared-family shard 4/8 (official-cache-invalidation) 205/205 (1,926.1), shared-family shard 5/8 (official-cache-reads, because the cache key changed in C3) 239/239 (2,095.1), imported-pglite shard 2/2 (official-cache-extension) 163 + 14 skipped (1,724.2). Ceiling 2,560 MiB.
- PostgreSQL: `docker info` fails, so the pg lane ran on a **scratch Homebrew PostgreSQL 18.3** (initdb with LC_ALL=C and scram password in the qualifier's scratch, 127.0.0.1:55434, no unix socket, database `viborm`, no PostGIS), `PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:55434/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg tests/providers/docker/pg-<f>.test.ts`, one file at a time: deletion-races 5, deletion-capability 15, row-scopes 24, soft-delete 12, captured-set-concurrency 28, nested-write-races 95, batch-reference-reuse 6, junction-side-actions 9: **194/194**. Server stopped and data dir deleted. **MySQL not run**: no Docker and no local `mysqld`.
- Lock scripts, one at a time, each first run, none rerun (load average 8-11): `pnpm test:types` exit 0, 12 s, 6,141.7 MiB (ceiling 8,192); `pnpm test:core` exit 0, 46 s, 446 files, 9,413/9,413, 1,259.0 MiB (ceiling 1,536); `pnpm test:package` exit 0, 24 s, 13/13 including the packed public-surface golden, "lets a third party build soft delete from public exports alone" and the TS 5.8 consumer floor; `pnpm test:coverage` exit 0, 455 s, every threshold held (below); `pnpm test:layer:client` exit 0, 39 s, 704/704, type chunks 1,452.3 / 1,432.5 / 1,414.8 / 1,400.5 MiB; `pnpm test:layer:query-engine` exit 0, 16 s, 739/739, types 1,374.7 MiB; `pnpm test:layer:instrumentation` exit 0, 12 s, 185/185, types 1,462.7 MiB.

Coverage from `pnpm test:coverage` (statements / branches / functions / lines, floor): public, schema, validation, sql, instrumentation, **extensions (20 files, 443 tests)**, errors, adapters, CLI 100 / 100 / 100 / 100 (100); query-engine core 93.79 / 94.24 / 94.43 / 93.79 (87 / 91 / 90 / 87); drivers 96.04 / 92.69 / 96.06 / 96.04 (96 / 92.5 / 96 / 96); client 96.33 / 94.36 / 96.5 / 96.33 (96 / 94 / 96 / 96); cache 100 (98); migrations 98.68 / 97.3 / 99.89 / 98.68 (98 / 97.3 / 98 / 98).

The source was not changed by the qualification: no gate failed, so there is no "(compression repair)" commit from it.

### 00.5 Types, MEASURED

tsc 5.9.3 `--extendedDiagnostics` under `node --max-old-space-size=1280`, on path-limited archives (src tests tsconfig.json package.json) of the three revisions, 3 rounds with the order rotated each round (main/pre/head, head/main/pre, pre/head/main), 91 runs, every run exit 0 with 0 errors, types and instantiations identical across rounds. `client-N` uses main's chunking (as §0.3, so main is comparable); `gate-client-N` uses each tree's own run-layer-core chunking (1/10/14/5 files). Dense: main runs `dense-before.ts`, pre and head `dense-after.ts` (§4). Logs: scratchpad `compress/qualify/meas/meas.log`, `summary.txt`.

| Program | Types main / pre / post | Post vs main | Post vs pre | Instantiations main / pre / post | Post vs main | Post vs pre | RSS median MiB main / pre / post |
| --- | --- | --- | --- | --- | --- | --- | --- |
| client-1 | 802,129 / 776,409 / 776,061 | −3.25% | −348 | 3,466,692 / 3,051,226 / 3,048,759 | −12.06% | −2,467 | 1,447.9 / 1,394.1 / 1,425.6 |
| client-2 | 850,210 / 857,438 / 857,083 | +0.81% | −355 | 3,871,678 / 3,669,676 / 3,664,996 | −5.34% | −4,680 | 1,420.9 / 1,438.7 / 1,425.7 |
| client-3 | 833,677 / 834,937 / 834,594 | +0.11% | −343 | 3,817,198 / 3,646,906 / 3,643,687 | −4.55% | −3,219 | 1,414.7 / 1,416.5 / 1,411.8 |
| client-4 | 781,169 / 755,389 / 755,041 | −3.34% | −348 | 3,404,399 / 2,988,790 / 2,986,330 | −12.28% | −2,460 | 1,409.2 / 1,383.3 / 1,419.5 |
| instrumentation | 922,065 / 751,094 / 750,736 | −18.58% | −358 | 5,064,021 / 3,062,434 / 3,060,221 | −39.57% | −2,213 | 1,468.3 / 1,430.4 / 1,439.2 |
| schema-only floor | 773,810 / 748,022 / 747,674 | −26,136 | −348 | 3,326,322 / 2,910,659 / 2,908,218 | −12.57% | −2,441 | 1,430.9 / 1,436.6 / 1,439.5 |
| dense (whole feature) | 795,841 / 772,501 / 772,142 | −2.98% | −359 | 3,495,766 / 3,102,679 / 3,099,953 | −11.32% | −2,726 | 1,441.3 / 1,460.5 / 1,449.7 |

gate-client-1..4 types pre → post: 776,409 → 776,061; 857,438 → 857,083; 830,890 → 830,547; 775,911 → 775,524. Instantiations: 3,051,226 → 3,048,759; 3,669,676 → 3,664,996; 3,624,240 → 3,621,021; 3,162,453 → 3,159,957. One run each: soft-delete-acceptance 758,916 → 758,529 types (3,006,114 → 3,003,532 inst); row-reference-nullability 757,240 → 756,893 (2,977,711 → 2,975,251).

Verdict: every program is **lower than the pre-pass** in types and instantiations (the task's bar), and within §5.2's M1 and M2 columns against main (worst client-2 +0.81% types; every instantiation count lower than main). The pre-pass column reproduces §0.3 exactly. Largest run: **1,506.5 MiB** (client-2, post, round 1, during the first rounds, when the bundle archive builds ran in parallel); its other rounds were 1,389.6 and 1,425.7, and the lock-script run of the same chunk peaked at 1,432.5. Under the plan's 1,536; over O7's paraphrased 1,500 once (JUDGEMENT: contention, not the change; types and instantiations fell).

### 00.6 Bundle, MEASURED

tsdown + `scripts/measure-bundle.mjs` on path-limited archives (src scripts package.json tsconfig.json tsdown.config.ts benchmarks/internal), two builds per revision in this session, raw and gzip identical between the two builds of each revision. Raw / gzip / brotli bytes.

| Fixture | main 30ff17e69 | pre-pass 2c1e896bb | post-pass a26cbc8a3 | post − pre | post − main |
| --- | --- | --- | --- | --- | --- |
| **pg-representative** | 543,896 / 160,066 / 135,512 | 565,696 / 166,440 / 141,172 | **564,035 / 166,199 / 141,007** | −1,661 raw / **−241 gzip** | +20,139 raw / **+6,133 gzip** |
| pg-soft-delete | n/a | 566,592 / 166,801 / 141,452 | 564,931 / 166,528 / 141,149 | −1,661 / −273 | +6,462 gzip over main's pg-representative |
| soft-delete entry | n/a | 759 / 395 / 349 | 759 / 395 / 349 | 0 | n/a |
| full | 917,160 / 267,890 / 221,230 | 939,620 / 274,414 / 226,995 | 937,961 / 274,283 / 226,983 | −1,659 / −131 | +6,393 gzip |
| ids-only | 93,221 / 27,891 | 93,221 / 27,892 | 93,221 / 27,892 | 0 | +1 |
| decimal-only | 93,072 / 27,867 | 93,072 / 27,868 | 93,072 / 27,868 | 0 | +1 |

The pre-pass pg-representative gzip here is 166,440; §0.5 recorded 166,409 for the same raw bytes (565,696), the ±~100 B gzip variance U7R-9 describes. The deltas above are taken between this session's builds. **§5.2 base entry ≤ +5 KB gzip: still BREACHED**, +6,133 B (1,133 over 5,000; 1,013 over 5,120). The pass removed 241 B gzip of the 6,374 B over main measured in the same session. No ceiling was raised. STOP U3R-1 stays open for the owner.

### 00.7 Runtime gate, MEASURED

The U5 harness (scratchpad `impl/u7/rt/bench/worker.mjs`, unchanged; runner `compress/qualify/rt/run.sh`) on dists built from the 30ff17e69 and a26cbc8a3 archives above: fresh process per sample, in-memory better-sqlite3, 7 rounds, mainA / head / mainB rotated. ns/op medians of 7. Load average 10-12 during the run: the medians are higher than §0.4's and spreads are wide, and the stability rule is what the verdict rests on.

| Workload | Result | Gate |
| --- | --- | --- |
| No extension (plain read) | mainA 36,472, mainB 37,042: stability 1.6% (rule ≤ 10%); head 31,743, within main's spread [27,597, 59,926], head/main 0.865 | **PASS** |
| Controls only | mainA 29,337, mainB 28,904: stability 1.5%; head 28,856 within [27,307, 39,686], 0.984 | **PASS** |
| Allocation, no extension | main 40,081 B/op, head 40,037, 0 GCs | **PASS** |
| Allocation, controls-only chain | main 40,091, head 40,049 | recorded |

Recorded (head): rows read 27,831; nested read with rows 113,934 (plain 136,885 / main 137,088); soft delete + restore 68,458 (plain update pair 55,360 / main 64,884); bulk deleteMany + restoreMany 63,949; callback transaction 42,821 (plain 44,298 / main 46,241); array transaction 66,944 (plain 65,490 / main 61,453); rows-read allocation 40,610 B/op.

### 00.8 Defects D1–D7 of the elegance review

| Defect | Status |
| --- | --- |
| D1 callable Standard Schema refused while the type accepts it | **Fixed** in C2 (`copyData` keeps a Standard Schema at a leaf as its validator, function or object). Witness extension-controls.core.test.ts ("callable" schema: admitted, validator runs at call time), red on 2c1e896bb by design, green since C2; the review falsified it (dropping the function branch turns it red). CHANGELOG says so. |
| D2 two rules for which keys count | **Fixed** in C2: enumerable own string keys whose value is not undefined count, for members and data alike; a symbol key is refused. Stated once in `copyData`'s TSDoc; kept by the repair. |
| D3 no per-model placement witness | **Closed** in C1: two tests, one per application order; the review's placement mutation turns exactly these red (C1, C3, review). |
| D4 no witness for a root soft delete with a relation-reading projection | **Closed** in C1 (to-many include; restricted candidate with a projection). Since C5 that delete takes `updateMany`'s capture route; removing `updateMany`'s relation-projection clause turns the to-many test red on SQLite3 and batch-only. |
| D5 no credential-free substrate without RETURNING | **Closed** in C1: `createNonReturningSQLite3Driver`, a third consumer in deletion-sites, row-scopes and soft-delete.core. |
| D6 expectations read off the implementation | **Closed** in C6 and the repair: the ForeignKeyError is pinned by class, sentence and the set of relations named, not their order; the admission ledger count 3 re-derived from plan §2.3 (per occurrence per attempt, nested deleteMany plus each captured member) and measured equal to main's update series; the row-reference-nullability pin labelled a documented limitation (plan §5.3). |
| D7 wrong deferral reason in `ExtensionModelClient`'s TSDoc; `Number.isFinite` in cache/key.ts owns no failure | **Open**, not in any unit (minor). src/extensions/methods.ts:108-113 still gives the index-signature reason; src/cache/key.ts:364 still turns NaN/Infinity control values into cache bypasses. |

### 00.9 Gaps

1. **Bundle** STOP U3R-1 (owner): +6,133 B gzip against +5 KB (§00.6).
2. **MySQL**: nothing has ever run. Since C5 a projected root soft delete on MySQL takes the capture route; its only stand-in is the SQLite3 driver without RETURNING (green). Rerun when a server is up: `MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-mysql2` (mysql2-deletion-capability, -soft-delete, -row-scopes, -deletion-races).
3. **PostgreSQL** ran on a scratch Homebrew server, eight files (§00.4); the docker container, the postgres.js project and the PostGIS cells did not run.
4. **Owner questions left by the pass**: whether a Map, Date or class instance where a declaration record stands should keep being read as a record (2c1e896bb's behaviour, restored by the repair; refusing it is a one-line change, R-1); the trailers (§00.1).
5. **Unpinned edges** after the repair, all multi-fault or hostile-input cases: a getter on an unknown member is read before the unknown-member refusal; a record at a leaf position with a throwing getter reports "could not be read".
6. **Not done by judgement**: row 13's pausing-driver mixin for the docker race tests (needs Docker and probably casts, C6-8); D7.
7. The PR description is not updated (no push; publishing is the owner's). The addendum text is in scratchpad `compress/repair/pr-addendum.txt`.

## 0. U7 repair (2026-09-30)

### 0.1 Identity

| Item | Value |
| --- | --- |
| HEAD | **654b3df933f2339596e99d43ddb5df8f3d57a8ae**, tree e32c2c55a6f9f922dcb80e06024b773b9645f3c2 |
| Commits over 30ff17e69 | 13 (the 12 of §1 plus 654b3df93 "(U7 repair)") |
| Working tree | clean; nothing pushed; nothing amended |
| Trailers | 10 `Claude Fable 5.1`, 3 `Claude Opus 5.5` (U2 5b0423e4d, U2 repair 5b6a625f2, U7 repair 654b3df93, which follows the harness attribution instruction). Only a squash or reword at PR time can normalise them (U7R-8). |

### 0.2 Findings and what the repair did

| Review finding | Outcome |
| --- | --- |
| Blocker 1: bundle +6,320 gzip (STOP U3R-1) | **Still open.** Final +6,343 (the DC14 locks +23). Trim attempt measured, reverted (§0.5). Owner ruling required. |
| Blocker 2: docker witnesses claimed but unwritten | **Written and, for PostgreSQL, run.** New: `tests/providers/docker/{pg,mysql2}-deletion-capability.test.ts`, `{pg,mysql2}-soft-delete.test.ts`, `{pg,mysql2}-deletion-races.test.ts` over `tests/contracts/engine/write/deletion-race-behavior.ts` (DC14 create-with-connect racer in both orders, the same racer through a nested set-oriented `deleteMany`, consumer 3 converging, and its hidden-conflict companion). DC14 **failed** without a lock (3 of 5 races red: a tombstone with a live child), so the lock was added as plan §2.3 prescribes (`Commands.unreferenced`, and `restrict.lock` in `execution.ts` for the nested set path); 5/5 green after. Per-arm EXISTS cost measured on PostgreSQL. MySQL files are written, collected (skip without env) and **unexecuted**. |
| Major 3: M2 floor +31,179 as an increment | **Fixed.** `HiddenTargetNull` distributes over the context; floor 748,022 (−2,360 vs M1's 750,382; −25,788 vs main). No reading needed. |
| Major 4: shipped `viborm/soft-delete` never type-checked or run | **Fixed.** The packed consumer writes `use-entry.ts` importing from `viborm/soft-delete`, type-checks and runs it; falsified (§0.4). |
| Minor 5: Biome on two runner scripts | **Fixed.** All 82 code files changed vs main are clean. |
| Minor 6: mixed trailers | Not fixable without rewrite; recorded (§0.1). |
| Minor 7: record-only bundle gzip did not reproduce | Explained: gzip of fixtures that name hashed chunks varies up to ~100 B between builds with identical raw bytes (this repair: full 267,890, ids-only 27,891 at 30ff17e69; the reviewer 267,790 and 27,862). Record-only gzip figures are ±~100 B; raw bytes are exact; pg-representative reproduces exactly (160,066 / 166,386 on three builds). |
| Minor 8: client programs over the O7 +3% paraphrase | **Resolved by measurement**: after the floor fix every client program is within +3% types and instantiations (§0.3). |

### 0.3 Types, MEASURED on the repair tree

tsc 5.9.3 `--extendedDiagnostics`, heap 1,280, run-layer-core chunking at base, 5 alternating rounds base 30ff17e69 / repair, 76 runs, all exit 0 with 0 errors, counts deterministic. Logs: impl/u7-repair/meas/meas.log.

| Program | Types main → repair | Δ | Instantiations Δ | RSS median MiB (Δ) | Repair max MiB |
| --- | --- | --- | --- | --- | --- |
| client-1 | 802,129 → 776,409 | −3.21% | −11.98% | 1,476.8 → 1,487.1 (+10.3) | 1,501.6 |
| client-2 | 850,210 → 857,438 | +0.85% | −5.22% | 1,420.7 → 1,439.8 (+19.1) | 1,445.8 |
| client-3 | 833,677 → 834,937 | +0.15% | −4.46% | 1,410.7 → 1,423.5 (+12.8) | 1,452.6 |
| client-4 | 781,169 → 755,389 | −3.30% | −12.21% | 1,407.8 → 1,394.4 (−13.4) | 1,427.2 |
| instrumentation | 922,065 → 751,094 | −18.54% | −39.53% | 1,438.6 → 1,406.9 (−31.7) | 1,460.3 |
| schema-only floor | 773,810 → 748,022 | −25,788 | −12.50% | 1,424.8 → 1,378.8 (−46.0) | 1,450.1 |
| dense (whole feature) | 795,841 → 772,501 | −2.93% | −11.24% | 1,459.9 → 1,458.5 (−1.4) | 1,483.9 |

HEAD-only, 1 run: gate-client-1..4 776,409 / 857,438 / 830,890 / 775,911 types; acceptance 758,916; row-reference-nullability 757,240. Every §5.2 row holds in **both** the M1 and M2 columns. The floor's M2 increment over M1's close is −2,360. Largest run 1,501.6 MiB: under the plan's 1,536 (U1R-1), 1.6 over O7's paraphrased 1,500.

Why (MEASURED with `--generateTrace`): variance measurement of `OperationResultWithClientDefaults` (8 parameters) and `Operation` (7) took about 1.7 s each; the `[HiddenSurfaces<Context>] extends [never]` test made the context parameter costly to measure. Falsified: inverting the hide test gives 7 type errors (row-reference-nullability 4, soft-delete-acceptance 1, soft-delete-behavior 2).

### 0.4 Commands of the repair, one at a time, with counts

- Scratch PostgreSQL 18.3 (Homebrew binary; initdb in scratch, port 55434, no PostGIS; deleted after): `PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:55434/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg <files>`: pg-deletion-races 5/5, pg-deletion-capability 13/13, pg-soft-delete 17/17, pg-row-scopes 24/24 (59/59, rerun on committed HEAD). Before the locks: races 2 passed, 3 failed.
- The same command without connection strings over the six new docker files, provider-pg + provider-mysql2: 6 files, 69 skipped.
- `node node_modules/typescript-native/bin/tsc --project tsconfig.json --noEmit`: exit 0.
- `pnpm exec biome check --max-diagnostics=500` on the 82 code files changed vs 30ff17e69: 0 diagnostics.
- `node scripts/raptor3-refusal-census.mjs --at HEAD` (572de61f7) and on the repair tree: identical modulo line numbers and the revision line; delta 0.
- Direct vitest, one project at a time: layer-validation 998, scalars 1,159, operation-schemas 1,364, relations 119, schema-validation 470, schema-json 431, query-engine 739, write-engine 82, adapters 190, drivers 988, client 690, cache 85, instrumentation 185, migrations 1,899 (446 files, 9,399 passed); raptor3 2,087 passed and the 7 known reds (cs02 and six G3/G4 generation campaigns); raptor3-provider 32/32; provider-sqlite3 881 + 1 skipped; extended-local 2,348 passed, 393 skipped; dead-symbol gate 225/225.
- `node scripts/run-credential-free-tests.mjs --only …`, each alone: pglite-deletion-capability 13/13 (1,734.5 MiB), pglite-row-scopes 24/24 (1,792.3), pglite-soft-delete 17/17 (1,738.7), shared-family shard 4/8 205/205 (1,731.3), imported-pglite shard 2/2 163 + 14 skipped (1,915.0); teardown verified on each.
- `node scripts/run-node-safe.mjs 512 300000 scripts/<t>.test.mjs`: coverage-policy 11/11, credential-free-ci 4/4, raptor3-campaign-receipts 41/41, raptor3-refusal-census 8/8, bounded-process 16/16, test-run-lock 6/6; raptor3-cli 10/10 with a 900 s wall limit (the 300 s run exceeded its wall under load average 30; one earlier 900 s run was invalidated because a probe edited src during it).
- Lock scripts, one at a time: test:types exit 0; test:core exit 0 (9,399/9,399); test:layer:instrumentation exit 0; test:coverage exit 0, every subsystem at or above its floor (extensions 100; query-engine core 93.8/94.21/94.43/93.8; client 96.33/94.37/96.5/96.33; drivers 96.04/92.69/96.06/96.04; migrations 98.68/97.3/99.89/98.68). test:layer:client, test:layer:query-engine and test:package first failed on wall limits and a vitest RPC timeout under load (all tests passed); rerun alone at lower load: exit 0 each (690/690 and types chunks ≤ 1,434.2 MiB; 739/739; package 13/13 including the entry consumer).
- Entry consumer falsified: a packed tarball whose `dist/soft-delete.d.mts` types `softDelete` as `any` fails `use-entry.ts` only (1 TS2322, 5 TS2578).
- Per-arm EXISTS on PostgreSQL (1,000 pins, 500 hidden claims, 7 × 50 alternating runs of the two statement texts): 2.436 vs 2.286 ms median, +0.151 ms per query, 301 ns per hidden claimed row, inside the no-EXISTS arm's own spread (2.18-2.77).
- Runtime gate (U5 harness, 7 rotated rounds, dists built from 30ff17e69 and the repair): plain read head 27,049 vs mainA 27,126 / mainB 28,152 (stability 3.8%, within spread, 0.985): PASS; controls read 27,759 vs 27,318 / 27,368 (0.2%, 1.014): PASS; no-extension allocation 40,037 vs 40,089 B/op, 0 GCs: PASS. Recorded: rows read 26,093; nested read 97,222 (plain 124,701 / main 124,606); soft delete + restore 56,351 (plain update pair 49,486 / 48,901); bulk 54,021; callback tx 36,781 (35,153 / 34,644); array tx 56,970 (51,277 / 51,784). The harness schema has no restricting relation, so the DC14 lock is not on these paths.

### 0.5 Bundle, MEASURED

tsdown + `scripts/measure-bundle.mjs`, raw / gzip bytes.

| Fixture | main 30ff17e69 | 572de61f7 | repair |
| --- | --- | --- | --- |
| pg-representative | 543,896 / 160,066 | 565,576 / 166,386 | **565,696 / 166,409 (+6,343 vs main)** |
| pg-soft-delete | n/a | 566,472 / 166,750 | 566,592 / 166,775 |
| soft-delete entry | n/a | 759 / 395 | 759 / 395 |
| full | 917,160 / 267,890 (±~100) | 939,500 / 274,364 | 939,620 / 274,414 |
| ids-only | 93,221 / 27,891 (±~100) | 93,221 / 27,892 | 93,221 / 27,892 |

Why trimming cannot close it (MEASURED, src-direct esbuild proxy of pg-representative, which tracks the dist delta within ~125 B): stubbing out the entire capability-definition snapshot (controls, rows and deletion normalization in definition.ts) removes 1,950 B gzip; a compact copy-first rewrite of that code, all extension tests green, saved 128 B gzip (−664 raw), about 7% of what it touched. At that yield compacting the whole feature gives about 435 B against the ≥ 1,345 B needed. The rewrite was reverted (scratch: impl/u7-repair/definition.ts.copyfirst). Refusal-message text of that file is 433 B gzip in total. **JUDGEMENT:** reaching +5 KB needs a design change (removing a planned behavior or moving capability code out of the base entry), which is an owner decision under §5.4.

### 0.6 Exit checklists after the repair

M1: every item of §8 stands, with these changes: "every M1 witness on PostgreSQL, MySQL and SQLite" is **met for PostgreSQL** (pg driver on a real server, including DC14 and DC10-style races) and **not met for MySQL**; "§5.2 holds: types" met in the M1 column; "§5.2 holds: bundle" **NOT MET**.
M2: nullability, integrity and recursion rows met on SQLite3, batch-only SQLite3, PGlite and PostgreSQL (pg); §5.2 M2 types met without any reading; per-arm EXISTS cost measured on SQLite and PostgreSQL; bundle **NOT MET**.

### 0.7 Remaining gaps

1. Bundle STOP U3R-1 (owner).
2. MySQL: nothing executed. Rerun when a server is up: `MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-mysql2` (covers mysql2-row-scopes, -deletion-capability, -soft-delete, -deletion-races: InnoDB REPEATABLE READ behaviour of the locks and of consumer 3 is untested). The docker PostgreSQL container and the postgres.js project were not run; the pg lane ran on a scratch server without PostGIS, only the four files named above.
3. Trailers (§0.1).
4. The unregistered reviewer probes under `tests/raptor3/g4/review/` that import run-raptor3.mjs belong to no vitest project and were not run.

## 1. Commit identity

| Item | Value |
| --- | --- |
| Worktree | /Users/arnaud/code/viborm-ext |
| Branch | extension-capabilities |
| Base | origin/main = merge-base = 30ff17e69 (30ff17e69fcb936b40ec3866029117fa5b4cb5dd) |
| HEAD | **572de61f743b83871725106bc77bb2e69a893959**, tree a575bfe9e0ca311a92a48e07c83aa646f7799d64 |
| Working tree | clean; nothing pushed; nothing amended |
| Diff vs main | 89 files, +10,793 / −701 physical lines |

The branch has 12 commits (origin/main..HEAD):

| Unit | Commit | Repair |
| --- | --- | --- |
| U1 | e151a686f | 2ac4eae84 |
| U2 | 5b0423e4d | 5b6a625f2 |
| U3 | ccca6801a | 5cbcf8fe3 |
| U4 | 84a161280 | eca08f842 |
| U5 | 5e8a7fa50 | 5d045dbdb |
| U6 (M2) | 432c93b9b | 572de61f7 |

Attribution trailers are inconsistent: 10 commits carry `Co-Authored-By: Claude Fable 5.1`, and 2 (U2 5b0423e4d, U2 repair 5b6a625f2) carry `Claude Opus 5.5`. Without amending, this can only be fixed by squash or rewrite at PR time. That is the owner's call.

## 2. Runtime identity

| Item | Value |
| --- | --- |
| Node | v24.21.0 (vite-plus runtime) |
| pnpm | 10.11.0 |
| TypeScript for budgets | 5.9.3 (node_modules/typescript), gate heap `--max-old-space-size=1280` |
| TypeScript native (tsgo) | typescript@7.0.2 (node_modules/typescript-native) |
| vitest | 3.1.4 |
| tsdown | 0.19.0-beta.4 |
| Biome | 2.3.11 |
| Machine | macOS 26.5.1 arm64, 48 GiB RAM (51,539,607,552 B), 14 CPUs |

Machine noise during the qualification: another session's vitest process (edytor-arch-v2) ran at about 99% CPU the whole time, and the load average was 22-58 when the runtime gate started. The runtime gate's stability rule is what protects its verdict from this.

Docker: `docker info` exits 1, and `nc -z 127.0.0.1 5434` and `nc -z 127.0.0.1 3307` both fail.

## 3. Every command, one at a time, with counts and outcomes

All commands were run from /Users/arnaud/code/viborm-ext. Logs are in `impl/u7/logs/`.

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `pnpm exec biome check --max-diagnostics=500 <75 changed .ts/.mjs/.json files vs 30ff17e69>` | 73 files clean. The only diagnostics are in scripts/run-raptor3.mjs (38) and scripts/raptor3-campaign-receipts.test.mjs (54). Both counts are identical at 30ff17e69, measured in scratch archives with the repo's biome.jsonc. **Deviation, pre-existing since U3, not reformatted (U7-2).** |
| 2 | `node node_modules/typescript-native/bin/tsc --project tsconfig.json --noEmit` | exit 0, 0 errors, 9.0 s |
| 3 | `node scripts/raptor3-refusal-census.mjs --at 30ff17e69`, then `--at HEAD`, then on the working tree | All exit 0. main and HEAD are **identical modulo line numbers**: 203 sites; invariant 25 sites / 24 sentences; inherited 76 / 76; candidate 44 / 35; rethrow 58. Delta 0. U3's new referential ForeignKeyError is built in a `DeferredFailure` thunk (`createFailureError`) and thrown by an existing rethrow, which the census cannot see by construction. It is recorded in the guard ledger instead (U3-10, U3R-6). |
| 4 | `pnpm exec vitest run --workspace vitest.workspace.ts tests/contracts/engine/write/dead-symbol-gate.core.test.ts` | 3 files (layer-write-engine, coverage-write-engine-core, one more), 225/225 |
| 5 | `node scripts/run-node-safe.mjs 512 300000 scripts/<t>.test.mjs` (manifest and policy tests) | coverage-policy 11/11; credential-free-ci 4/4; raptor3-campaign-receipts 41/41; raptor3-cli 10/10; raptor3-refusal-census 8/8; bounded-process 16/16; test-run-lock 6/6. All exit 0. |
| 6 | Manifest registration (read) | Registered: row-scopes 57 cells (POST_G3_ROW_SCOPE_COUNTS); deletion-sites 26; coverage-extensions list (extension-controls, extension-deletion, soft-delete.core); coverage-policy extensionCoverageTests; soft-delete consumer smoke in tests/package/package.test.ts. Picked up by globs, no manifest entry needed: PGlite files (`tests/providers/local/pglite*.test.ts`), docker files (`tests/providers/docker/pg*` and `mysql2*`), mutation-cache-control (tests/unit/cache glob), referential-delete-actions (layer glob), type files (run-layer-core readdir). |
| 7 | `pnpm exec vitest run --workspace vitest.workspace.ts --project <p>`, once per layer project | validation 42 files / 998; scalars 26 / 1,159; operation-schemas 50 / 1,364; relations 7 / 119; schema-validation 26 / 470; schema-json 10 / 431; query-engine 34 / 739; write-engine 4 / 82; adapters 12 / 190; drivers 44 / 988; client 50 / 690; cache 7 / 85; instrumentation 17 / 185; migrations 117 / 1,899. **All pass: 446 files, 9,399 tests.** |
| 8 | `... --project raptor3` | 200 files passed and 7 failed (207); 2,087 tests passed and 7 failed (2,094). The 7 failures are **exactly the known reds**: cs02-structure-measure; g3 sqlite-campaign and transport-campaign; g4 sqlite-campaign, transport-campaign, write-campaign and write-transport-campaign. |
| 9 | `... --project raptor3-provider` | 9 files, 32/32 |
| 10 | `... --project provider-sqlite3` | 16 files, 881 passed, 1 skipped |
| 11 | `... --project extended-local` (whole project, including every touched extended-local file) | 171 files passed and 22 skipped; 2,348 tests passed and 393 skipped (the skips are docker-gated) |
| 12 | `node scripts/run-credential-free-tests.mjs --only "pglite-deletion-capability"` (alone) | 13/13, 10.97 s, **1,914.4 MiB** peak sampled RSS (ceiling 2,560), teardown verified |
| 13 | `... --only "pglite-row-scopes"` | 24/24, 17.19 s, **1,984.5 MiB** |
| 14 | `... --only "pglite-soft-delete"` | 17/17, 12.84 s, **1,737.3 MiB** |
| 15 | `... --only "shared-family shard 4/8"` (official-cache-invalidation.test.ts) | 14 files, 205/205, 14.91 s, **1,757.7 MiB** |
| 16 | `... --only "imported-pglite shard 2/2"` (official-cache-extension.test.ts) | 8 files passed and 2 skipped; 163 tests passed and 14 skipped; 8.24 s, **2,000.4 MiB** |
| 17 | `docker info` | exit 1. **Docker gap, recorded (§7).** |
| 18 | `pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg --project provider-postgres --project provider-mysql2` (no connection strings) | 34 files skipped (1,793 tests skipped). The new pg-row-scopes and mysql2-row-scopes files collect and skip 24 + 24. Two pre-existing pg files (pg-batch-reference-reuse, pg-captured-set-concurrency; unchanged since main) fail to collect with "Invalid URL" without env. **Nothing ran against a database.** |
| 19 | **LOCK** `pnpm test:types` | exit 0, 10 s; whole-estate native typecheck, 6,950.7 MiB peak (ceiling 8,192) |
| 20 | **LOCK** `pnpm test:core` | exit 0, 75 s; 446 files, 9,399/9,399; 1,203.4 MiB peak (ceiling 1,536) |
| 21 | **LOCK** `pnpm test:package` | exit 0, 59 s; package.test.ts 13/13, including "lets a third party build soft delete from public exports alone" (11.0 s), the packed public-surface golden and the TS 5.8 consumer floor |
| 22 | **LOCK** `pnpm test:coverage` (all subsystems) | exit 0, 588 s. **Every threshold holds** (table below). |
| 23 | **LOCK** `pnpm test:layer:client` | exit 0, 40 s; runtime 690/690 (731.8 MiB); type chunks 1-4 peak 1,434.8 / 1,441.9 / 1,436.2 / 1,433.4 MiB (ceiling 1,536) |
| 24 | **LOCK** `pnpm test:layer:query-engine` | exit 0, 15 s; 739/739 (861.1 MiB); types 1,451.3 MiB |
| 25 | **LOCK** `pnpm test:layer:instrumentation` | exit 0, 11 s; 185/185 (618.2 MiB); types 1,455.5 MiB |
| 26 | Bundle: tsdown + `node scripts/measure-bundle.mjs` on path-limited archives of 30ff17e69 and HEAD, plus the worktree dist from test:package | §5 |
| 27 | Runtime gate: U5 harness (fresh process per sample, in-memory better-sqlite3, built dists of 30ff17e69 and HEAD), 7 rounds, mainA / head / mainB rotating | §6 |
| 28 | Type budget: tsc 5.9.3 `--extendedDiagnostics`, heap 1,280, run-layer-core chunking, 5 alternating rounds base 30ff17e69 / HEAD, 76 runs | §4 |
| 29 | Code-bearing line accounting (TypeScript-scanner token rule) per unit | §10 |

Coverage thresholds from `pnpm test:coverage` (statements / branches / functions / lines, floors in brackets):

| Subsystem | Result |
| --- | --- |
| public, schema, validation, sql, instrumentation, **extensions**, errors, adapters, CLI | 100 / 100 / 100 / 100 (floor 100) |
| query-engine core | 93.8 / 94.2 / 94.41 / 93.8 (87 / 91 / 90 / 87) |
| drivers | 96.04 / 92.69 / 96.06 / 96.04 (96 / 92.5 / 96 / 96) |
| client | 96.33 / 94.37 / 96.5 / 96.33 (96 / 94 / 96 / 96) |
| cache | 100 / 100 / 100 / 100 (98) |
| migrations | 98.68 / 97.3 / 99.89 / 98.68 (98 / 97.3 / 98 / 98) |

The extensions subsystem includes src/soft-delete/index.ts (U5-3).

## 4. Type budget, before (30ff17e69) and after (HEAD 572de61f7). MEASURED.

Setup: tsc 5.9.3 `--extendedDiagnostics` under `node --max-old-space-size=1280`. Client programs are chunked exactly as run-layer-core chunks them at base (4 chunks). Dense is the 64-model / 122-relation program, whole feature. The floor is the schema-only program. 5 alternating rounds, 76 runs: all exit 0, 0 errors, type counts deterministic. Types and instantiations reproduce fx6's numbers exactly. Logs: impl/u7/meas/meas.log and summary.txt.

| Program | Types main → HEAD | Δ | Instantiations main → HEAD | Δ | RSS median MiB main → HEAD | Δ | HEAD max MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| client-1 | 802,129 → 809,948 | +0.97% | 3,466,692 → 3,073,319 | −11.35% | 1,465.5 → 1,471.8 | +6.3 | 1,476.5 |
| client-2 | 850,210 → 890,991 | +4.80% | 3,871,678 → 3,691,884 | −4.64% | 1,444.3 → 1,442.5 | −1.8 | 1,447.7 |
| client-3 | 833,677 → 868,479 | +4.17% | 3,817,198 → 3,669,036 | −3.88% | 1,426.1 → 1,440.3 | +14.2 | 1,446.7 |
| client-4 | 781,169 → 788,928 | +0.99% | 3,404,399 → 3,010,883 | −11.56% | 1,416.7 → 1,431.3 | +14.6 | 1,451.8 |
| instrumentation | 922,065 → 784,633 | −14.90% | 5,064,021 → 3,084,527 | −39.09% | 1,425.7 → 1,417.0 | −8.7 | 1,456.8 |
| schema-only floor | 773,810 → 781,561 | **+7,751** | 3,326,322 → 2,932,752 | −393,570 | 1,424.1 → 1,435.3 | +11.2 | 1,437.8 |
| dense (whole feature) | 795,841 → 806,040 | +1.28% | 3,495,766 → 3,124,772 | −10.61% | 1,468.4 → 1,484.7 | +16.3 | 1,487.7 |

HEAD-only programs, 1 run each:

| Program | Types | Instantiations | RSS MiB |
| --- | --- | --- | --- |
| gate-client-1 | 809,948 | 3,073,319 | 1,477.0 |
| gate-client-2 | 890,991 | 3,691,884 | 1,446.7 |
| gate-client-3 | 864,432 | 3,646,370 | 1,394.8 |
| gate-client-4 | 809,458 | 3,184,410 | 1,426.9 |
| acceptance | 792,456 | 3,028,215 | 1,389.5 |
| row-reference-nullability | 790,786 | 2,999,660 | 1,367.0 |

Largest run in the whole set: **1,487.7 MiB** (dense, HEAD). It is under both 1,536 (plan) and 1,500 (O7's paraphrase).

Verdict against §5.2, M2 column (HEAD contains M2):
- Each client program: ≤ +6% types and ≤ +3.5% instantiations. **Holds**; the worst is client-2 at +4.80% / −4.64%.
- Dense: same budget. **Holds**, +1.28%.
- Instrumentation: ≤ +4%. **Holds**, −14.90%.
- RSS: median ≤ main + 30 MiB, no run over 1,536. **Holds**; the largest median rise is +16.3, the largest run 1,487.7.
- Floor: "plus ≤ +30k types". **Holds only on the cumulative reading** (U6-8, U7-3): +7,751 vs main, well within M1's +15k plus M2's +30k. Read as an increment over M1's close (750,382 at 5d045dbdb, measured in U5/U6R-4), it is **+31,179, 1,179 over "+30k"**. The owner may overrule the reading.

At M1's close, U5 measured 5 rounds against main: every program within M1's ≤ +3% (client-2 +1.06% was the highest), floor −23,428 types, dense −2.65%.

Heap headroom (MEASURED, "Memory used"): HEAD programs use about 1.16-1.30 GB of the 1.28 GB gate heap. Headroom for further type work is very small.

## 5. Bundle. MEASURED.

Setup: tsdown + `scripts/measure-bundle.mjs` on path-limited archives (src scripts package.json tsconfig.json tsdown.config.ts benchmarks/internal). Sizes are bytes, raw / gzip / brotli. Logs: impl/u7/bundle/.

| Fixture | main 30ff17e69 | HEAD 572de61f7 | Δ gzip | §5.2 |
| --- | --- | --- | --- | --- |
| **Base entry, pg-representative** | 543,896 / 160,066 / 135,512 | 565,576 / 166,386 / 141,049 | **+6,320** (+21,680 raw, +5,537 brotli) | ≤ +5 KB gzip: **BREACHED**, STOP U3R-1 open |
| Base with extension, pg-soft-delete | n/a | 566,472 / 166,750 / 141,378 | +364 over HEAD's pg-representative (+6,684 over main's) | recorded |
| `viborm/soft-delete` entry | n/a | 759 / 395 / 349; imports nothing | n/a | recorded |
| full | 917,160 / 267,890 | 939,500 / 274,364 | +6,474 | recorded |
| ids-only | 93,221 / 27,891 | 93,221 / 27,892 | +1 | unchanged |
| decimal-only | 93,072 / 27,867 | 93,072 / 27,868 | +1 | unchanged |

The worktree dist from `pnpm test:package` gives identical raw bytes and 29 B less gzip on pg-representative (166,357) and pg-soft-delete (166,721). This is gzip variance on identical raw bytes (U7-5).

Where the base-entry gzip went, per unit (measured by the units, archive builds):

| Unit | Δ gzip |
| --- | --- |
| U1 | 0 |
| U2 | +3,564 (U2 5b0423e4d +3,558; repair −22) |
| U3 | +2,068 (+1,974; repair +94) |
| U4 | +634 |
| U5 | 0 |
| U6 | +54 |

Total: 166,386 − 160,066 = +6,320.

JUDGEMENT: the cost is structural. U2's largest shares are the hostile-safe definition normalization (definition.ts about +2.1 KB gzip, controls.ts about +1.6 KB); U3's is the deletion effect itself (commands.ts, rows.ts, relation-body.ts). The trims found were worth tens of bytes (U2R-7, U3R-1). §5.2 says a breach is "never permission to raise a ceiling". **An owner decision is required before M1 or M2 can be declared exited.**

## 6. Runtime benchmark gate. MEASURED.

The U5 harness, re-run on dists built from 30ff17e69 and HEAD in scratch archives (impl/u7/rt/bench: samples.log, run.sh, sum.mjs, worker.mjs). 7 rounds of fresh processes, mainA / head / mainB rotating. Times are ns/op, median over 7 samples. Allocation is heapUsed delta over 1,000 ops with 0 GCs in the window.

| Workload | Result | Gate |
| --- | --- | --- |
| No extension (plain read) | main A 27,247, main B 27,685: **stability 1.6%** (rule ≤ 10%). HEAD 27,500, within main's spread [26,187, 30,510], head/main 0.994 | **PASS** |
| Controls only | main A 27,507, main B 27,927: **stability 1.5%**. HEAD 27,768, within [26,432, 31,352], 0.994. On main this arm is the same read through a name-only extension, because main has no controls. | **PASS** |
| Allocation, no extension | main 40,095 B/op, HEAD 40,035 | an unextended client allocates nothing new: **PASS** |
| Allocation, controls-only chain | main 40,094, HEAD 40,043 | recorded |

Recorded for the owner (HEAD rows client vs plain on HEAD / main):

| Workload | Rows client | Plain HEAD / main |
| --- | --- | --- |
| rows read | 26,720 (fewer rows returned) | plain read 27,500 |
| nested read | 100,263 | 127,751 / 126,660 |
| single soft delete + restore | 58,287 | plain update pair 50,368 / 50,355 |
| bulk deleteMany + restoreMany | 54,474 | n/a |
| callback transaction | 38,243 | 35,302 / 35,243 |
| array transaction | 58,586 | 51,288 / 51,726 |
| rows read allocation | 41,260 B/op | n/a |

## 7. Qualification gaps, stated plainly

1. **PostgreSQL and MySQL: nothing executed, ever.** Docker was down in U1 through U7. The plan's M1 exit asks for "every M1 witness on PostgreSQL, MySQL and SQLite through public entry points", and **that exit item is not met**. PGlite (the PostgreSQL engine, in-process, one connection) and SQLite3 / batch-only SQLite3 carry every witness. Never run on a real server:
   - the DC14 create-with-connect racer (the FOR UPDATE lock decision is OPEN, U3R-5);
   - consumer 3 (a live race converging under a domain, U4-8);
   - the PostgreSQL/MySQL restrict and upsert races (DC10, DC14);
   - MySQL's non-RETURNING tombstone paths;
   - MySQL's missingArm CASE inside JSON_OBJECT/COALESCE;
   - the packaged-guard attribution on PostgreSQL batches;
   - the per-arm EXISTS cost on PostgreSQL (measured on SQLite only).
   tests/providers/docker/pg-row-scopes.test.ts and mysql2-row-scopes.test.ts, and the MySQL arm of dropConstraints, are written but never executed. No docker consumer exists for soft-delete-behavior.ts or deletion-capability-behavior.ts. The known PostGIS-less pg container may turn pg docker files red regardless.
   Rerun: `PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm pnpm exec vitest run --workspace vitest.workspace.ts --project provider-pg --project provider-postgres --project provider-mysql2`.
2. **Bundle budget breached (§5): STOP U3R-1 is open.** +6,320 B gzip against +5 KB.
3. **M2 floor passes only on the cumulative reading (§4).**
4. **Biome deviation (U7-2).** Two touched runner scripts carry 38 and 54 pre-existing diagnostics, equal to main.
5. **Known reds**, all present at main: raptor3 has 7 (cs02-structure-measure and six G3/G4 generation campaigns). Not exercised here: the relation-language-census ENOENT (not red in the architecture run, per rv5) and the PostGIS cells (docker).
6. **Accepted limits recorded, not refused:**
   - a model-mapped query handler does not see `rows` declared in its own definition (U6R-3);
   - the DC22 replay compiles, with its types following the first client;
   - a revoked proxy in a *shipped* member (request, query, model) is still a raw TypeError (inherited, U2R-2);
   - an empty deletion entry behaves like `update({ data: {} })` (U3R-10);
   - batch-only arrays still refuse soft deletes with a relation projection, and nested soft deletes, exactly as the base client refuses the hard equivalents (U3R-3);
   - batch-only instrumentation logs one event per batch unit (inherited, U3R-8).
7. **Plan wording differs from the implemented and ratified behaviour. The orchestrator must amend:**
   - §2.4: key on "a read that admitted a control" (U2-7, U2R-6, U4-6);
   - §2.2: which files own prepared domains (U4R-4).
8. **Scratch only:** the runtime harness is not committed (U5-9). The docs link to src/soft-delete/index.ts on GitHub main resolves only after merge.
9. **Instrument limits:**
   - RSS medians at 94-98% heap are noisy; the same source has measured −25.7 to +47.4 MiB between sessions (U1R-8).
   - PGlite peaks here were 1,737-2,000 MiB against a 2,560 ceiling, sampled process-group RSS.
   - O7's "1,500 MiB" versus the plan's 1,536 MiB: U1R-1 ruled that 1,536 governs. Some runs on U1-U6 sources exceeded 1,500, but none in this set did.

## 8. Exit checklists against plan §5

### M1 (§5.1 "Exit, all executed")

| Item | Status | Evidence |
| --- | --- | --- |
| Every M1 witness on PostgreSQL, MySQL and SQLite through public entry points | **NOT MET** for PostgreSQL (server) and MySQL; met on SQLite3, batch-only SQLite3 and PGlite | §3 rows 7-16; gap 1 |
| §1.1 run end to end by the fixture | MET | soft-delete.core.test.ts (layer-client, 19), pglite-soft-delete 17/17, packed third-party consumer (`pnpm test:package`) |
| §5.2 holds: types | MET (M1 at U5 close; the final source against the M2 column, with the floor reading of gap 3) | §4 |
| §5.2 holds: RSS | MET | §4 |
| §5.2 holds: runtime gate | MET | §6 |
| §5.2 holds: bundle | **NOT MET** (STOP U3R-1) | §5 |
| An unextended client allocates nothing new | MET (40,035 vs 40,095 B/op) | §6 |
| A chain without rows or controls keeps today's path | MET: chain.ts binds no call facts; cache key byte-identical (DC7 witnesses); plain-client SQL bytes pinned (U6) | U2-7, U3 review, U6 |
| No result type changes | MET for the base client. Plugins generic over the client see the announced type changes (`M[K & keyof M]`, DC22 replay, DC2 application-only), listed in CHANGELOG "Changed (types)". | CHANGELOG |
| Framing grep finds no soft-delete branch | MET: over `git diff 30ff17e69 HEAD -- src ':!src/soft-delete' ':!*.md'`, with `tombstone` (the plan's §2.3 generic vocabulary) excluded, zero hits for soft/deletedAt/deletedBy/restore/"deleted"/"only"/"without"/"hard"/viborm.soft | this run |
| No cast beyond §1.1's three | MET: src/soft-delete/index.ts lines 30, 95, 96. Added `as` in the rest of src: one mapped-type key remap (controls.ts) and one `as const` (ROOT_CANDIDATES). | this run |
| Independent review of the changed perimeter; required gates on frozen source | MET: rv1-rv6 plus this qualification | reports |
| Guides | MET | soft-delete.mdx: `restore` (13 mentions), `mode: "hard"` with a `:::warning` beside the purge (ruling 8), one actor per transaction, "never for tenant isolation", partial-unique recipe. create.mdx: controls/rows/deletion, DC22 plugin binding. |

### M2 (§5.3 exit: v2 §6 M2 rows, §5.2 M2 budgets, per-arm EXISTS cost)

| Item | Status | Evidence |
| --- | --- | --- |
| Nullability rows: managed target nullable, unique unmanaged target precise, same-shaped twins widen, recursive and polymorphic agree with runtime | MET | row-reference-nullability.core.types.ts (CM002 control); witnesses falsified in U6/U6R |
| Physical-integrity rows: hidden polymorphic arm reads null and a dangling row still fails; junction orphan fails; hidden duplicate singular membership fails; required polymorphic carrier | MET on SQLite3 / batch-only / PGlite; not run on PostgreSQL (server) or MySQL | row-scopes 57 cells, pglite-row-scopes 24 |
| Recursion: upward to-one reads null; the recursive step reads the domain | MET | U6R-1 witnesses |
| `$withCache` hidden relation nullable | MET | U6 |
| §5.2 M2 budgets: types | MET (floor on the cumulative reading) | §4 |
| §5.2 M2 budgets: bundle | **NOT MET** (the same STOP) | §5 |
| Per-arm EXISTS cost measured | PARTIAL: SQLite only, +8 to +15 µs per query for 1,000 pins with 500 hidden claims (U6); PostgreSQL not timed | U6 |
| No hidden target under a non-null type | MET, including query handlers' `proceed()` (U6R-3) | U6R-3 witness |

## 9. Decisions taken while the owner was away

The full text is in scratchpad/softdelete/impl/decisions.md: 126 entries. Per unit:

| Unit | Entries |
| --- | --- |
| U1 | 10 + 8 repair |
| U2 | 15 + 7 repair |
| U3 | 11 + 11 repair |
| U4 | 12 + 7 repair |
| U5 | 12 + 5 repair |
| U6 | 12 + 9 repair |
| U7 | 7 |

The ones the owner should read first:
- U1R-1 / U7-4: the RSS ceiling is 1,536 (plan), not O7's paraphrased 1,500.
- U2-7 / U2R-6 / U4-6: the cache key is `[args, controls, rowIdentity]` only when a read admitted a control; otherwise today's key byte for byte. §2.4's wording needs amending.
- U2R-1: a fifth announced breaking cache change. A cache-chain write with a primitive argument moves from CacheConfigurationError to ValidationError.
- U2R-3: the official cache always places its own control.
- U3-3 / U3R-3: soft deletes pack into batch-only arrays through the packaged guard. The guard-failure taxonomy gains `foreignKey`.
- U3R-5: DC14 (FOR UPDATE lock) is OPEN, pending the docker racer.
- U3R-6 / U3R-7: the core ForeignKeyError carries the caller's verb and "one of its relations".
- U3R-10: an empty deletion entry is documented, not refused.
- U4-3: nested write lookups take the related purpose on every edge.
- U4-4: DC10 on the batch route. The found UPDATE carries the root domain, so a race loser gets NotFound.
- U5-1: §1.1 ships verbatim, git-moved; three casts.
- U6-4: a rows model set typed `string` hides every model (+1,267 floor types, taken for soundness).
- U6-8 / U6R-4 / U7-3: the cumulative floor reading.
- U6R-3: query handlers typed with the chain's rows context; `ClientOperationResult` deleted (internal).
- The orchestrator's O4-O7 (rulings.md): per-target nullability; `set` over a required FK keeps its refusal; the cache breaking changes announced; the budgets as written; the docker gap recorded; one PR, no merge.

## 10. Accounting. MEASURED.

Rule: the repo's code-bearing rule (TypeScript scanner, `countTokenLines`). A line counts when a parser-owned token starts on it; comments and JSDoc are excluded. Docs are physical lines. Script: impl/u7/codelines-rev.mjs; output: impl/u7/accounting.txt.

| Unit (unit + repair) | src code-bearing | tests + scripts code-bearing | docs (.md/.mdx) physical |
| --- | --- | --- | --- |
| U1 30ff17e69..2ac4eae84 | +295 / −83 (net +212) | +303 | +18 |
| U2 ..5b6a625f2 | +1,444 / −257 (net +1,187) | +1,514 / −27 | +66 / −5 |
| U3 ..5cbcf8fe3 | +668 / −116 (net +552) | +1,077 / −3 | +17 |
| U4 ..eca08f842 | +293 / −102 (net +191) | +1,122 / −1 | +44 |
| U5 ..5d045dbdb | +95 (net +95: src/soft-delete/index.ts, git-moved from the U1 test fixture) | +788 / −1 | +641 / −53 |
| U6 ..572de61f7 | +158 / −57 (net +101) | +737 / −10 | +103 / −22 |
| **Total vs main** | **+2,850 / −512, net +2,338** (21,528 → 23,866) | **+5,434 / −30, net +5,404** | **+867 / −58** |

src net by area:

| Area | Net code-bearing lines |
| --- | --- |
| src/extensions | +1,515 |
| src/query-engine/raptor3 | +564 |
| src/client | +114 |
| src/soft-delete | +95 |
| src/cache | +91 |
| query-engine/pending-operation.ts | +35 |
| schema | +16 |
| validation | +14 |
| batch-error-attribution | +4 |
| index.ts | +2 |
| migrations | −8 |
| query-engine/cache-flow.ts | −104 |

Against the plan's estimate (JUDGEMENT on the comparison, the counts are measured):
- src: +2,338 net, against the plan's "about 1,870-2,120 code lines", so 10-25% over. The excess is concentrated in U2's hostile-safe definition normalization (definition.ts about +585).
- The soft-delete entry is 95 code-bearing lines as Biome formats it, against the plan layout's 65. The token content is identical to §1.1.
- tests: +5,404 against the plan's "about 4,000" (manifests and receipt scripts included).

## 11. CHANGELOG check

CHANGELOG.md "Unreleased" was read against O6 and the units.

| Required entry | Present |
| --- | --- |
| Added `viborm/soft-delete` | yes |
| Added `controls`/`rows`/`deletion` ("nine capabilities") | yes |
| Added `ExtensionState` and `ExtendedOperationResult` exports | yes |
| Changed (types): `M[K & keyof M]`, DC22 replay, DC2 application-only, `Client`'s optional 4th parameter, `$withCache` controls | yes |
| O6's four breaking cache changes (patches cannot inject/replace `cache`; request handlers no longer see it; throwing getter → QueryError; checked before request handlers) | yes |
| U2R-1's fifth (primitive mutation arguments → ValidationError) | yes |
| The two additions (`cache()` value has `controls`; handler `context.controls`) | yes |
| The two DC6 items that do NOT happen (`Client`'s 3rd parameter meaning; the "Invalid mutation cache options" message) | yes, under "Unchanged" |
| M2's to-one `null` and `| null` typing | yes |
| query handlers' `proceed()` read rows | yes |

Not listed, and correctly so, because both were internal and absent from every public entry (checked against src/client/exports.ts and the golden): the deleted `ClientOperationResult` and `ClientRelationDefaults`.

Public-surface golden diff vs main: `ExtendedOperationResult` and `ExtensionState` on `.`; the new `./soft-delete` subpath (`softDelete`; types `SoftDeleteConfig`, `SoftDeleteModel`); `softDelete` pinned absent from the root. Nothing else.

## 12. Head

**572de61f743b83871725106bc77bb2e69a893959** on extension-capabilities, unchanged by U7. It is ready to open as one PR against main, not merged, once the owner rules on:
- the bundle STOP (U3R-1);
- the M2 floor reading;
- whether the PostgreSQL/MySQL gap blocks the PR or is closed by a follow-up docker run.
