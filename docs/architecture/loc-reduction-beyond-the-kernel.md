# LOC reduction beyond the write kernel

**Date:** 2026-09-02

**Status:** Diagnosis. No production code changed.

**Question:** freed from the Raptor 3 scope, where else does the same lens (copy axes,
decision-free re-dispatch, restated invariants, temporal state, shadow interpreters,
parallel representations) find deletable lines, and how much?

**Method:** whole-`src` census by directory (544 files, 160,419 physical / 118,356
token-bearing lines; 20k comment/blank; 18.5k type-only erased), a repo-wide clone scan
(identifier-normalized 5-token shingles, Jaccard ≥ 0.85 strict / 0.7 / 0.55 loose;
switch-vocabulary clustering), five per-area audits (migrations, validation + schema,
drivers + adapters, read-side query engine, client + extensions + cache + errors +
instrumentation), and hand verification of every claim that moves the ranking. The
companion document for the write kernel is
[raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md).

---

## 1. Answer

Outside the write kernel the lens finds about **5,200 net lines with high-to-medium
confidence and about 6,400 including policy-gated items**, spread over five areas.
With the kernel's 3,000 (base) to 4,800 (stretch), the repo-wide honest total is
**≈ 8,200 base / ≈ 11,200 stretch of 160k physical lines (5–7%)**. Comments are not
counted; erased types are counted only where they are dead.

| area | physical | net base | net stretch | share | dominant pattern |
|---|---:|---:|---:|---:|---|
| write engine (Raptor 3) | 34,075 | 3,000 | 4,800 | 9–14% | parent state as a copy axis of the verb table |
| migrations | 28,604 | 1,600 | 1,850 | 6% | per-command copies of one edge-execution engine; DDL rendered on a double axis |
| validation + schema scalars | ≈ 10,700 | 1,050 | 1,600 | 10–15% | per-scalar-type copies of one filter/update schema and one modifier set |
| read-side query engine | ≈ 26,000 | 1,150 | 1,300 | 5% | per (storage × strategy) copies of one correlated aggregation; request walked twice |
| client · extensions · cache · errors · instrumentation | ≈ 17,900 | 950 | 1,200 | 5–7% | dead internal-barrel code kept alive by tests; operation-name list re-spelled |
| drivers + adapters | 16,700 | 420 | 450 | 2.5% | small twins; the per-provider axis is already inherited, not copied |
| **total** | 160,419 | **≈ 8,200** | **≈ 11,200** | 5–7% | |

Bytes follow the kernel's story: the pg fixture reaches none of `migrations`, and the
scalar and include folds are worth roughly 3–5 KB gzip combined. This is a LOC and
concept-count program, not a bundle program.

### 1.1 The same root cause, four shapes

The kernel's finding — a copy axis where an input was needed — recurs, and the axis is
different each time:

1. **Per scalar type** (validation + schema): nine `validation/scalars/*.ts` files are
   one file (`int.ts` ≡ `number.ts` modulo names, 8 formatting diffs; `date.ts` ≡
   `time.ts`, 0 diffs; whole-file Jaccard 0.97–0.99); fourteen `schema/scalars/*/scalar.ts`
   classes re-spell `nullable/array/default/schema/map/id/unique` (≈1,125 of 1,807 lines).
   The cleanest axis in the repo and the one with the highest confidence.
2. **Per parent state** (write engine): documented in the Raptor 3 plan.
3. **Per command** (migrations): apply, down, resolve and reset each re-implement
   "prepare edges → group by commit model → execute with ledger evidence → resume from
   confirmed prefix → prove destination" (216 + 244 + 84 + 407 lines), plus a hand-spelled
   command prologue in nine commands (12 `readControlState`, 18 `refusePartialControl`
   calls) and eleven hand-written 18-key ledger-event literals.
4. **Per storage × strategy** (read side): the correlated to-one/to-many aggregation is
   spelled eight times across `include-builder`, `include-many-to-many` and
   `polymorphic-collection-read-builder` on a {row-held, junction, polymorphic member} ×
   {subquery, lateral} grid, above a traversal layer that is already unified.

What is **not** a copy axis, measured so nobody re-audits it: the per-provider axis.
Cross-driver body similarity is low (whole-file Jaccard 0.04–0.06 among the eleven
drivers; `transaction` bodies 26% similar on average) because 8,700 of 11,700 driver
lines are already-shared base and helper code; the three SQL adapters and the three
migration DDL drivers are genuinely divergent dialect (Jaccard 0.03) with a shared
`standard-sql` factory layer and `capabilities` table already in place.

---

## 2. Ranked opportunities (repo-wide, excluding the kernel)

Net figures deduct replacement code. Confidence is the audit's, checked where noted.

| # | opportunity | files | gross | net | conf. | gate / preserve |
|---|---|---|---:|---:|---|---|
| 1 | **One descriptor-driven builder for the nine per-scalar operation-schema files**; keep the nine `XSchemas` interfaces; `getScalarSchemas` 14-arm switch → table | `validation/scalars/{string,int,number,bigint,boolean,date,time,datetime,enum}.ts`, `index.ts:88-150` | 1,100 | **700** | high (verified by diff) | interning identity per descriptor (`intern.core.test.ts:46-54`), laziness (`:74-101`), key order; all scalar tests enter through `getScalarSchemas` |
| 2 | **One edge-execution engine and one command prologue** for apply / down / resolve / reset (+ push interlock) | `migrations/apply-v1.ts:176-391`, `operators.ts:818-1061, 1157-1240`, `reset-v1.ts:621-1027`, nine command prologues | 1,100 | **430** | medium | CAS timing per direction (per-edge vs end), origin-check ordering, ledger event content (hash-pinned), `MIGRATION_AMBIGUOUS_COMMIT`; mysql/stepwise ledger tests |
| 3 | **Dead internal-barrel code with zero package callers** (kept alive by unit tests under the 98% gate) | `instrumentation/perf-tracker.ts` (271), `logger.ts:251-316`, `context.ts:182-209`, `cache/key.ts:111-168` legacy grammar, `errors/base.ts:342-347` + 4 guards; `migrations/push/executor.ts`, `resolver.ts` five unused resolvers, `drivers/index.ts:150-159`; `query-engine/types.ts:359-530` dead types | 700 | **≈ 650** | high (public entries verified) | delete their tests with them; `AGENTS.md` public-surface lists already exclude them |
| 4 | **Relation-include family → one `buildRelationColumn(strategy)`** over the existing traversal | `builders/include-builder.ts:80-361`, `include-many-to-many.ts:29-301`, `polymorphic-collection-read-builder.ts:172-243` | 640 | **400** | medium-high | alias spend order, `_json`/`_result` names, integrity guard outside the projection; `read-traversal-byte-pins.core.test.ts` is the gate |
| 5 | **Collapse the DDL double axis** (18 string `generateX` abstracts + 16 `compileX` one-liners + 17 driver join wrappers) and the nine SQLite "load, patch, recreate" wrappers | `migrations/drivers/base.ts:305-527`, `sqlite/index.ts:884-1424` | 535 | **340** | high | every DDL byte incl. the `";\n\n"` oddity at `sqlite/index.ts:1359`; 28 test calls re-pointed to `generateDDL` |
| 6 | **Scalar-class modifiers as one-liners over shared state helpers** | `schema/scalars/*/scalar.ts` | 1,100 | **150–200** policy-free; **550–600** with `base` derived from state | high / low (acceptance) | the full version is what `schema/scalars/AGENTS.md` Rules 3 and 5 forbid — ask first; the argument for asking is the live defect in §4 |
| 7 | **Driver-owned catalog probes** (delete statement-text sniffing), table-lookup type mapping, dead migration exports | `migrations/catalog-probes.ts:171-317`, `drivers/type-mapping.ts:126-287` | 440 | **340** | medium / high | `compileStatements` returns `{sql, probe?}`; exact type spellings pinned |
| 8 | **Errors: twin meta tables → one rule map; `verdictFor` switch → `Record`** (optional fixed-code class factory) | `errors/diagnostics.ts:100-206, 667-722`, `base.ts:390-515`, `constraints.ts`, `cache.ts`, `query.ts` | 465 | **150** / 270 with factory | high / medium | codes, names, `prismaCode`, `toJSON`, fail-closed unknown key; the factory changes the published `.d.ts` shape |
| 9 | **One ledger-event builder; merge the two control-authentication proofs; merge the two `downV1` close branches** | `migrations/apply-v1.ts:543-574`, `operators.ts` ×5, `reset-v1.ts` ×5, `control.ts:158-300` | 330 | **225** | high | event byte identity is hash-pinned, so a wrong builder fails loudly |
| 10 | **One introspection assembler (PG/MySQL), one referential-action table (six copies today), one snapshot canonicaliser shared by differ and fingerprint, one snapshot-operation interpreter (three today)** | `migrations/drivers/*/introspect.ts`, `serializer.ts:61-77`, `base.ts:619-632`, `differ.ts`, `push-fingerprint.ts:137-196`, `sqlite/index.ts:59-146`, `resolver.ts:250-294` | 520 | **260** | medium | `database-namespace-census` allowlist names the introspect files; canonicaliser keeps names |
| 11 | **Hostile-record inspection helper (five copies) + extension failure envelope (nine `isError ? x : new Error` copies)** | `extensions/definition.ts:60-120`, `methods.ts:279-326`, `request.ts:317-407`, `statement.ts:113-140`, `query.ts:650-694`, `client/default-omit-extension.ts:42-122`, `cache/extension.ts:85-166` | 440 | **195** | medium-high | every sentence byte-identical via callback; refusal order per site |
| 12 | **Operation-name restatements** (`OperationPayload` 16-arm conditional, `CachedOperation`, three `schema-introspection` switches, `CACHEABLE_OPERATIONS`, `unique-where-guard` switch) | `client/types.ts`, `schema-introspection.ts`, `cache-flow.ts:29-39`, `unique-where-guard.ts` | 210 | **157** | high | `OrThrow` payload aliasing; renderer strings |
| 13 | **Read-side small twins**: relation-filter wrappers, where/having logical AND/OR/NOT, `ResultParser` decode prologue ×3, aggregate ladders ×2 + expression switch ×3, junction set-match ×3, `buildScalarFilter` twin, symmetric cache codecs | `builders/relation-filter-builder.ts`, `where-builder.ts:218-311`, `operations/groupby-having.ts:72-176`, `result/ResultParser.ts:713-962`, `operations/aggregate.ts`, `groupby.ts`, `many-to-many-utils.ts` | 1,050 | **≈ 500** | high | SQL bytes and params (`sql-generation.core.test.ts`), reentrant `adapterInput` save/restore |
| 14 | **Request walked twice**: `select-builder.buildSelectPairs` consumes `ExpectedResultShape` instead of re-walking `select`/`include`; five refusals restated verbatim in both walkers collapse | `builders/select-builder.ts:224-440`, `result/result-shape.ts:99-236` | 495 | **150** | medium-low | `rawKeys` order must become SQL order; write RETURNING callers must build a shape first |
| 15 | **Driver twins**: `executeRaw` defaulting to `execute` (5 drivers), condemning-lifecycle helper (5), `createClient` wrappers (11), `mapProviderError` table, reserved-session twin | `drivers/{pg,postgres,pglite,planetscale,libsql}/index.ts`, `error-mapping.ts:232-389` | 670 | **345** | medium-high | Rule 5 verbatim-raw routing on the four drivers that keep an override; `release(err)` vs `destroy` per provider; wrapper/constructor URL precedence (see §4) |
| 16 | **Migration dialect forks in the command layer** (`dialect === "mysql" ? runSequentialProgram : run` ×11, FK-lift bracket ×4, 19 dialect ternaries in `control.ts`) → one `runProgram` on the bound driver | `migrations/pinned-session.ts`, `apply-v1.ts`, `operators.ts`, `reset-v1.ts`, `push-v1.ts`, `control.ts` | 250 | **110** | medium | `mysql-sequential-program.core.test.ts`; control-table DDL bytes on SQLite are compared as strings |
| 17 | **Scalar predicate owners** (`isDecimalList` ×4, `isPoint` ×11, numeric-type set ×4, `SCALAR_TYPES` mirror of the union) + `values-builder` cast-switch twin | `schema/scalars/common.ts`, `schema/model/helper.ts`, `validation/model/core/*.ts`, `schema/validation/rules/*.ts`, `builders/values-builder.ts:580-612` | 150 | **90** | high | none; ownership more than lines |
| 18 | **Client lifecycle copies**: `trackCommitPhases` ×3, the preliminary transaction proxy and its impossible throw, three `get`-trap resolution ladders | `client/client.ts:729-1181`, `array-transaction.ts:308-378`, `array-transaction-legacy.ts:282-319` | 330 | **50** / 115 | high / medium | Rule 6 order; trap branch order |
| 19 | **Dispatch placeholders patched after `seal()`**, four stacked `Object.create` driver views, three pending flags in `executeResetProgram` | `migrations/compile.ts:305-397`, `pinned-session.ts:46-60, 293-434`, `reset-v1.ts:875-927` | 300 | **155** | medium | hash pins; every command signature |

Runner-ups below 50 net each are listed in the per-area reports (session scratchpad).

---

## 3. What is genuinely distinct and must not be folded

- Per-dialect DDL, decimal carriers and conversion proofs, enum spelling, lock proofs,
  namespace proofs, PostGIS preflight, `statement-safety.ts` lexical grammars, the
  introspection SQL itself (`migrations`, §9 of the migrations audit).
- Every driver's provider protocol: pg pool-error retention, postgres.js type overrides,
  PGlite consumable-result proof, Neon full-results contract, Bun SQL parameter
  encoding, mysql2 result normalisation and `USE` handling, PlanetScale response
  contract, sqlite3/bun-sqlite integer safety, libSQL in-memory vs remote, D1 binding
  contract; all 11 `transactionOptionSupport` tables (pinned cell by cell).
- The 14 scalar classes and their per-class method sets, the nine `XSchemas` interfaces,
  `static-membership.ts` and `nested-data-projection.ts` (the type-level mirror of the
  resolver), `RelationState.getter: any`, `ScalarOptions`/`ComputeInput`/`ComputeOutput`.
- Row-held vs junction traversal arms, polymorphic collection `every`, member-first
  LEFT JOIN, `buildPolymorphicRead`, `findUnique`'s raw `LIMIT 1`, cursor condition
  forms, the cache codec vs provider parser split (different trust domains), the result
  container policy and the lexical execute → proof → parse seam.
- The observer onion, the interceptor onion, the request patch-merge, `raw.ts`, the
  measured-hot native-preparation loops in the array-transaction files, `omit.ts`
  rewrite, the result-type guard half of `client/types.ts`, the SWR orchestration.

---

## 4. Defects found by the lens (file regardless of any deletion)

1. `s.number()/s.bigInt()/s.dateTime()/s.date()/s.time().schema(x).nullable()` and
   `s.int()/….schema(x).array()` drop the custom schema from `state.base`: `filter` and
   `update` stop refining while `create` still does (`number/scalar.ts:29-52`,
   `bigint/scalar.ts:32-54`, `datetime/scalar.ts:34-56`, `date-scalar.ts:39-61`,
   `time-scalar.ts:39-61`, `int/scalar.ts:47-53`). `string`, `json`, `decimal` carry it;
   `decimal/scalar.ts:77-80` documents the hazard the other classes still have. Only the
   int → nullable case is pinned (`modifier-contracts.core.test.ts:220-240`).
2. `s.vector().dimension(n)` is not enforced by `create` or `base` (`vector/scalar.ts:62-67`,
   `validation/scalars/vector.ts:75`); only DDL and the cache codec read it.
3. libSQL and bun-sqlite close a **supplied** client on disconnect and on a control
   failure (`libsql/index.ts:139-143, 218-223`; `bun-sqlite/index.ts:160-162, 243-248`);
   every other supplied-transport driver refuses to. `supplied-pool-ownership.core.test.ts`
   covers four drivers, not these two.
4. libSQL treats a supplied client as in-memory (`usesInMemoryDatabase` reads the URL
   default `file::memory:`), enabling serialized VibORM-owned transactions and
   `client.close()` regardless of the supplied client.
5. `createClient` wrapper and driver constructor disagree on `databaseUrl` vs explicit
   option precedence for pg (`pg/index.ts:517-524` vs `:178-180`) and postgres.js
   (`:346-348` vs `:168-171`); mysql2 is consistent and the only one tested both ways.
6. `catalog-probes.ts:205-209` re-derives which statement created an index by substring
   search over statement text; wrong when one index name is a substring of another.
7. `MAX_RELATION_ORDER_DEPTH` is declared as a mirror of the validation constant and a
   test exists only to keep the two equal (`orderby-relation-depth.core.test.ts`).
8. JSON-schema conversion projects option-composed `nullable`/`array` for decimal only
   (`json-schema/converters.ts:280-300`); every other scalar arm emits none — one of the
   two is wrong.
9. Three catalog-boolean coercers in migrations disagree (`reset-v1.ts:556-560` lacks
   `1n` and `"true"`), a real inconsistency on LibSQL `intMode: "bigint"`.
10. `neon-http/index.ts:175-177` throws a bare `Error` at connect time where every other
    driver throws a typed `ClientInitializationError` at construction.

---

## 5. Gates

The Raptor 3 keep/reject gates apply unchanged (delete a representation, a copy, a
temporal field or a restated refusal; no old/new coexistence; census-proven; SQL bytes,
DDL bytes, hashes, error identity and lifecycle order unchanged; a named falsifier).
Three additional rules for this scope:

- **Coverage gate.** Every subsystem runs a 98–100% coverage gate and
  `scripts/coverage-policy.test.mjs` names test files. Deleting dead code deletes the
  tests that cover it; deleting a duplicate arm can drop a survivor below the gate until
  tests are re-pointed. Do the test move in the same unit.
- **Census allowlists.** `database-namespace-census`, `decimal-language-census`,
  `geopoint` census and the migration forbidden-token test pin file ownership by path. A
  new shared module (`drivers/introspect-assemble.ts`, `execution/edges.ts`,
  `validation/scalars/operation-schemas.ts`) must be added to the allowlist in the same
  change, for the right reason.
- **Type-inference gate.** Any fold in `validation/scalars` or `schema/scalars` runs
  `pnpm test:types` before and after; the client shard has an OOM history and the
  per-type aliases are the fallback if it regresses.

---

## 6. Order of work by deletion per unit of risk

1. Dead internal-barrel code (#3) — ≈650 lines, no semantics, one afternoon; do it first
   so later coverage numbers are honest.
2. Per-scalar operation schemas (#1) — ≈700 lines, verified identical files, all tests
   enter through one seam.
3. DDL double axis + SQLite recreation wrappers (#5) and ledger-event builder (#9) —
   mechanical, byte- and hash-pinned.
4. Read-side twins (#13) then the include family (#4) — the byte-pin file is the gate.
5. Errors tables (#8, without the factory), operation-name restatements (#12), hostile
   inspection helper (#11).
6. Driver twins (#15) — resolve the URL-precedence disagreement first, then fold.
7. Migration engine unification (#2, #16, #19) — largest single item, highest semantic
   risk; run the mysql/stepwise ledger suites before and after.
8. Policy decision: scalar-class `base` derivation (#6 full form) — worth asking for
   because of defect 1, not for the lines.
