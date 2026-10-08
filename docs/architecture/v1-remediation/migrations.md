# Migration remediation evidence

Working tree: `/Users/arnaud/.codex/worktrees/v1-review-remediation/viborm`, based on report revision `a4a5b8dc6`. The original checkout and its pre-existing work are preserved.

## Implemented corrections

| Finding | Responsible existing owner | Correction |
| --- | --- | --- |
| C8 / migrations-01 | `generate-v1.ts`, `resolver.ts` | Converging parents use strict resolution by default. Missing resolver entries refuse instead of silently becoming add/drop. Every parent's operations are returned in `operationsByParent`; flattened `operations` covers every parent. |
| migrations-03, migrations-22 | `differ.ts` | Any paired dropped/created table requires an author decision, even with zero column overlap. This protects junction/table rename candidates rather than treating a 70% heuristic as deletion authority. |
| migrations-09 | `target.ts`, bound migration driver, `client.ts`, reset inventory | Optional exact physical `tables` scope is detached/sorted/frozen and authenticated in estate identity. Desired tables must fit scope; foreign keys and shared enum types crossing it refuse. Tables-only live clients need no estate storage. |
| H7 / migrations-04 / schema-dsl-05 / migrant-10 | PostgreSQL introspection and `push-fingerprint.ts` | Built-in `format_type` retains temporal precision, bit widths and array element typmods. Shared normalization handles aliases with precision. Supported pgvector capability includes halfvec/sparsevec typmods. |
| H7 / dsl-cross-product-01 | PostgreSQL default reader and shared typed comparison | Terminal casts accept qualified/quoted names, multiword types and modifiers. Numeric negative/exponent literals and timestamp/time spellings compare by typed values. Bigint integer defaults never pass through Number. Explicit NULL defaults are omitted. |
| migrations-13 | PostgreSQL column compiler | DROP DEFAULT precedes type conversion; the declared destination default is restored. Enum-to-renamed-enum uses a text intermediate. |
| H7 derived-name collisions | PostgreSQL table finalizer and existing migration utilities | Derived PK, index, FK, unique and enum names have an 8-digit SHA256 suffix when over the 63-byte limit; multibyte prefixes respect byte length. Conflicting declarations of one enum name refuse. |
| H8 / migrations-07, -08, -14, -15 | Differ, shared enum removal owner, dialect compilers | Every enum change retains full order and dependent columns. Nullable removal invokes resolver and never invents NULL. SQLite/MySQL inline changes enter the same removal resolution. Generated estates also invoke the shared resolver. Real PG programs use transactional type replacement, because a new ADD VALUE cannot be used as a default before commit even on PG12+. Direct independent additions preserve BEFORE ordering. PG scalar/array defaults are dropped around type replacement. SQLite mapping occurs in the reconstruction SELECT, permitting mapping to a newly added value. MySQL names stay inline ENUM. |
| H25 / polymorphic-oracle-03 | `differ.ts` | Changing an authored polymorphic member's stored discriminator or target table refuses V11010 before publication; explicit manual data transition is required. Physical CHECK/runtime integrity coverage remains coordinated with the schema/query owners. |
| H26 / migrant-01 | Shared unique-entity normalization and operation sorter | Total btree unique indexes and matching unique constraints compare as one entity, preserving declared DDL implementations. Same-name indexes drop before replacement uniques/PKs. |
| migrations-02 baseline diagnostic half | `operators.ts` | Baseline mismatch includes the complete structural diff in its message. A pull/importer is a distinct unimplemented product feature. |
| migrations-18 | Compiler and existing inverse owner | Restoring a lost NOT NULL column with no default is explicitly irreversible without an author-supplied backfill. Generate returns lossy/irreversible rollback warnings. No original data is fabricated. |
| PB-5 | SQLite column compiler | Adding a computed default such as CURRENT_TIMESTAMP uses the existing table reconstruction owner, which fills existing rows from that default. |
| migrations-16 / -27 | `differ.ts`, compilers, existing formatter | One shared risk classifier replaces duplicated registries. Default-only changes are safe; required additions without a default and enum removals are marked destructive. Plan labels name the affected object. |
| migrations-31 | PostgreSQL migration driver | One provider-side try-lock retry CTE stops after 10 seconds; only returned boolean true proves ownership. |

## Executed evidence

- Affected migration core: **370/370 tests across 11 files**, 3.16s wall,
  602 MiB peak RSS, verified teardown. Included the 30-test adversarial core,
  differ/resolver/generate, enums, PostgreSQL catalogs/namespaces, push planner,
  replacement ordering, SQLite inline enums/defaults, and all DDL drivers.
- Live managed-scope SQLite: **52/52 across v1-push, estate-target, and
  migration-client-surface**, 5.12s, 521.1 MiB, verified teardown. Foreign
  DATETIME/DECIMAL ledger survived scoped push, baseline, verify and reset.
  Adding a `.now()` column on populated data backfilled real timestamps and
  the second push was a no-op. This witness exposed and repaired the missing
  SQLite current-time default and balanced-parenthesis comparison.
- Real isolated PGlite: `tests/providers/local/pglite-migration-adversarial.test.ts`,
  one shared database witness passed in 3.74s / 1971.2 MiB under its allowlisted
  2560 MiB ceiling, verified teardown. Native precision/defaults converged,
  a middle enum addition plus new default stayed transactional, removal mapping
  preserved rows, and a second unlock returned false (one lock acquisition).
- An earlier ordinary-ceiling combined PGlite run was terminated by the resource
  guard; teardown was verified. The final fixture moved to the actual provider
  lane and used its existing isolated stage. No ceiling was bypassed.
- No hosted database, Neon credential, shared schema, production drop, truncation
  or destructive migration was used in this agent's checks.

## Latest integration wave

| Findings / behavior | Final owner and change |
| --- | --- |
| migrations-05 / -19 | CLI typed `migrations.resolve` and `tables`; parent-level `migrate --config`; readable human projections. |
| migrations-06 | `generate --custom` evaluates a TS author returning the existing checked manual input, then publishes authenticated SQL. No production TS execution. |
| migrations-12 | One `finishCli` awaits disconnect before reporting primary failures; cleanup failures attach to the existing suppressed evidence owner. JSON errors use stderr and stable numeric exit statuses derived from migration codes. Driver diagnostics remain driver-owned. |
| migrations-17 | `--yes` accepts additive plans only; destructive non-interactive work requires `--accept-data-loss`, while explicit TTY acceptance remains available. Non-TTY additive input never prompts. |
| migrations-20 | `reviewSql` and `generate --review` / `show --sql --review` label every parent, check, forward and rollback slice. Raw execution blob bytes remain unchanged. |
| migrations-09 reset preview | Read-only reset lists the actual selected physical `tables` through the existing reset planner, without bootstrapping control tables or writing storage. |
| migrations-10 diagnostic half | Apply and verify drift messages include the structural differences, using the existing fingerprint assertion. |
| H21 DDL half | PG DateTime/Time defaults retain 3-digit precision, naive `.now()` stores UTC, and BC date literals reuse the shared temporal codec. |
| C9 runtime integration seam | Pure SQLite decimal CHECK reader/writer and its structural parser moved to adapter storage modules, with no migration graph imports. Runtime admission can consume exactly the same carrier proof. |
| SQLite GeoPoint precision follow-through | Exact old/new CHECKs carry internal `geoPointEncoding`; old carriers reconstruct once to 17-digit binary64 text. The numerical spelling constant is shared with runtime SQL. Already lost digits are not recoverable. |
| migrations-32 | PostgreSQL/SQLite migration guides now use real declarations, real defaults and enum programs. MySQL examples and the driver overview corrected. |

Latest executed checks:

- CLI **69/69**, all five files: decisions/scope, both merge parent groups,
  rollback warning and labelled SQL output, custom author, inherited config,
  reset preview, cleanup-before-exit, suppressed primary failure and typed JSON
  code/exit status. Actual config files load through jiti. Foreign module class
  instances are checked by the original diagnostic name/issues rather than a
  different module's `instanceof` identity. No error wrapping was introduced.
- Migration extraction/Geo/reset batch **118/118 across five files**, 3.34s /
  554.4 MiB, teardown verified. Real legacy GeoPoint values and NULL survive the
  one-time upgrade; newly written binary64 points retain precision; repeat push
  is a no-op. Reset preview returns only the actual selected user table.
- DDL golden **165/165** passed in the preceding affected run.
- The extended live PG `.now()`/year-zero fixture exposed a real server-offset
  mismatch: its BC timestamptz default deparsed as `0001-01-01 01:00:00+01 BC`.
  Result decoding and default normalization now share the unchanged provider
  timestamp parser at the physical codec owner. The final live retry passed; see the integrated checkpoint below.

Follow-through regressions are executed: public DateTime/Time repair, full
canonical predicates, malformed-source refusals, and an authenticated pre-
annotation GeoPoint estate's exact replay/verify/upgrade. Downgrading precision
is explicitly irreversible through the existing driver hook. Public target
shape tests materialize the intersection representation and probe readonly scope
reassignment/list mutation; the integrated native gate covers those contracts.

## Material remaining report gaps

The scope below is explicit so the final adversarial answer cannot conceal
feature gaps behind documentation or a neighboring primitive:

- migrations-02: no schema pull/importer or automatic initial baseline by
  construction. Existing baseline now explains mismatch; it does not import.
- migrations-10: no explicit hotfix reconciliation after a committed history
  state. A new adoption/reconciliation contract is needed; drift remains refused.
- migrations-11: hosted/edge effectful migration admission needs actual proven
  producer lock, execution boundary and marker CAS. A dialect renderer alone
  does not supply them.
- migrations-16: static risk and named labels improved. Populated required-column
  additions without a physical default now inspect whether the selected table
  contains a row and refuse before effects. General row-count, cost and online
  migration planning remain absent.
- migrations-21: one namespace per estate remains a deliberate immutable
  identity contract; multi-schema or tenant-estate reuse needs a separate design.
- migrations-23: current-time defaults compare canonically, but no raw-SQL
  default declaration language is shipped.
- migrations-24: MariaDB, older/non-strict MySQL and CockroachDB admission are
  not newly supported; weakening the proof would be unsafe.
- migrations-25: no Studio/data browser.
- migrations-26 is repaired: contiguous same-table column changes of the same risk class now reconstruct once, including their inverse. Noncontiguous operations and native libSQL alterations retain their ordering and provider paths.
- migrations-29: no seed runner.
- migrations-30: no squash/compaction.
- migrations-28: non-empty push on an authenticated estate is intentionally
  refused; the documented workflow remains generate/apply, with no-op push
  permitted only when the existing proofs agree.

These were reported to the integration owner as actual unresolved gaps, ranked
separately from bounded safety fixes. Source growth and moved physical owners
will be measured against the saved baseline after the final source freeze.

## Complexity measurement

Against the integrated report revision `a4a5b8dc6`, migration/CLI/config plus the
six moved SQLite physical leaf modules grew from **30,925 to 31,944 TypeScript
newline lines (+1,019; 3.3%)**, with 89→90 files at that measurement. This includes
root's earlier config/jiti edits and excludes root's runtime-check leaf and shared
codec/query edits. It counts moved source on both sides. Later bounded repair and
compatibility follow-through will be measured again at final freeze.

The runtime increase is not parity. It supplies concrete previously missing
behavior: strict decisions for every parent, exact scope authentication, enum
transaction/default handling, typed default/cast normalization, review output,
cleanup ownership and explicit consent. Shared physical readers moved rather
than being duplicated; the duplicate destructive classifier was removed.


## Integrated runtime checkpoint (2026-10-08)

The complete migration runtime lane passes **119/119 files and 1,952/1,952 tests**
(`/tmp/viborm-v1-migration-core-4.log`), **8.94s wall / 865.9 MiB sampled RSS**;
ordinary safe-runner teardown verified. Integrated native gate 3 reported zero
migration diagnostics before the latest bounded follow-through.

This run includes the new physical-key/autoincrement refusals and actual SQLite
coalescing witness: two changed columns produce one reconstruction forward and
one inverse, retain the row, apply/down successfully, and verify the original
estate. The first real witness caught empty inverse manifest steps; the compiler
now filters empty physical operations in both directions. Native libSQL execution
and mixed-risk/noncontiguous boundaries stay distinct.

Removing the table-overlap cutoff uncovered candidate starvation: unrelated drops
could consume an intended rename before the resolver saw it. Shared matching
columns now rank questions only; even zero-overlap pairs remain ambiguous and
require explicit decisions. No rename or data-loss decision is inferred.

The three frozen relation corpus PostgreSQL `DEFAULT NULL` entries were changed
individually, with a documented reason: implicit SQL NULL is represented by no
catalog default. Relation topology, physical nullable behavior, constraints and
order remain pinned; the corpus was not regenerated.

This earlier checkpoint excludes the later JSON-default/vector/native-index
witnesses. Their final qualification appears below.


## Final bounded checkpoint

The latest complete migration runtime lane passes **119/119 files and
1,960/1,960 tests**, **9.12s wall / 850.2 MiB** with teardown verified
(`/tmp/viborm-v1-migration-core-7.log`). It exercises:

- JSON document-null/SQL-null/default-string distinction across all three DDL
  dialects, using the existing authenticated sentinel vocabulary and codec tag;
- pgvector capability and visible extension-owned type proof admission;
- SQLite expression/DESC/NOCASE index preservation refusal, with real catalog and
  row witnesses; a selected external table still synchronizes and repeats no-op;
- readable equivalent physical PK/FK/unique-name adoption refusal at effectful
  planning admission, preserving generic diagnostic diffs and typed drift errors;
- canonical SQLite Date/Time `.now()` backfill and second no-op, and the earlier
  complete compiler/CLI/graph/enum/scope/GeoPoint regression corpus.

The final isolated PGlite witness passes **1/1**, **5.13s wall / 1,850.7 MiB**
inside the allowlisted 2,560 MiB provider stage, with teardown verified
(`/tmp/viborm-v1-migration-pglite-final-3.log`). Under `Pacific/Kiritimati` it
executes actual database-default inserts and proves UTC Date/Time values and a
zero-offset TIMETZ default; precision/default introspection repeats no-op. It also
proves BC/year-zero defaults, ordered enum add/removal with stored data, one lock
acquisition, preeffect refusal for a foreign primary-key name, and preservation
of a native DESC index. The first extended provider run found cast/deparse
mismatch; the final owner uses target Date/Time coercion and narrow current-time
normalization. One new unit assertion for that last normalization awaits the
integration owner's final complete core run; the actual provider path is proven.

Constraint-name and native-index defects are mitigated by explicit refusal,
**not** advertised as full adoption/index capabilities. Compound `name` is a
selector only; no physical constraint-name declaration, importer or ANN DSL was
introduced. PostgreSQL/SQLite preserve unsupported native index semantics by
refusing selected-table synchronization before effects.

### Migration roast

VibORM authenticated its migration history more carefully than it understood its
own columns. A hash could swear that an enum migration was exactly the program
that forgot its default, or that a pristine manifest contained a rollback with
no executable steps. The repairs make those failures visible and protect the
stored data. The remaining tradeoff is blunt: a database with semantics the DSL
cannot describe gets a precise refusal. That is a safer V1, but a real adoption
workflow still requires a faithful importer rather than an optimistic `push`.


Latest frozen-source scoped LOC measurement against `a4a5b8dc6`: **30,925 →
32,323 TS newline lines (+1,398; 4.52%)**, 89→90 files.
This uses the same migration/CLI/config + six SQLite physical leaf-module scope
and exclusions as the earlier measurement, counts moved source on both sides,
and excludes tests/docs. It is controlled growth, not parity. That measurement precedes the final catalog/default follow-through. Current
scoped count is **30925 → 32722 TS newline lines (+1797)**, 89→90 files. The extra PostgreSQL physical array leaf contains the moved
adapter formatter and its catalog literal reader; shared codec/adapter edits are
reported by the integration owner rather than hidden as free moves. Precision-six
DateTime.now is now proven by the final live provider witness below.

## Dependency security checkpoint

The complete unfiltered production dependency audit moved from **66 advisories
(32 high, 2 critical)** to **3 advisories (0 high, 0 critical; 2 moderate and
1 low)**. The final machine output is
`/tmp/viborm-v1-prod-audit-patched.json`. No audit ignore list or severity-filtered
substitute was used. A subsequent `pnpm install --frozen-lockfile` succeeds.

Compatible updates retain the existing framework majors: Blume 2.2.1, Astro
7.3.7, Wrangler 4.148.0, fast-uri 3.1.8, brace-expansion 5.0.12, sharp 0.35.5,
mysql2 3.24.5 and Drizzle 0.45.4. Only Prisma's private config dependency selects
deepmerge-ts 8; a scoped patch retains its previous last-entry-wins Map behavior
in both module entries. Real Prisma TypeScript config loading, ordinary nested
records, recursive graph handling, and the Map compatibility edge pass the
standalone `tests/package/security-dependencies-smoke.mjs` fixture.

Published http-cache-semantics 4.3.0 escapes the advisory's old version range but
still reproduces its shared-cache bypass. A scoped source patch makes request
reuse and freshness consult the same security predicate. The fixture proves
that request `max-stale` cannot override private/nonstorable, response no-cache,
shared proxy-revalidate, or implicit private-cookie responses; ordinary stale
responses and explicit public/immutable cookie opt-ins retain their behavior.
This is an implementation repair, not a version-range workaround.

The remaining advisories are sprintf-js precision-specifier CPU exhaustion
(moderate), postcss-selector-parser flat-selector complexity (moderate), and
KaTeX trust restrictions under existing prototype pollution (low). They are not
claimed resolved. Sources: [HTTP cache advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp),
[deepmerge recursive graph advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
and [deepmerge 8 compatibility changes](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0).

The corrected, actually published better-sqlite3 **12.11.1** embeds SQLite
**3.53.2**. Its actual provider optimizer/adversarial regression passes **8/8**,
3.97s / 488.6 MiB, with safe-runner teardown verified
(`/tmp/viborm-v1-sqlite1211-optimizer-witness.log`). The previously proposed
12.12.0 does not exist and was replaced with this registry-verified compatible
release. The public peer also admits version 13, separately qualified by the
integration owner.

## Final catalog and literal-default qualification

The complete migration runtime lane now passes **119 files / 1,970 tests**,
**10.22s wall / 878.8 MiB**, with teardown verified
(`/tmp/viborm-v1-migration-core-10.log`). The follow-through includes actionable
safe error metadata, actual canonical SQLite Time default storage, exact control
state CHECK ownership, populated-row literal-default backfills and no-op repeats,
plus selected generated/custom-CHECK/view preservation and excluded-table scope.
The public Time decoder retains its prior zero-fraction trimming; the physical
storage assertion explicitly proves `12:30:00.000` rather than changing that
public formatting contract.

The current source then passes **3/3 isolated PGlite witnesses**, **5.32s wall /
2,011.8 MiB**, inside the allowlisted 2,560 MiB stage, teardown verified
(`/tmp/viborm-v1-migration-pglite-final-5.log`). The real PostgreSQL witnesses now
also prove populated-row defaults for escaped/empty/numeric/boolean lists, JSON
objects/documents, exact bigint, Date objects and year-zero Date values, with a
second synchronization no-op. PostgreSQL's boolean-array `t/f` deparse is
canonicalized by the existing typed default owner. Actual native precision-six
`.now()` defaults produce millisecond values and find their own rows through
public Date equality; the earlier enum/BC/lock/native-index assertions still run.

Selected PostgreSQL generated columns, partitions and partitioned tables refuse
before effects. View/materialized-view name collisions use the existing desired
snapshot preflight and refuse rather than planning a table creation. SQLite uses
stored structural SQL to refuse generated columns, virtual tables, and custom
CHECK constraints it cannot reconstruct. Known enum/decimal/GeoPoint constraints
remain represented by their existing readers. The internal state-table exception
requires its exact reserved name and exact control-owner writer definition;
control authenticity remains with that owner. MySQL's existing EXTRA metadata
also refuses selected generated columns. Excluded physical objects do not poison
an authenticated managed-table selection. The real provider witnesses retain
stored generated values and readable views after the refusal.

There is still no generated/read-only/view/partition/custom-CHECK DSL. These
refusals mitigate destructive projection; they are not advertised as adoption or
modeling capabilities.

Literal Date/DateTime inputs cross the existing ISO admission and physical
encoders, including naive UTC MySQL and PostgreSQL BC spelling. MySQL/SQLite
lists use their existing BigInt-aware JSON container serializer; PostgreSQL uses
the same escaped physical array encoder as its adapter. JSON object and bigint
literals now become physical defaults. Function/unsupported generators remain
application-only. A populated required-column addition without a database
backfill/default refuses in push with a manual nullable-add/fill/make-required
recipe. Generated add-column preconditions additionally prove the table empty
before effects when no physical default exists. No value is invented for old rows.

The first extended provider fixture used a nonexistent `s.json().array()` call
and shared a namespace with unsupported objects across tests. These were fixture
errors, not API changes: JSON document arrays use `s.json().default([...])`, and
new witnesses use distinct disposable namespaces. The final executed tests enter
through those real public spellings.

## Latest source qualification and provider follow-through

The current complete lane passes **119/119 files and 1,973/1,973 tests**,
**23.10s wall / 840.4 MiB**, teardown verified
(`/tmp/viborm-v1-migration-core-13.log`). Current isolated PGlite passes **3/3**,
**10.56s / 1,787.5 MiB**, teardown verified
(`/tmp/viborm-v1-migration-pglite-final-6.log`). These supersede the earlier
checkpoints for the latest owned source.

The extended qualification proves authoritative scalar transforms run once per
literal-default serialization and are applied to stored/backfilled JSON defaults,
not merely to model-created rows. Already-normalized decimal declaration values,
authenticated null sentinels, and application functions retain their existing
contracts. Actual SQLite FTS5 catalog preservation now runs alongside generated
and custom-CHECK refusal; unrelated managed tables still converge.

Real PostgreSQL/MySQL CI exposed two physical-integration assumptions that local
planning fixtures had hidden. MySQL always names its primary constraint
`PRIMARY`; the finalizer now declares that actual physical identity instead of a
PostgreSQL-style name. PostgreSQL control authenticity now uses the existing type
normalizer to recognize `integer` from `format_type` and old `int4` fixture rows.
Provider migration fixtures select operation kinds by stable `id`/derived `type`
rather than descriptive human labels; the order assertions themselves remain.
The native-type catalog oracle now expects the intentional millisecond precision.
The reserved-conversion collision assertion was retained: its earlier secondary
failure followed interrupted tests blocked by the wrong PRIMARY identity.

Singular polymorphic member junctions no longer store a redundant second-side
reverse index when target uniqueness already covers the full lookup prefix.
Canonical-first targets and nonsingular members retain the necessary reverse
index. Only two identified frozen PostgreSQL corpus indexes were removed, and
MySQL primary names were corrected in its named dialect witness; reasons are
recorded on the corpus cases. The rest of the frozen physical artifact was not
regenerated. Full corpus and orientation tests pass; the existing live
polymorphic convergence fixtures remain part of provider qualification.

These provider CI repairs require the integration owner's final remote rerun;
local PGlite/SQLite evidence is explicit and is not presented as real MySQL proof.

Latest fixed-scope LOC after the final clock/null follow-through: **30,925 → 32,770 (+1,845; 5.97%)**, against integrated review revision `a4a5b8dc6` and the same scoped owners described above (89→90 files). Shared PostgreSQL array leaf and integration-owned adapter/codec files remain accounted separately by the root report. The initial filesystem manifest reflects the older checkout, so it is not substituted for the integrated review revision in this comparison.

The final clock follow-through passes **66/66** focused current-source regressions
(**3.98s / 555.2 MiB**, teardown verified,
`/tmp/viborm-v1-time6-core-final.log`) and the full **3/3** current isolated
PGlite witnesses (**4.73s / 1,727.2 MiB**, teardown verified,
`/tmp/viborm-v1-migration-pglite-final-7.log`). Native PostgreSQL TIME(6) and
TIMETZ(6) `.now()` now use UTC `CURRENT_TIME(3)` so the ORM's own database default
cannot create a time its millisecond decoder refuses. Raw microsecond-modulo
assertions, zero zoned offset, public naive-Time self-equality and repeat no-op
all execute. Default precision-three behavior is retained, and normalization
distinguishes constrained from unconstrained clock expressions. The earlier
1,973-test complete lane remains the broader checkpoint; the integration owner
qualifies the final full source/type/package gates.

The final transformed-default follow-through passes its two files in the
integration owner's core6 run: adversarial-regressions **41/41** and v1-push
**26/26**. A non-null JSON literal transformed by its schema
to document null now emits a JSON `null` default. The original nullable bare-null
default and authenticated DbNull still mean SQL NULL. New three-dialect DDL
assertions and a populated SQLite row witness distinguish `json_type(...) =
'null'` from `IS NULL` (core6 combined log and shard3 log). This correction is
not counted in the preceding executed 1,973-test checkpoint. The integration
owner applies the same result boundary to runtime JSON writes. Native gate 14
has passed the entire declaration estate. These focused results were subsequently included in the integration owner's
fully green core7 gate: **465/465 files, 9,624/9,624 tests** over all four shards.
Native15 passes the whole declaration estate (**27.40s / 5,290.0 MiB**), and
build6 passes (**2.79s / 960.9 MiB**); each runner reports verified teardown.
Fresh immutable-package consumer qualification and documentation build remain
separate gates owned by the integration sequence.

The integration follow-through updates two SQL contract fixtures without changing
adapters: GeoPoint **57/57** and JSON-null sentinel **21/21**, **78/78 total**,
**3.75s / 562.8 MiB**, teardown verified
(`/tmp/viborm-v1-final-sql-contracts.log`). The goldens pin SQLite's binary64
constructor and duplicate bind slots, the Greenwich meridian in the conservative
spatial index envelope, structural JSON-null equality and root-path parameters.
An empty SQL-only mock result now pins the returning fast-create V2006 QueryError
(the query owner corrected its missing-result callback), the existing MySQL
fallback category, and a createMany count of zero. No provider effect is claimed
for these SQL-only fixtures.
