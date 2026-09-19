# Review — release unit "triage" (the Docker provider reds)

Reviewer: independent, this session. `author`'s files (`src/`, `tests/`,
`note.md`) were never edited by this review — every falsification below ran
in a detached scratch worktree at `/private/tmp/viborm-triage-scratch`
(`git worktree add --detach ... 383f830c`, `node_modules` symlinked to the
shared store, never modified). `TMPDIR=/private/tmp/viborm-triage-tmp-r`
exported for every run in this review, per the reviewer brief (a separate
directory from the author's own `.../triage-tmp`). Nothing was committed,
staged, reset or stashed in either worktree.

## Verdict: ACCEPT

Both repaired defects (R1, R2) are correctly scoped, minimally invasive,
falsify exactly as the note predicts, and introduce no collateral
regressions on either provider. The two test-file diffs are legitimate bug
fixes to test setup, not weakened assertions. The family triage in §3 is
accurate against the receipts and against my own independent full run. One
MEDIUM finding (R2's disclosed-but-under-escalated consequence) and two LOW
findings (receipts organization, a citation source) are below, with minimal
resolutions; none of them block this release.

---

## Findings

### MEDIUM — R2's corruption-detection consequence is disclosed but not escalated as common.md requires

**Location:** `note.md` §0 (R2 write-up) and §5 (release statement);
`src/query-engine/raptor3/shared/query.ts` `decodeScalar` (~line 4396).

**Description:** R2 correctly makes `JsonNull` storable in a NOT NULL json
column (required by `json-null-sentinel-behavior.ts:225`, which was
previously red). Its side effect: a provider that returns a genuine SQL
NULL for a NOT NULL json column — e.g. real row corruption from something
outside VibORM, not a legitimate `JsonNull` write — now silently decodes as
the JSON null document instead of throwing `InvalidScalarResult`. I
confirmed:

- No test in the estate pins this refusal specifically for `json` (only
  `int` is pinned, at `tests/contracts/engine/write/parent-held-lookup.test.ts:209`,
  and that test is untouched by this diff — verified).
- This refusal is not one of the project's registered/frozen refusals
  (`docs/architecture/raptor3-evidence/g3-prep-inventory.md` §G, RF-01
  through RF-16), so R2 does not violate a frozen contract.
- It is nonetheless a new observable compatibility choice. `common.md`'s
  rule is explicit: *"A new observable compatibility choice is a decision
  for Arnaud: record it as a blocker in your note, do not copy or 'fix'
  legacy behavior."* The note states the consequence as fact under R2's
  decision-elimination write-up (correct, required disclosure) but never
  escalates it as an open decision or blocker anywhere — not in §0's
  framing, not in §5's PostgreSQL/MySQL release statements, which describe
  R2 only as a completed repair.

**Resolution (minimal, either one closes it):**
(a) Add one sentence to §5's release statement flagging this explicitly as
an open decision for Arnaud ("a SQL NULL in a NOT NULL json column is no
longer distinguishable from a legitimate `JsonNull` write; accept, or
require a distinguishing signal"), or
(b) add one registered pin test — a malformed-row probe on a NOT NULL json
column, the `json` analogue of `parent-held-lookup.test.ts`'s `int` probe —
that asserts the accepted new decode (`null`, not a throw), so the tradeoff
becomes a documented contract instead of a silent side effect.

This does not block ACCEPT: the repair itself is correct and required by an
already-registered contract (the JsonNull sentinel behavior), and the
under-escalation is a process/documentation gap, not a functional defect.

### LOW — `receipts/old/` is empty; note.md's citation for it is inaccurate

**Location:** `note.md` §2 ("Receipts: `receipts/old/`, `receipts/fresh/`
...").

**Description:** `receipts/old/` exists but contains no files. The actual
"after fix" old-container data lives directly under `receipts/`
(`after-old-pg-red.txt`, `after-old-pg.log`, `after-old-mysql-red.txt`,
`after-old-mysql2.log`), not under `receipts/old/`. The "before any fix"
old-container counts in §2's table (25 pg / 165 mysql) trace to the
pre-existing `docs/architecture/raptor3-evidence/g4/rulings/verification/rulings-{pg,mysql}-red.txt`
snapshots (verified: 25 and 165 lines respectively, matching `brief.md`'s
own table), not to a fresh capture inside this unit's `receipts/`. The
numbers are correct and traceable — I verified them — but the note points
the reader to the wrong path for them.

**Resolution:** either populate `receipts/old/` with the two "before"
snapshots it currently lacks (copies of the `rulings-*-red.txt` files used),
or correct §2's citation to name where the numbers actually come from.

**Environmental note, not attributable to the unit:** the OLD containers
(`viborm-raptor3-g3-{pg,mysql}-20260914`) are currently reachable on
different host ports (53878/53879) than the ones recorded in
`receipts/environment.txt` (55729/55730) — evidently restarted by the host
since the unit's 2026-09-18 session, unrelated to any action the unit took
(rule: never restart/alter the old containers — nothing in the diff or
receipts suggests the unit did). As a result I could not independently
re-verify the old-container numbers myself; my required reproductions (R1,
R2 falsifiers, and the full provider-pg run) all target the FRESH
containers per the brief, which were unaffected and fully reproducible.

### LOW — MySQL concurrency family (class d) cites a prior unit's 3× measurement rather than a fresh one

**Location:** `note.md` §3.2, "TransactionError: Transaction deadlock
detected" row.

**Description:** The brief asks class (d) cells be "measured 3× and say
so." The note cites `docs/architecture/raptor3-evidence/g4/parity/repair-note.md`'s
R8 ("3/3 on the pristine base") rather than a fresh 3× run inside this
unit's own session. I traced R8 and confirmed it is a real, receipted 3×
isolated-run measurement of the identical four cells (concurrent plain
upserts, concurrent fallback upserts, concurrent upsert of a missing key,
concurrent nested connectOrCreate), with base/merged comparison tables and
receipt paths — a legitimate citation, not a fabricated one. Reasonable
given the author's session ended on the usage limit, but it is a citation
of prior work, not a fresh measurement in this unit as the brief's letter
asks.

**Resolution:** none required to accept; note it as citing R8 explicitly if
re-touched, so a future reader does not assume it was freshly measured here.

---

## Reproductions (this review's own work)

All receipts under `docs/architecture/raptor3-evidence/g4/release/triage/review-receipts/`.

### R1 falsifier — enum-against-a-column cast (`pg field references > enum references`, 4 cells)

Reverted only the R1 hunk (`r1-hunks.diff`, both call sites: the new
`spelledAsText`/`comparableColumn` helpers and the `equals` case's
`comparableColumn(single)` call) in the scratch worktree, kept R2 applied,
ran against the PostGIS container (`PG_TEST_CONNECTION_STRING=postgresql://postgres@127.0.0.1:55732/raptor3_g2`):

- **Without the hunk:** all 4 cells RED, each with
  `Serialized Error: { code: '42883' }` (PostgreSQL: operator does not
  exist) — exactly the note's predicted falsifier.
  Receipt: `review-receipts/r1-falsifier/pg-red-without-hunk.log`.
- **With the hunk restored:** all 4 cells GREEN.
  Receipt: `review-receipts/r1-falsifier/pg-green-with-hunk.log`.

Code-level check: the "one fact, one authority" claim holds — `spelledAsText`
is the single predicate ("is this operand a same-model column reference on
an enum comparison"), read by both `comparableColumn` (filtered-column side)
and the pre-existing `bind()` (operand side). `PreparedOperand.kind` is an
exhaustive two-variant union (`"value" | "field"`), so `member.kind ===
"field"` cannot miss an operand shape. Confirmed via
`field-reference-behavior.ts` that ordered comparison on an enum is refused
at admission on every dialect (test.each over `lt/lte/gt/gte`), so
equals/not is genuinely the fact's whole reach, as the note claims. No new
adapter capability was added — `a.expressions.cast` was already used one
line below in the pre-existing `bind()` before this diff.

### R2 falsifier — `JsonNull` in a NOT NULL json column (pg and mysql2 twins)

Reverted only the R2 hunk (`r2-hunk.diff`, the `decodeScalar` null-arm),
kept R1 applied, ran the `writes > JsonNull is storable in a NOT NULL json
column` cell on both providers:

- **pg (55732), without the hunk:** RED —
  `QueryEngineError: Driver "pg" returned a malformed json scalar for
  operation "create": a required scalar is null.` — exactly the note's
  predicted falsifier message.
  Receipt: `review-receipts/r2-falsifier/pg-red-without-hunk.log`.
- **mysql2 (`MYSQL_TEST_CONNECTION_STRING=mysql://root@127.0.0.1:55731/raptor3_g2`),
  without the hunk:** RED with the identical message for driver `"mysql2"`.
  Receipt: `review-receipts/r2-falsifier/mysql-red-without-hunk.log`.
- **With the hunk restored:** both GREEN.
  Receipts: `review-receipts/r2-falsifier/{pg,mysql}-green-with-hunk.log`.

Code-level check: the null-check in `decodeScalar` runs before the
`carried` branch, so the fix also correctly covers a required json column
read through a JSON-carried (aggregated/included) row, not only a direct
column read — this generalizes correctly and is not an oversight; the same
"a NOT NULL json column cannot hold SQL NULL" invariant holds regardless of
transport.

### Test-file diffs (task 3)

**`tests/providers/docker/mysql2.test.ts`** ("MySQL namespace containment"
> "applies into the TARGET's control tables, over a connection pointing
elsewhere"): the diff changes only the DECOY control-log table's column
types (`event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT
NULL` → `VARCHAR(64) PRIMARY KEY`, `VARCHAR(64) NOT NULL`, `VARCHAR(32) NOT
NULL`), matching how `control.ts` itself spells these columns on MySQL.
Verified: MySQL refuses a bare `TEXT` primary key with no key length
(errno 1170, SQLSTATE 42000) on every version, so this decoy `CREATE TABLE`
— which runs OUTSIDE the test's `try`/`finally` — was aborting and leaking
`_viborm_migration_state` into `BETA_DB`, corrupting every later assertion
in the file that reads `tableNamesIn(BETA_DB)`. The assertions after `try`
(`tableNamesIn`, `controlEventCount`, and the rest of the "MySQL namespace
containment" family) are **byte-identical** before and after this diff —
nothing weakened, nothing deleted, no `.skip`. Confirmed the family has
exactly 4 cells (grep against `after-old-mysql-red.txt`), matching the
note's table row exactly.

**`tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts`**:
removes a hardcoded `namespace: "viborm"` override so `MySQL2Driver` uses
the connection string's own database, as every sibling suite does —
verified against `tests/unit/migrations/mysql-strict-mode-docker.test.ts`
and `tests/providers/docker/mysql2.test.ts`'s own `databaseUrl`-only
constructions (namespace override is used elsewhere only when a `pool` is
supplied, a genuinely different, opaque-connection scenario). Legitimate
portability fix; the test's own expectations are untouched.

**Verdict on both: legitimate, non-weakening fixes.** Neither test's pinned
assertions changed; both only correct setup bugs that prevented the tests
from running meaningfully against the fresh/different container.

### Family-table spot checks (task 4) — exceeded the requested three rows

- **pg `enum references` (4)** — falsified directly, above.
- **pg `json null sentinel ... writes` (1)** — falsified directly, above.
- **pg `batch-only batch primary-key dataflow` (5, class c)** — cross-checked
  against `g4.md` ("`batchPrimaryKeyDataflowContract` registration stays
  registered and red as a recorded engine limitation") and confirmed live in
  my own full provider-pg run (below): exactly these 5 cells red, all with
  `Raptor 3 G1 atomic output requires exact identity scratch or segmented
  RETURNING`, nothing else.
- **pg GeoPoint family (15, class b, environmental)** — counted exactly
  10 (behavior) + 1 (migration lifecycle) + 4 (spatial-index planning) = 15
  lines in `receipts/after-old-pg-red.txt`; matches the table exactly.
- **MySQL family sum** — 150 (fingerprint) + 4 (deadlock) + 4 (namespace
  containment) + 3 (decimal-conversion/defaults) + 1 (json null, repaired)
  + 1 + 1 + 1 (three unmeasured candidates) = **165**, exactly the initial
  red count with no unaccounted cells.
- **MySQL namespace containment (4)** — counted exactly 4 matching test
  names in `after-old-mysql-red.txt`, matches the table.
- **Container-state diff:** `diff fresh/mysql-red.txt
  after-fresh-mysql-red.txt` is exactly the one R2 `JsonNull` line removed,
  nothing else moved. `after-fresh-mysql-red.txt` and
  `after-old-mysql-red.txt` are byte-identical (0 diff) — strong evidence
  the MySQL red set truly is not container state, and the repairs are
  surgical with no collateral regressions.

### Task 5 — full `provider-pg` project against the PostGIS container, on the author's own tree

`node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts
--project=provider-pg --rss-limit-mb=1536 --heap-limit-mb=768
--wall-limit-ms=1200000` with `PG_TEST_CONNECTION_STRING=postgresql://postgres@127.0.0.1:55732/raptor3_g2`,
run directly in `/private/tmp/viborm-triage` (the author's tree, unedited by
this review). The default 300s wall limit was insufficient for the whole
4-file project (`pg.test.ts`, `pg-nested-write-races.test.ts`,
`pg-polymorphism-ddl.test.ts`, `pg-read-surface.test.ts`); re-ran with
`--wall-limit-ms=1200000`.

**Result: Test Files 1 failed | 3 passed (4). Tests 5 failed | 446 passed |
7 skipped (458).** The 5 failures are exactly:

- `pg batch-only batch primary-key dataflow > generated child ID feeds to-one parent FK`
- `... > generated parent ID feeds multiple sibling relation branches`
- `... > generated parent ID feeds nested createMany child FKs`
- `... > generated parent ID feeds to-many child FK`
- `... > generated parent, child, and grandchild IDs flow through recursive create`

— all in `pg-nested-write-races.test.ts`, all with `Error: Raptor 3 G1
atomic output requires exact identity scratch or segmented RETURNING`. This
is **exactly** the five registered `pg batch-only batch primary-key
dataflow` cells the brief asked me to confirm, and nothing else. Receipt:
`review-receipts/full-provider-pg-fresh-run.log`.

### Task 6 — whole-estate typecheck

`node scripts/run-typecheck.mjs` on the author's tree (fixes applied):
exit code 0, no diagnostics printed (the script exits with `tsc`'s own exit
code; a clean run prints only the bounded-process resource line). Receipt:
`review-receipts/typecheck.log`.

---

## Unverified

- The pre-fix "old container" red counts and the "after fix" 20-red-on-old-pg
  / 164-red-on-old-mysql figures in `note.md` §2/§3 were **not independently
  re-run by this review** — the old containers are not reachable at the
  ports the brief and `environment.txt` name (see the LOW finding above).
  I instead cross-checked them arithmetically and via `diff` against the
  receipts already on disk (all of which are internally consistent and
  correctly summed), which is why I still credit them, but I did not
  personally reproduce a live run against an old container.
- The MySQL fingerprint family's exact count of 150 (out of 165) was not
  independently re-verified cell-by-cell by this review (would require a
  full `provider-mysql2` run, out of this review's required scope, which
  asked only for the pg lane's full run). I did verify the total (165) and
  the other seven MySQL family row counts sum correctly against it, so 150
  is the only unverified-by-subtraction figure, and it is consistent.
- The three "unmeasured candidate" MySQL cells (descending orderBy on a
  to-many include, DateTime membership in list/json filter, createMany
  select-fold row count) are honestly labeled as unmeasured by the note and
  were not reproduced by this review either — correctly out of scope for a
  triage-classification unit under a usage-limit-truncated session.
