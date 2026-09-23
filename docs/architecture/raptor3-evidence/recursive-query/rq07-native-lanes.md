# RQ-07 — the native PostgreSQL and MySQL lanes (source-bound, 2026-09-23, after the local commit `dc662e184`)

**Status: executed and green on both providers — PostgreSQL 16.14 12 / 12,
MySQL 8.4.11 12 / 12, the RQ-06 campaign 300 / 300 on each.** The lanes found
one production defect (MySQL) and two defects of the native test's own runner;
all three are repaired at their owners below, and every lane that the repairs
touch was re-executed on the repaired tree.
The receipts' `src.sha256 295b6743…` is the final `src/` with
`src/query-engine/raptor3/AGENTS.md` at its pre-edit bytes (a doc edit made
after the runs); the PostgreSQL lane ran before the MySQL-only F3 hunk was
saved.

## How the lanes came to run

The Docker engine had been down for the whole program. Arnaud authorized its
restart ("go ahead restart"): the orphaned `com.docker.backend` processes were
terminated, Docker Desktop relaunched, engine 29.2.1 answered within seconds.
Containers, mapped from the plain-URL connection files by port (the URLs are
never printed):

| connection file | container | server | `raptor3_g2` present |
| --- | --- | --- | --- |
| `/private/tmp/viborm-fc-env/pg-g3` | `viborm-r13-pg-g3` | PostgreSQL 16.14 | yes |
| `/private/tmp/viborm-fc-env/mysql-g3` | **none** — its port no longer belongs to any container | — | — |
| `/private/tmp/viborm-m1-env/mysql` | `viborm-triage-mysql-20260918` | MySQL 8.4.11 | yes |

The MySQL lane therefore ran from the `viborm-m1-env/mysql` file (same
database name, user and empty password the harness hard-codes). Command per
provider, one vitest at a time, pinned Node, receipts into this directory:

```
VIBORM_RAPTOR3_PROVIDER=<pg|mysql> VIBORM_RAPTOR3_PROVIDER_PORT=<port> \
VIBORM_RQ06_RECEIPT_DIR=docs/architecture/raptor3-evidence/recursive-query \
node scripts/run-vitest-safe.mjs --heap-limit-mb=768 --rss-limit-mb=1536 --wall-limit-ms=120000 \
  run --workspace vitest.workspace.ts --project raptor3-live-provider \
  tests/raptor3/recursive-query/provider-sql-native.test.ts \
  tests/raptor3/recursive-query/campaign-native.test.ts \
  tests/raptor3/g4/native/read-envelope-native.test.ts
```

Logs: `gate/native-pg.log`, `gate/native-mysql.log` (the final runs),
`gate/native-lanes.log` (the post-repair invocation of 07:07:37Z and the MySQL
re-run of 07:09:42Z; the committed-tree runs' logs and failing MySQL receipt
were overwritten and their counts survive only in the exit-code rows and this
ledger), `gate/exit-codes.txt` (rows appended in order: `not-run`, then the
first run's `1`s, then the post-repair invocation's `native-pg 0` and
`native-mysql 1` (F3), then the MySQL re-run's `native-mysql 0`).

## First execution on the committed tree: what failed

| lane | result | failing cells |
| --- | --- | --- |
| native pg | 11 / 12 | `RQ-04 junction graphs through the same mechanism` |
| native mysql | 6 / 12 | the three `campaign-native` profiles (15 + 22 + 25 of 100 seeds), all three `provider-sql-native` cells |

### F1 — the native runner reported a value after the case's check had mutated it (test-only, PostgreSQL)

`provider-sql-native.test.ts` has its own case runner (`observed`) because a
MySQL case may owe the provider's limit instead of a value. It ran
`providerCase.check` **before** reporting the value. The diamond case's check
(`assertFreshDiamond`) proves that the same stored row on two paths is two
public objects by writing `changed: true` into one leaf and asserting the other
leaf does not see it — so the reported value carried `changed: true`, and the
world-level `deepEqual` against the expected value failed on the first provider
whose run reached that case natively. The shared `runCase` (SQLite, PGlite)
compares first and checks afterwards for exactly this reason.

Repair (`provider-sql-native.test.ts`): the reported value is the summary or a
`structuredClone` taken **before** the check; the check still runs on the live
value. No assertion weakened; the world's expectations are unchanged.

### F2 — MySQL materializes a correlated recursive CTE that is read twice once for the whole statement (production)

The failing MySQL cases ended in the decoder's carrier refusals: `Invalid
provider recursive edge endpoint` (57: an edge whose parent is neither the
root nor a transported node) or `Invalid provider recursive depth` (5 junction
seeds). A scratch dump of the raw carrier rows for the placement
matrix showed the cause: for the two-root case the second row's carrier carried
`__rq_root: ["t","root-b"]` but **root-a's** nodes and edges. MySQL 8.4.11
evaluates the carrier's scalar subquery per outer row (the root identity is
right) but materializes the correlated recursive CTE — which both the nodes
reader and the edges reader consume — once, and hands every later outer row
the first row's facts. Cases with a single outer row (most seeds; every RQ-06
case with one root) pass; every multi-root placement fails.

Shapes tried on the server (scratch schema, dropped afterwards; the exact SQL
is in this ledger's appendix):

| shape | MySQL 8.4.11 |
| --- | --- |
| E1 correlated CTE inside the scalar subquery, read twice (the committed shape) | **wrong** — second root gets the first root's facts |
| E2 the same CTE read once | right |
| E3 the CTE inside a `LATERAL` derived table, read twice | right |
| E4 E1 with both readers filtered by `__rq_root` | wrong — second root gets nothing |
| E5 an uncorrelated CTE seeded from the outer predicate, readers filtered by root | right (needs the outer predicate: not available to a nested placement) |
| E6 one pass over the CTE with both aggregates | right (but a node then repeats per incoming edge: a carrier-contract change) |
| E7 the carrier's own scalar subquery selecting `FROM (SELECT 1) JOIN LATERAL (WITH RECURSIVE … SELECT nodes, edges)` | right |
| E7b E7 nested inside a relation window's scalar subquery | right |
| E9 E7 with the engine's exact anchor (depth column, `UNION`, ROW_NUMBER distinct, ordered edge page with the unbounded LIMIT) | right |

Repair (`Queries.lowerRecursiveRelationProjection`, its tail — the one owner of
the carrier's placement): where the adapter spells `LATERAL`
(`capabilities.supportsLateralJoins`: PostgreSQL, MySQL) the carrier is
`(SELECT JSON_OBJECT(root, facts.nodes, facts.edges) FROM (SELECT 1) AS one
JOIN LATERAL (WITH RECURSIVE … SELECT (nodes) AS __<scope>_nodes, (edges) AS
__<scope>_edges) AS facts ON TRUE)`; a lateral derived table is re-evaluated
per outer row by definition on both providers. SQLite has no `LATERAL` and
evaluates the correlated CTE per row as before, so its shape is unchanged. The
CTE, both readers, the ordering, the carrier keys and the decoder are untouched;
the statement count per case is still one (asserted by every provider file).
The repaired MySQL statement for the two-root matrix case (namespace elided):

```sql
SELECT `q0`.`label` AS `label`, (SELECT JSON_OBJECT(?, JSON_ARRAY(`q0`.`tenant_key`, `q0`.`node_code`), ?, `q12`.`__q1_nodes`, ?, `q12`.`__q1_edges`) FROM (SELECT 1) AS `q11` JOIN LATERAL (WITH RECURSIVE `__q1_recursive` AS (
        SELECT `q0`.`tenant_key` AS `__q1_root_0`, `q0`.`node_code` AS `__q1_root_1`, `q0`.`tenant_key` AS `__q1_parent_0`, `q0`.`node_code` AS `__q1_parent_1`, `q2`.`tenant_key` AS `__q1_child_0`, `q2`.`node_code` AS `__q1_child_1`, CAST(? AS SIGNED) AS `__q1_depth` FROM `<ns>`.`rq_provider_nodes` AS `q2` WHERE ((`q0`.`tenant_key` = `q2`.`parent_tenant` AND `q0`.`node_code` = `q2`.`parent_code`) AND `q2`.`visible` = ?)
        UNION
        SELECT `q3`.`__q1_root_0` AS `__q1_root_0`, `q3`.`__q1_root_1` AS `__q1_root_1`, `q3`.`__q1_child_0` AS `__q1_parent_0`, `q3`.`__q1_child_1` AS `__q1_parent_1`, `q5`.`tenant_key` AS `__q1_child_0`, `q5`.`node_code` AS `__q1_child_1`, (`q3`.`__q1_depth` + ?) AS `__q1_depth` FROM `__q1_recursive` AS `q3` INNER JOIN `<ns>`.`rq_provider_nodes` AS `q4` ON (`q4`.`tenant_key` = `q3`.`__q1_child_0` AND `q4`.`node_code` = `q3`.`__q1_child_1`) INNER JOIN `<ns>`.`rq_provider_nodes` AS `q5` ON (`q4`.`tenant_key` = `q5`.`parent_tenant` AND `q4`.`node_code` = `q5`.`parent_code`) WHERE (`q3`.`__q1_depth` < ? AND `q5`.`visible` = ?)
      ) SELECT (SELECT COALESCE(COALESCE(JSON_ARRAYAGG(JSON_OBJECT(?, JSON_ARRAY(`q7`.`tenant_key`, `q7`.`node_code`), ?, JSON_OBJECT(?, `q7`.`label`, ?, `q7`.`rank`))), JSON_ARRAY()), JSON_ARRAY()) FROM (SELECT `__q1_id_0`, `__q1_id_1` FROM (SELECT `q3`.`__q1_child_0` AS `__q1_id_0`, `q3`.`__q1_child_1` AS `__q1_id_1`, ROW_NUMBER() OVER (PARTITION BY `q3`.`__q1_child_0`, `q3`.`__q1_child_1` ORDER BY `q3`.`__q1_child_0`, `q3`.`__q1_child_1`) AS `_rn` FROM `__q1_recursive` AS `q3`) AS `_distinct_subquery` WHERE `_rn` = 1) AS `q6` INNER JOIN `<ns>`.`rq_provider_nodes` AS `q7` ON (`q7`.`tenant_key` = `q6`.`__q1_id_0` AND `q7`.`node_code` = `q6`.`__q1_id_1`)) AS `__q1_nodes`, (SELECT COALESCE(COALESCE(JSON_ARRAYAGG(`q10`.`__q1_edge`), JSON_ARRAY()), JSON_ARRAY()) FROM (SELECT JSON_OBJECT(?, JSON_ARRAY(`q8`.`__q1_parent_0`, `q8`.`__q1_parent_1`), ?, JSON_ARRAY(`q8`.`__q1_child_0`, `q8`.`__q1_child_1`), ?, `q8`.`__q1_depth`) AS `__q1_edge` FROM `__q1_recursive` AS `q8` INNER JOIN `<ns>`.`rq_provider_nodes` AS `q9` ON (`q9`.`tenant_key` = `q8`.`__q1_child_0` AND `q9`.`node_code` = `q8`.`__q1_child_1`) ORDER BY `q8`.`__q1_parent_0` ASC, `q8`.`__q1_parent_1` ASC, `q9`.`rank` ASC, `q9`.`tenant_key` ASC, `q9`.`node_code` ASC LIMIT 18446744073709551615) AS `q10`) AS `__q1_edges`) AS `q12` ON TRUE) AS `children` FROM `<ns>`.`rq_provider_nodes` AS `q0` WHERE ((`q0`.`node_code` = ? AND BINARY `q0`.`node_code` = ?) OR (`q0`.`node_code` = ? AND BINARY `q0`.`node_code` = ?)) ORDER BY `q0`.`node_code` ASC
rows[1].children.__rq_root: ["t","root-b"] edges: 1 nodes: 1
```

After the repair the raw rows carry `["t","root-b"]` with root-b's one edge
and one node.

### F3 — the recursion-limit case looked for the provider's message; the driver redacts it (test-only, MySQL)

Two RQ-03 spine cases (`exhaustive downward/upward to the natural end`, a
chain longer than MySQL's default `cte_max_recursion_depth` of 1000) owe the
provider's own failure on MySQL (`exceedsMySQLRecursionLimit`). The native
runner recognized it by the message text (`Recursive query aborted after …`),
but the driver's diagnostics redact a provider message **by design**
(`Underlying error details redacted`) and keep the provider's error number as
`meta.providerErrno`. The cell surfaced the raw `QueryError` (errno 3636,
sqlState HY000).

Repair (`provider-sql-native.test.ts`): the identity is `providerErrno ===
3636` (`ER_CTE_MAX_RECURSION_DEPTH`) on the failure's cause chain; the message
regex is gone. This is the first native observation of what the public docs
and the CHANGELOG had only expected: the limit surfaces as the provider's
error, never as a truncated result.

## Re-execution on the repaired tree

| lane | result |
| --- | --- |
| native PostgreSQL (`provider-sql-native` 3, `campaign-native` 4, `read-envelope-native` 5) | **12 / 12**; campaign **300 / 300** (`rq6-campaign-pg.json`: 300 statements, 300 matched) |
| native MySQL (same files) | **12 / 12**; campaign **300 / 300** (`rq6-campaign-mysql.json`); the two spine cases answered by errno 3636 |
| PGlite `provider-sql-pglite` (new statement shape on PostgreSQL) | **14 / 14** (`gate/rq-pglite-rerun.log`) |
| SQLite `provider-sql-sqlite` + `composition` + `campaign-sqlite` + `carrier-boundary` (unchanged shape, changed function) | **46 / 46** (`gate/rq-sqlite-facing-rerun.log`) |
| modes `g3p05-recursive-read-fit`, `g4-read-recursive-fit` | exit 0 / exit 0 (`gate/g3p05-recursive-read-fit-rerun.log`, `gate/g4-read-recursive-fit-rerun.log`) |

The whole-estate typecheck, the census, the manifest self-tests and the
recount on the repaired tree are recorded in `rq07-release-verdict.md`.

## What this changes in the ledgers

- `rq01-sql-placement.md`: the native rows of the placement matrix are now
  executed on both providers; its "Owed" section keeps only the whole-unit
  independent review.
- `rq6.md`: the 600 native executions ran (300 + 300, all matched).
- `rq34-chains-hierarchies-graphs.md`: RQ-03's MySQL limit cases observed.
- Public claims (`CHANGELOG.md`, `README.md`, `docs/content/docs/client/selecting.mdx`,
  `features-docs/recursive-query.md`, the central plan): the feature is
  executed on all four local providers; the MySQL limit is observed.

## Appendix — the server experiments

E1–E6 (`mysql-cte-experiment-2.sql`):

```sql
CREATE DATABASE zz_cte_scratch; USE zz_cte_scratch; CREATE TABLE zz_t(k VARCHAR(10) PRIMARY KEY, p VARCHAR(10));
INSERT INTO zz_t VALUES ('a',NULL),('a1','a'),('a2','a'),('a1x','a1'),('b',NULL),('b1','b');
SELECT 'E1 correlated CTE in scalar subquery, referenced twice (current shape)' AS experiment;
SELECT q0.k, (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_OBJECT('n', (SELECT JSON_ARRAYAGG(child) FROM w), 'e', (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w))) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
SELECT 'E2 correlated CTE, referenced once' AS experiment;
SELECT q0.k, (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
SELECT 'E3 LATERAL derived table holding the CTE, referenced twice' AS experiment;
SELECT q0.k, lat.c FROM zz_t q0 JOIN LATERAL (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_OBJECT('n', (SELECT JSON_ARRAYAGG(child) FROM w), 'e', (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w)) AS c) AS lat ON TRUE WHERE q0.p IS NULL ORDER BY q0.k;
SELECT 'E4 correlated CTE referenced twice, consumers filtered by root' AS experiment;
SELECT q0.k, (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_OBJECT('n', (SELECT JSON_ARRAYAGG(child) FROM w WHERE w.root = q0.k), 'e', (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w WHERE w.root = q0.k))) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
SELECT 'E5 uncorrelated CTE seeded from every root of the outer predicate, consumers filtered by root' AS experiment;
SELECT q0.k, (WITH RECURSIVE w AS (SELECT r.k AS root, r.k AS parent, c.k AS child FROM zz_t r JOIN zz_t c ON c.p = r.k WHERE r.p IS NULL UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_OBJECT('n', (SELECT JSON_ARRAYAGG(child) FROM w WHERE w.root = q0.k), 'e', (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w WHERE w.root = q0.k))) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
SELECT 'E6 correlated CTE referenced once through a derived table, both aggregates in one pass' AS experiment;
SELECT q0.k, (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_OBJECT('n', JSON_ARRAYAGG(child), 'e', JSON_ARRAYAGG(JSON_ARRAY(parent, child))) FROM w) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
SELECT VERSION() AS v;
DROP DATABASE zz_cte_scratch;

```

E7, E7b, E7c (control), E9 (`mysql-cte-experiment-3.sql`):

```sql
CREATE DATABASE zz_cte_scratch; USE zz_cte_scratch;
CREATE TABLE zz_t(k VARCHAR(10) PRIMARY KEY, p VARCHAR(10));
INSERT INTO zz_t VALUES ('a',NULL),('a1','a'),('a2','a'),('a1x','a1'),('b',NULL),('b1','b');
CREATE TABLE zz_owner(id INT PRIMARY KEY, root VARCHAR(10));
INSERT INTO zz_owner VALUES (1,'a'),(2,'b');
SELECT 'E7 scalar subquery whose FROM is a LATERAL holding the CTE referenced twice' AS experiment;
SELECT q0.k, (SELECT JSON_OBJECT('root', q0.k, 'n', lat.n, 'e', lat.e) FROM (SELECT 1) AS one JOIN LATERAL (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT (SELECT JSON_ARRAYAGG(child) FROM w) AS n, (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w) AS e) AS lat ON TRUE) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
SELECT 'E7b the same carrier nested inside a relation-window scalar subquery (owner -> node -> recursion)' AS experiment;
SELECT o.id, (SELECT JSON_ARRAYAGG(JSON_OBJECT('k', q0.k, 'c', (SELECT JSON_OBJECT('root', q0.k, 'n', lat.n, 'e', lat.e) FROM (SELECT 1) AS one JOIN LATERAL (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT (SELECT JSON_ARRAYAGG(child) FROM w) AS n, (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w) AS e) AS lat ON TRUE))) FROM zz_t q0 WHERE q0.k = o.root) AS nodes FROM zz_owner o ORDER BY o.id;
SELECT 'E7c control: the current shape nested the same way (expected wrong)' AS experiment;
SELECT o.id, (SELECT JSON_ARRAYAGG(JSON_OBJECT('k', q0.k, 'c', (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k) SELECT JSON_OBJECT('n', (SELECT JSON_ARRAYAGG(child) FROM w), 'e', (SELECT JSON_ARRAYAGG(JSON_ARRAY(parent, child)) FROM w))))) FROM zz_t q0 WHERE q0.k = o.root) AS nodes FROM zz_owner o ORDER BY o.id;
SELECT 'E8 two roots via UNION-shaped anchor is irrelevant; E9: CTE referenced twice with a depth column and UNION (exact engine anchor shape)' AS experiment;
SELECT q0.k, (SELECT JSON_OBJECT('n', lat.n, 'e', lat.e) FROM (SELECT 1) AS one JOIN LATERAL (WITH RECURSIVE w AS (SELECT q0.k AS root, q0.k AS parent, c.k AS child, CAST(1 AS SIGNED) AS d FROM zz_t c WHERE c.p = q0.k UNION SELECT w.root, w.child, n.k, w.d + 1 FROM w JOIN zz_t cur ON cur.k = w.child JOIN zz_t n ON n.p = cur.k WHERE w.d < 100) SELECT (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('key', JSON_ARRAY(t.k))), JSON_ARRAY()) FROM (SELECT `__id` FROM (SELECT w.child AS `__id`, ROW_NUMBER() OVER (PARTITION BY w.child ORDER BY w.child) AS _rn FROM w) AS d WHERE _rn = 1) AS ids JOIN zz_t t ON t.k = ids.`__id`) AS n, (SELECT COALESCE(JSON_ARRAYAGG(e.edge), JSON_ARRAY()) FROM (SELECT JSON_OBJECT('p', w.parent, 'c', w.child, 'd', w.d) AS edge FROM w JOIN zz_t t ON t.k = w.child ORDER BY w.parent, t.k LIMIT 18446744073709551615) AS e) AS e) AS lat ON TRUE) AS c FROM zz_t q0 WHERE q0.p IS NULL ORDER BY q0.k;
DROP DATABASE zz_cte_scratch;

```

## Repair round (2026-09-23, after the independent review of the native round)

The review returned four minor findings, all about claims and where the
evidence lives. None touches `src/` or a test, and no SQL changed, so no test
cell and no native lane was re-run; the round's one run is the whole-estate
typecheck. Times are UTC; the vitest logs print local time (UTC+2).

| finding | change | file(s) | run |
| --- | --- | --- | --- |
| 1 — read per provider, the CHANGELOG's parenthetical claimed a composition matrix on PGlite, PostgreSQL and MySQL, and 300 PGlite cases | the parenthetical is the review's text: "(the placement matrix and the hierarchy and graph worlds on all four; the composition matrix on SQLite; 300 generated cases each on SQLite, native PostgreSQL and native MySQL)" | `CHANGELOG.md` | none (text). Checked: `composition.test.ts` drives `SQLite3Driver` only; the generated-case receipts are `rq6-campaign-{sqlite,pg,mysql}.json` |
| 2 — the `provider-sql-pglite` re-run had been written over the `pglite-provider` stage's receipt; the SQLite-facing and mode re-runs existed only in the scratchpad, without exit rows | the 07:08:02Z `provider-sql-pglite` re-run moved byte for byte to its own stage, `gate/rq-pglite-rerun.log`; `gate/pglite-provider.log` holds HEAD's bytes again: the frozen gate's `pglite-provider` stage (the three live-PGlite scratch pins, 7 / 7, 02:33:02Z), the committed-tree run. The three relane logs were copied byte for byte to `gate/rq-sqlite-facing-rerun.log` (46 / 46), `gate/g3p05-recursive-read-fit-rerun.log` (6 / 6) and `gate/g4-read-recursive-fit-rerun.log` (3 / 3). Rows `rq-pglite-rerun 0`, `rq-sqlite-facing-rerun 0`, `g3p05-recursive-read-fit-rerun 0` and `g4-read-recursive-fit-rerun 0` were appended to `gate/exit-codes.txt` with the exit codes the relane run recorded. They sit after the re-gate's rows, although these runs (07:08:02–07:08:17Z) came before the re-gate. The re-execution table above and the verdict's rows for the isolated PGlite stage, the live PGlite scratch pins and the SQLite-facing files cite these paths | `gate/rq-pglite-rerun.log`, `gate/pglite-provider.log`, `gate/rq-sqlite-facing-rerun.log`, `gate/g3p05-recursive-read-fit-rerun.log`, `gate/g4-read-recursive-fit-rerun.log`, `gate/exit-codes.txt`, this ledger, `rq07-release-verdict.md` | none. Each log is its run's own bytes (`cmp`-identical to its source); `gate/rq-pglite.log`, the frozen gate's pre-repair run (02:31:29Z), is untouched |
| 3 — `gate/native-lanes.log` does not hold every run, the F3 run's `native-mysql 1` went unmentioned, and 5 of the 62 failing MySQL seeds ended in the depth refusal, not the edge-endpoint one | the Logs paragraph and the opening sentence of F2 carry the review's text verbatim | this ledger | none (text). The 57 + 5 split is the review's replay; it was not re-measured here The gloss on the edge-endpoint refusal, which this round left after the depth refusal, was moved back beside it after the re-review; the exit-code order was restated as `native-pg 0`, `native-mysql 1` (F3), `native-mysql 0`. |
| 4 — the receipts' `src.sha256 295b6743…` is not the final tree's digest | option (b): the sentence after the status paragraph; the amended tree's `src-digest`, by the gate's measure, recorded in the verdict's Source identity | this ledger, `rq07-release-verdict.md` | digests recomputed on the final tree. The campaign harness's `sourceTreeDigest` measure gives `d434c217322c88a978b646c28f41e4f7d145c5ef866af250991a913cb8203739` (442 files). With `src/query-engine/raptor3/AGENTS.md` at HEAD's bytes it gives `295b67436baba1d71d0c3974d0aafc1b3ce3c4d369f5a6d4488a3bac443dd59e`, the receipts' value. The gate's measure (`git ls-files -z src \| xargs -0 shasum -a 256 \| shasum -a 256`) gives `635a16687f88f4cd182afbaa4c70d1f3ab2432a40b6a2945cf64f174f9e60a78` |

Typecheck, once, at the end of the round (pinned Node 24.21.0, 07:54:08Z):
exit 0 with 0 diagnostics. Receipt `gate/typecheck-repair-round.log`, exit row
`typecheck-repair-round 0`.
