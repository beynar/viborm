# Query engine remediation evidence

Scope: `src/query-engine/**`, then `src/extensions/**` and `src/cache/**`, with their regression tests. Integration base is
`a4a5b8dc6` in `/Users/arnaud/.codex/worktrees/v1-review-remediation/viborm`.
The original checkout was 19 commits behind that reviewed base; its pre-existing
changes remain untouched. Session baseline counts must therefore distinguish
upstream additions from this remediation.

## Release checkpoint

The [final response](RESPONSE.md) and [ledger](FINDINGS.md) own the completed
release status: exact-main CI17 and Release 37908244607 pass at `3a94e1e8`;
V1 is published and the production docs are verified. The focused checkpoints
below retain their chronology, including failures and then-pending work later
qualified by those final runs. SQLite EXPLAIN proves the concrete membership
plan described below; no universal provider timing or ORM benchmark is claimed.

## Earlier focused qualification

Final6 completed all four query-engine coverage projects: **3,176/3,176 tests
across 242 files**, with 107.49s summed bounded wall time and 1,356.9MiB maximum
sampled process-group RSS. Every part verified teardown under the unchanged
1,536MiB ordinary ceiling. Root reported exit0 and no remaining live process;
the terminal summaries and final merged thresholds were independently inspected
in `/tmp/viborm-v1-coverage-query-engine-core-integration-6.log`.

| Project | Files passed | Tests passed | Bounded wall | Peak sampled group RSS |
| --- | ---: | ---: | ---: | ---: |
| layer-query-engine | 34 | 751 | 14.66s | 904.5MiB |
| coverage-write-engine-core | 4 | 82 | 5.18s | 490.7MiB |
| coverage-write-engine | 5 | 95 | 5.16s | 524.9MiB |
| coverage-raptor3 | 199 | 2,248 | 82.49s | 1,356.9MiB |

Merged coverage passes every unchanged subsystem floor: statements and lines
94.23% against 87%, branches 94.33% against 91%, and functions 95.37% against
90%. No source exclusion, floor reduction, raised resource ceiling, skipped
failing assertion, or expected-timeout pass was used to obtain this result.

The earlier worklog tables and checkpoints below retain historical observations;
their queued core-query checks are superseded by Final6. Provider qualifications
remain the separately identified executed witnesses, and missing public APIs or
new query strategies remain product boundaries. This query gate does not qualify
the unannotated cyclic declaration workflow: V1 remains held on that separate
requirement, with evidence in [declaration-backends.md](declaration-backends.md).

| Review cluster / findings | Change | Evidence / state |
| --- | --- | --- |
| C6, nested-write-differential-01/-06 | Clear-first to-many order: disconnect, delete, set, updateMany, deleteMany, update, upsert, connectOrCreate, connect, create, createMany. Adding-before-clearing spelling fails at preparation, with deferred arm failure retained for untaken upsert arms. | Dedicated SQLite set/connectOrCreate and no-write refusal oracle passed. Public docs consolidation is root-owned. |
| C7, schema-dsl-01/data-fidelity-05 | Physical JSON decoding returns the stored document; input `.schema()` is not run again. Removed the read-schema metadata and runner. | Stored/legacy JSON and input-transform-not-rerun regressions passed. SQLite native bigint JSON carriers convert through finite Number semantics, preserving representable caller Numbers above MAX_SAFE_INTEGER. Filter operand admission is root-owned. |
| C11, relations-02, polymorphic-oracle-01, relations-06 | Bare tagged `every` excludes other arms and permits matching-only collections. Tagged to-one `isNot` is restricted to its named variant. Presence tests stored carrier nullness rather than target existence. `every: {}` is vacuously true. | Empty/book-only/video-only/mixed shelf oracle and tagged variant/presence cases passed. |
| H4 | `count` and `exist` demand their physical aggregate row using the existing cardinality owner. Metadata derivation still has a zero-row shape without treating missing provider output as success. | Dedicated missing-provider-row refusal passed. Driver capacity work is separately owned. |
| H5, differential-02/-06, geo-vector-oracle-05 | One asc NULLs-last / desc NULLs-first default; direct, relation, count and distance ordering gain model identity completion. `groupBy` gains grouped-column completion. Keyless ordinary reads remain usable. | Full/offset page oracle and existing order/selector suite passed. Logical distinctOrderBy protocol is now implemented; root+nested backward/sliced SQLite witness passed, preserving forward representatives. |
| H6, differential-03, read-api-04, dsl-cross-product-04 | NULL blobs stay NULL in carriers. Number carriers call adapter exact-number rendering. Point coordinates preserve numeric JSON subtype. Bigint and number lists use exactNumericProjection; bigint scalars project text. | Root adapter owns exact spelling. Existing codec suite passed in the stable145/146 batch; new root live SQLite precision coverage is separately owned. |
| H10, recursive-projections-01 | Recursive materialization refuses more than 10,000 occurrences per recursive carrier, preserving simple-path and diamond output below the budget. | Factorial 9-node clique refusal passed; existing 12,000-node synthetic chain is updated to the new 10,000 boundary. Query nesting admission is root/validation-owned. |
| H12, read-api-03, driver-conformance-03/-07 | Bigint scalar binds retain established provider semantics; the proposed general CAST was removed because it could clamp SQLite and unsigned MySQL values. List members bind canonical text, matching SQLite JSON carrier leaves. Number/bigint list projections bypass native provider lossy decoding. | Stable scalar/list provider suite pending; transport encoding remains driver-owned. |
| H17, read-api-02/differential-07/dialect-features-10 | JSON string filters call type-guarded stringAtPath. Whole-document JSON equality calls adapter extract even with empty path, allowing native PG JSON to normalize through jsonb. | Adapter predicate/JSON tests are root-owned. |
| H21, data-fidelity-04/PB-6 | Temporal provider boundary parses PG text by field arithmetic: ancient years, BC year 1 as logical year 0, second-granularity offsets, and temporal array text. Public Date admission unchanged. | Boundary timestamp/date+array oracles passed, including +00:09:21, logical year0 leap day and 0001 BC. Typed temporal callsites pass semantic adapter hints so the root physical codec emits valid PG BC wire forms. |
| H23, integration-author-02 | Limited mutation retains the selector in the outer WHERE as well as the identity subquery, preserving the provider's updated-row recheck. | SQL change complete; real concurrent PostgreSQL schedule pending. |
| H24, nested-write-differential-03/polymorphic-oracle-08 | Generated defaults are not caller-spelled identities. Duplicate adoption locates through the sole supplied unique. A duplicate singular variant skips instead of transferring ownership. | Generated-key adopt-and-link SQLite oracle passed. Singular no-transfer SQLite witness passed in the corrected 127/127 engine/client batch. |
| H25, polymorphic-oracle-02 | The existing slot integrity carrier now checks unknown discriminator, incomplete pairs and forbidden all-null required slots. | Unknown/half-null and orphan presence oracles passed. Schema evolution migration guard is migration-owned. |
| write-api-03/sql-perf-02 | Eligible scalar live upsert reuses existing targeted ON CONFLICT fold. Stamped, conditional, relation-bearing and non-RETURNING forms retain their existing owners. | Dedicated live SQLite upsert emits one ON CONFLICT statement and no SELECT; stamped/relation routes keep fallback. Cross-provider race evidence remains separately owned. |
| write-api-08/sql-perf quadratic chunking | Geometric local-window probing bounds the oversized compilation work independently of total remaining suffix. Existing compiled bind counts remain authoritative. | 80,000 rows / 1,000 bind budget produces 80 correct windows while inspecting <1.5 million values; regression passed. |
| relations-03/sql-perf-01/recursive-projections-02 | Junction membership lowers to target-key IN (source-filtered junction query), allowing source membership lookup before target identity lookup. This applies at ordinary and recursive correlation through the one owner. | Expected collection/filter results passed. Later actual SQLite EXPLAIN proves a source covering-index probe and target primary-key SEARCH without target SCAN. Universal provider timing remains unmeasured; duplicated recursive CTE carrier work remains open. |
| SQL existence performance | `exist` uses SELECT EXISTS over the same row-window semantics, projecting a statement-local sentinel. It no longer counts every matching row. | Existing exist behavior and dedicated SQL/refusal oracle passed. |

Additional write remediation:
- Plain createMany records without demanded/generated-return identities batch through the existing regional insertMany owner only when their ordered column shapes match. Heterogeneous generated-ID rows preserve input order. One-INSERT and all-or-nothing duplicate rollback witnesses passed.
- createMany reports provider affected-row metadata. It no longer invents a post-commit failure when a trigger suppresses rows; a trigger-ignore witness persisted1 and reported1 from2 submissions. Missing result windows and identity guards remain.

Verification checkpoint: the stable focused engine batch passed145/146 across12 files; the one failing heterogeneous fixture accidentally normalized to the same column shape. Its explicit-ID correction, JSON Number carrier and BC date changes then passed13/13 in the dedicated suite (3.26s wall,457.3MiB sampled process-group RSS, teardown verified). The live official-cache graph witness passed in the corrected 127/127 engine/client batch. Earlier transient adapter/old-budget failures are superseded by those results.

Remaining engine work: duplicated recursive CTE work; broader nested batching than the proven plain createMany seam; real-provider limited-write concurrency and performance evidence. Logical distinct-order adapter/query protocol correction landed and its SQLite witness passed. These are not marked fixed by adjacent changes.

## Extensions and cache response

| Findings | Change | Evidence/state |
| --- | --- | --- |
| H9 ecosystem01/02/type-soundness08 | Query handlers publish their returned transformation after proceed; child failures/protocol failures remain authoritative. Ordinary safe Error objects retain identity instead of redaction into V2001. | Updated runner43/43 and public integration48/48 passed; protocol/child-primary authority retained. |
| H9 names | Schema-bound rows/data/deletion refuse unknown model names and top predicate/stamp/deletion field names before binding. AND/OR/NOT naming checks are bounded16 deep. Structural model guards cover all3 policy members and refuse wide model maps. | Config-derived runtime, mode-shape, logical-field-name and undeclared-control probes passed4/4; public generic/concrete type probes await integrated native gate3. No parallel registry or raw target-thunk traversal added. |
| H9 security05/ecosystem12 | Caller-wins stamps remain the settled default-only contract. The contradictory tenancy create claim is corrected, with an acme control/globex explicit tenant example. | Existing extension-data-behavior.ts:703 exercises caller overrides across create/nested/update. No new enforce API introduced. |
| H19 polymorphic-oracle04 | Nullable object carriers wrap nullableCodec. Variant collection arms encode each tagged row rather than asking for another array. A present tagged arm cannot have null data. | Live null-slot/nonempty variant hit and fresh-graph witness passed. |
| H19/security06 | Existing fast lookup hash retained; official r4 entries also carry full canonical identity and verify it before materialization. | Controlled aliasing backend identity mismatch becomes a miss; regression passed. No claim of a newly reproduced natural collision. |
| H19 ecosystem17 | KV TTL clamps60 seconds; stored logical expiry bounds fresh/stale use independently of backend retention. Markers check their own age. | Retaining-backend stale expiry and own-age marker witnesses passed, alongside obsolete query-fill and late-backend-set race witnesses. |
| H19 ecosystem03 | Successful durable writes invalidate the complete bound cache scope by default, with explicit autoInvalidate:false opt-out. Existing commit/rollback ownership is unchanged. Local obsolete fills are suppressed before storage and removed if backend set finishes after invalidation. | New complete-scope and in-flight-query-fill regressions passed. Late-backend-set race and corrected manual exact/prefix invalidation regressions passed in the final full cache95/95 batch. Generic KV remains eventual across processes; no linearizability claim. |
| H19 production-ops19 | MemoryCache defaults1024 LRU entries with exact maxEntries option and one unref sweep timer; absolute expiry supports TTL beyond2^31. TTL admission refuses Infinity/overflow. | LRU/single-timer/long-TTL/disconnect/options+finite-TTL tests passed. Bound is entry count, not bytes; Redis/Upstash additions remain product gaps. |

Expanded batch passed162/168 across11 files (5.63s wall,541.3MiB RSS). Runner91/91, policy3/3, new cache9/9, namespace encoding16/16, live cache and distinct witnesses passed. Six failures: one real implicit-auto-on-manual-invalidate bug (fixed), its scope expectations, old JSON read-schema getter expectation (C7 correction), and wrong singular input spelling (corrected). Those follow-ups passed in the corrected127/127 engine/client and final95/95 cache batches. Custom keys remain canonical suffix contributions, not tags; whole-scope invalidation safely covers them, but adding targeted tag indexing would be a separate public feature. Documentation must not sell tags the protocol lacks.

No commits or pushes were made by this agent. The new test file belongs to the
existing extended-local test lane, so it is picked up by the credential-free
suite without a new framework or manually maintained test registry.

Final bounded checkpoint: corrected engine/client6-file batch passed127/127
(15.72s wall,508.9MiB sampled process-group RSS), including singular no-transfer,
logical distinct representative order, cached relation graphs and hook/SWR behavior.
The final combined batch passed cache95/95 and client91/91 (controls48,
deletion13, policy4, soft-delete26). Dedicated engine17/20 exposed three new
fixture mistakes: omitted registered relation target and two wrong vector-builder
spellings. Fixtures now use the complete schema and `s.vector().dimension(2)`;
those corrected tests require rerun. Loading the separate legacy repair2 estate
in that same process reached1894.3MiB against the1536MiB ceiling, so the safe
runner terminated before repair2 reported. Wall13.68s, teardown verified; future
checks split the dedicated suite and legacy estate instead of raising the budget.

New source awaiting those checks: generated scalar identity sets use the existing
IN predicate owner, compound identities use balanced OR trees; vector fallback
binds the JSON carrier, nullable vectors and undefined cosine distance decode to
null; pending model operations expose the existing lazy Promise methods through
Promise compatibility; lexical read/fresh-write SQL model dependencies are captured
for root's physical-schema guard integration. The dependency capture itself passed.
Atomic physical-schema guard composition is still pending and is not claimed closed
by the current precheck. Provider timestamp parsing moved unchanged to the existing
datetime-physical-codec owner, shared by result and migration defaults.

All owned source/tests frozen for integrated native gate3. Generic mapped policy
model-key guards remain unverified by that gate. Runtime control references reuse
the existing collector and refuse undeclared names while retaining declared optional
absence. No additional control registry or tag index was introduced.

Subsequent focused qualification: final dedicated21/21 plus public array54/54
and official cache instrumentation9/9 passed84/84 (12.12s,488.6MiB). The legacy
repair2 suite passed22/22 separately (4.92s,463.0MiB). The new real PostgreSQL
Boolean MIN/MAX projection/all-null/HAVING witness passed1/1 in PGlite through
the existing isolated provider stage (5.53s,1335.1MiB). Initial wrong project and
ordinary-provider RSS attempts did not qualify; the allowlisted stage did. No
resource limit changed. All successful launchers verified teardown.

The physical storage seam now limits observation to captured model dependencies,
then composes adapter-owned assertions with typed statements through existing
atomic batch/transaction ownership. Native prepared packages shift guard/parser
windows; direct reads bypass consumable/positional paths only when assertions
actually exist. Protected schema contexts preserve the trusted extension chain
while excluding user transforms. Driver error index rebasing uses the existing
trusted snapshot clone owner. Root owns integrated unrelated-model and mutable
catalog/data race witnesses, so this seam remains implemented-unverified here.

`nested-write-differential-08` now deduplicates repeated exact connect equalities
before an FK in a compound key moves; distinct logical filters are not collapsed.
Its live SQLite witness passed. `write-api-09` trigger suppression is verified by
the dedicated count witness. `ecosystem-18` exposes the existing lazy methods as
Promise<T>; root owns final public typing/probes. SQLite structural JSON equality
(read-api-11/differential-16) is root adapter-owned work, not resolved by the
string filter guard.

Interactive lost-race correction (write-api-04): callback operations may re-plan
only after their existing granted savepoint region rolled back. Borrowed scopes
never retry in place. The existing selected-constraint matcher gates region
retry, and the one recovery allowance remains operation-owned. Hosted two-pool
Neon witnesses are saved for upsert, connectOrCreate and unrelated unique refusal;
provider qualification is pending the next coordinated runner slot.

Hosted lost-race qualification passed3/3 on Neon TCP, with two independently
committing pg pools (5.37s wall,481.7MiB, teardown verified). The schedule commits
the winner after the absent SELECT and before the loser's INSERT. Fallback
increment upsert adopted that row and incremented once; nested connectOrCreate
re-entered its own savepoint without losing earlier/later outer callback writes;
a different primary-key conflict was not retried, and the outer transaction
remained usable. Empty own fixtures retained as
`public.viborm_race_a47a6f0c1bb34b5ea22b824ad71321dd_owner` and
`public.viborm_race_a47a6f0c1bb34b5ea22b824ad71321dd_item`; no DROP/TRUNCATE.
All owned source/tests are frozen for integrated native4/package qualification.

H23 capped-write proof passed in the hosted5/5 file: the claimant's exact pinned
transaction PID was observed waiting on a real PostgreSQL Lock before the holder
committed its n→0 update. Limited UPDATE and DELETE both returned count0 and left
the changed row intact. No arbitrary sleep schedules the race. Additional retained
empty fixtures: `public.viborm_race_d916634ee35b4812a6f6cdb7ebfb648c_owner`/`_item`.

transactions-13 now fails closed. Unsupported member suppression is refused by
the existing plan capability owner before user DML. Complete array admission
also runs for vanilla arrays, rather than only request/control chains; it reuses
the existing memoized package preparation. Native root scalar SQL skipping and
granted interactive member savepoints remain supported. The retired warning
WeakMap/lineage mechanism is removed. Dedicated22+array54 passed76/76 on installed
SQLite13.0.3 (4.60s501.9MiB), including zero earlier array/user DML before refusal.
Eight older drop-contract suites now pin refusal/no warning/no partial effects;
their final provider qualification remains pending the integrated gate. Exact
createMany/compatibility/D1/layer guide contracts were updated. All source/tests
are frozen for native4/package checks.

Final bounded closure checkpoint (before native7/core2): PolicyModelsGuard now
checks the complete set of model keys after distinguishing an unbound generic
schema. An isolated strict TypeScript program passes generic schema-intersection
factories and unbound generic recipes, while consuming both held-typo-beside-real
and wide-Record refusal probes. The earlier per-property conditional and key
remap attempts failed generic bodies; native qualification of the saved rule is
still pending. No trusted generic assertion or weaker concrete refusal was added.

Cursor relation/count/distance runtime refusal now uses UnsupportedOperationError.
Those ordering capabilities remain absent features. Direct FieldRef slots inside
scalar filter Sql operands prepare through the existing field-scope/domain owner
and lower against the actual mapped-column alias. Ordinary literal slots stay
parameters. Descriptor-only, cycle-safe inspection refuses tokens hidden inside
parameter objects. This applies only at the typed filter operand boundary, not
raw SQL globally. Public actual SQLite root/nested arithmetic and invalid-scope
witnesses are saved but have not run yet.

Implicit FK membership updates now admit generated update timestamps through the
existing update-data schema; settled exclusion of extension data stamps remains.
Root and nested empty upsert update arms retain the found row without generated
or policy stamp assignments. Actual SQLite connect/set in both directions and
empty root/nested arms are saved but unverified. The native non-text string
pattern SQL repair also awaits its real allowlisted PGlite provider witness.

Documentation corrections close JSON replacement versus literal {set} confusion,
all remaining live skipDuplicates warning/drop promises, model-only automatic
cache invalidation, non-member disconnect/empty-slot delete, occupied1:1
expectations, and polymorphic only versus complete integrity probing. SQL 3VL
every(NULL), ASCII folding, synchronous request and cache bypass for arbitrary
statement transforms remain documented contracts. Missing query APIs and new
performance strategies are explicit product gaps in findings.json; no runtime
repair is claimed for them.

Final control/array/recursive qualification passed138/138 (8.91s wall,
631.6MiB sampled group RSS, teardown verified): controls48, query-interceptors-
array54, dedicated22 in its actual extended-local project, and recursive
carrier14 in its actual raptor3 project. The saved two-phase admission uses
existing prepareAdmission input/plan phases; it retains late physical prepare
and query-handler order while proving all controls precede statement transforms
and unsupported member skipping reaches no earlier user DML. The first attempt
using owner.prepare directly passed101/102 but moved an injected late failure
before handlers; that attempt was corrected rather than its oracle weakened.
The recursive cycle witness now proves V8003 and relation metadata. Native8
qualified the generic model-key guard (8.99s7158.3MiB); later literal-only variants
and direct-write-key candidates still await integrated native qualification.

Direct write-key candidate derives scalar/relation names from M State and reuses
ClauseGuard over a flat unknown-valued record. It never asks the recursive write
payload for keys. Public direct fresh/held create/update/upsert/createMany
negative and positive probes are saved; native and TS5.8 chain qualification
remain required. Nested model-dependent write/operator guards were not added.

Latest integrated checkpoint (pending next full gate): the actual SQLite12.11.1
provider batch qualified12/12,5.08s538.6MiB with teardown verified
(`/tmp/viborm-v1-query-final-sqlite.log`). This covers current-row Sql FieldRef
binding through mapped columns/root and nested aliases, preserved literal
parameters, V8003 wrong-model/hidden-token refusals, explicit unsupported
relation/count cursor ordering, parent/child membership updatedAt stamping,
and empty root/nested upsert update no-ops. These findings now cite executed
provider evidence rather than a queued witness.

Native11 completed10.54s7388.2MiB, failing only two deliberate raw extra-argument
fixtures owned by root; the current direct-write, polymorphic-envelope,
soft-delete, isolated decoder-catalog and HAVING/OrderBy batch contributed no
TypeScript diagnostics. This is not a claim that the full gate passed.
Historical `secondary` and `commments` root-write typo pins now fail correctly
and were converted into exact negative probes; valid declared polymorphic
members remain admitted. Strict packed TS5.8/native public write-key witnesses
are driver-owned and still required before final release qualification.

The original CI exposed two fixture trust-boundary gaps. Scripted row decoders
now delegate protected `$schema` catalog and assertion work to their own stock
SQLite driver initialized via the actual migration owner; user rows remain
scripted and fixture-owned teardown closes that catalog. The semantic B harness
observes real EngineSchema admission instead of relying on a write transform
running in a filter. The semantic C deleteMany harness observes the actual bound
deleteGroup filter validation with scoped install/restore; full cut/count/order
assertions remain. These harness corrections are saved but not yet executed.

Original-input closure now precedes JSON normalization, with the transformed
output closure retained; root's recursive JSON owner additionally refuses a
FieldRef exposed only by a later getter. MySQL alone normalizes exact `"0"` and
`"1"` integer boolean transport at its existing parseField boundary; general
integer transport and the shared strict boolean parser remain unchanged. The
new regression witnesses are saved and await focused runtime qualification.

HAVING closes the full aggregate/filter union before matching, preserving an
explicit refused-expression message instead of an unrelated unknown aggregate
key. Only fresh model-owned OrderBy schemas install the same closure in place,
retaining entries/extend metadata; captured original validation prevents
self-recursion. No borrowed/interned schema is mutated and no broad write-schema
wrapper was added merely to homogenize invalid-type messages.

Native12 passed the complete estate in9.23s6007.7MiB with teardown verified.
Current owned production TS census against reviewed upstream a4a5b8dc6 is
30,902→31,835, net+933 (+3.02%); the count includes shared root/driver edits
inside query-engine/extensions/cache/soft-delete and excludes tests/docs.

Core5 shard1 then exposed seven owned stale expectations: noncanonical MySQL
integer-boolean text must refuse, deliberate wrong-model field operands now use
UnsupportedOperationError, limited mutation SQL must recheck its candidate
predicate outside the keyed window on all dialects, and safe bounds compose
coordinate guards whose parentheses differ from the old whole-predicate pin.
The repaired exact SQL goldens retain outer rechecks/total order/MySQL derived
windows; the distance oracle asks for the real conservative index predicate only
in positive bounded filters and forbids it for lower bounds/negation. No provider
result expectation or predicate semantic was relaxed.

The five existing caller-only key portability/transition refusal sites now use
V8003 with unchanged messages and arithmetic eligibility. Matching legacy class
string witnesses changed accordingly; a genuine internal exact-decimal computed
publication invariant keeps V9001. Prepared MySQL concurrent-upsert oracles now
expect the authorized selected-constraint adoption through failed+fresh member
savepoints on the same caller connection, then successful caller commit. This
remains provider-CI evidence pending, rather than borrowing the executed Neon
race proof as a claim about MySQL.

Actual PGlite native string/provider checkpoint passed8/8,7.35s1949.2MiB under
the existing2560MiB isolated-provider allowance, with teardown verified
(`/tmp/viborm-v1-query-native-string-final.log`). Nontext INET/CIDR/MACADDR/UUID/
XML/TSVECTOR/TSQUERY/BIT pattern and case operations, native MAC/UUID equality,
and explicit XML equality refusal are executed. Root's same fixture also proves
citext, year0, nullable/zero vector distances,480 independently computed distance
points, and wide native JSON projections.

Focused169 attempt2 still had162 passes: every prior ordinary literal SQL,
canonical written identifier, null ordering, divide0 and spatial-probe repair
passed. Six remaining failures were obsolete malformed-result classes while the
driver owner installed the authorized V2006 taxonomy; their final golden changes
are now frozen. One remaining PG nonenum brace-array pin was obsolete after H21
and now accepts the declared native array-text grammar. JSON-container dialects
accept JSON text only, gated by the existing adapter carrier declaration. The
final169 followup is still required after root yields the runner.

The earlier pending169 layer follow-up was superseded by the complete integrated core7 run: all four shards passed9,624/9,624 tests. Subsequent real-provider and semantic qualification is recorded below; historical failed attempts above remain failed evidence, not completion claims.

### Final query qualification checkpoint (2026-10-08)

The L3 collection update bags now own clearing-before-supply refusal using their existing partial-object admission hook. The late L6 copy of that rule was removed. An invalid nested spelling stops before root or member DML, including batch-only segmented execution; canonical set/create, delete/create and set/connectOrCreate still execute. The validator already removes undefined keys, and its duplicate undefined check was removed after coverage exposed that unreachable state. A public omitted-undefined regression preserves that boundary.

Clock identity operands now use the existing ISO-time owner to reconstitute canonical millisecond text from decoded clocks; timestamp text retains its separate physical-byte contract. Controlled fixture cuts recognize the driver's actual BEGIN IMMEDIATE, and the shared harness records the successful begin only after native execution. Held late transaction results preserve the original caller failure by identity and cannot publish a successor or prefix.

Actual final checks (all teardown verified):

- Query correction gate: 135/135, 10 files, 6.57s, 707.3MiB; /tmp/viborm-v1-query-ci2-corrections-4.log. Earlier 641/649, 104/113 and 133/135 were genuine failures diagnosed and corrected, never presented as green.
- L3 combined-verb and OwnWrite/conditional counterparts: 283/283, 7 files, 4.53s, 559.5MiB; /tmp/viborm-v1-query-ci3-counterparts.log.
- D1 local worker: 40/40, 6.47s, 675MiB; no-effect unsupported skipping, supported scalar skipping, committed invalidation, exact decimal and CUID generation; /tmp/viborm-v1-query-d1-final.log. Remote checkpoint CI3 Bun+D1 also passed.
- SQLite public provider proofs: 14/14 initially, 3.44s/506MiB; then binary64 edge suite 10/10, 3.55s/482.5MiB. Math.PI, positive/negative Number.MAX_VALUE and Number.MIN_VALUE survive include and all four aggregate carriers. Bigint-list has preserves >2^53 exact members and rejects an adjacent nonmember. Actual m:n EXPLAIN requires source-junction covering-index probe and target primary-key SEARCH, with no target SCAN. Logs /tmp/viborm-v1-query-sqlite-proof-final.log and /tmp/viborm-v1-query-sqlite-binary64-final.log.
- Actual isolated PGlite: 9/9, 14.73s, 1801.9MiB under the existing 2560MiB allowance. A server Europe/Paris session emits ancient year0099 +00:09:21; Date/temporal-array/bigint-array include AND nested select stay exact. UTC restored in finally. /tmp/viborm-v1-query-pg-named-zone-final.log.
- Exact A/B semantic campaigns: each100seeds x2profiles =200 completed schedules plus verified saved replays. A4.78s/727.8MiB, B4.58s/624.4MiB; runner authenticated production c62823e484e3fe8a0182e4475656980ba341743d865cf4a8ea04099d92df2374 and harness b9e7001a2689a11fdd47a86b91ceef379a6e4040cffc08031c98371323dfcbc0. These fingerprints precede the parent's later style-only constructor change; they are not claimed as the final release hash. Logs /tmp/viborm-v1-query-semantic-a-final.log and /tmp/viborm-v1-query-semantic-b-final.log.

Production source under the delegated roots currently measures 30,902 reviewed-base lines versus 31,894 current lines (net+992, 3.21%). This includes concurrent parent/driver edits in those roots and excludes tests/documentation. It is an observed footprint, not a performance or independent-complexity claim. General nested create[]/connect/set batching, cursor relation/distance support and deeper static data/operator exactness remain explicitly separated product boundaries. V1 does not invent a second transaction owner, topology registry, cache key hash, or raw expression DSL.

The integrated validation coverage rerun `/tmp/viborm-v1-coverage-validation-2.log` now proves statements, branches, functions and lines all100% at their unchanged100% floors. It includes the undefined-omission collection case and HAVING callback refusal without caller-code execution. The decimal census correction is verified44/44,7.45s wall497.4MiB RSS with teardown confirmed (`/tmp/viborm-v1-query-decimal-census-final.log`); its only corrections are owner relocation and once-only SQLite catalog-flag exemptions with independent duplicate/amount/wrong-function negatives. Actual shipped-source floating-transport census remains zero.

Package orchestration follow-through: the controlled sync/async timeout regression confirms that killing the smoke leaves its compiler alive in the same aggregate group. Installed Vitest3.1.4 project-level bail stops every successor; the existing bounded-process owner then verifies complete group teardown. Gate18/18 passed6.10s (`/tmp/viborm-v1-package-process-ownership-3.log`). Package orchestration now uses async execFile at the unchanged30s timeout/768MiB heap, project bail1, and one packed archive across fresh isolated consumer fixtures through the existing tarball seam. Aggregate1536MiB/300s bounds remain unchanged; no competing tree cleanup or detached smoke group was added. This confirms the leak mechanism; the historical CI process roster was not captured, and a complete repaired package qualification remains pending.

The Neon committed-segment coverage fixture now uses the installed SDK query descriptors/client.query/array-transaction shape. All13 tests pass2.99s420.2MiB (`/tmp/viborm-v1-query-neon-capability-final-3.log`). The original false-capability uncertainty progress assertions remain intact through an explicit test-owned unacknowledged transport double, while the true-capability counterpart preserves the exact original failure without inventing committed progress. Opaque multi-statement errors again retain transaction context, with exact one-statement attribution unchanged. No production driver or query engine change was needed.

### Final6 fixture repair and preservation review

Earlier full coverage attempts exposed genuine fixture failures and a resource
termination; those attempts remain failed receipts. The corrected focused gates
passed154/154 (6.47s,770MiB) and76/76 (6.37s,738.1MiB), before the complete
Final6 run above passed. The full corpus includes the formerly failing recursive,
vector, decimal, decoder, null-order and generated transition suites.

- Borrowed SQLite fixtures now enable foreign keys before client construction.
  Deliberate raw orphan/cycle seeds disable them only for the owned seed and
  restore them before typed operations. No production admission check was relaxed.
- Decimal field-reference fixtures now use the existing checked INTEGER
  coefficient owner and correctly scaled seed values. Same-domain equality and
  negation retain exact successful IDs; different precision/scale still refuses
  with the original directional diagnostic. Public-route/candidate parity no
  longer compares an admitted coefficient domain with foreign TEXT storage.
- Vector fixtures now prove supported JSON storage and exact write/read values,
  while malformed dimensions still refuse before effects and absent distance
  capability still refuses. Recursive statement-count witnesses keep all physical
  observations and distinguish protected schema guards by the actual context
  model, preserving the single typed recursive SELECT claim.
- Scalar and absent-relation ordering now pins the approved ASC NULLS LAST /
  DESC NULLS FIRST contract, including independent expected IDs. Explicit null
  overrides, cursor windows, signed take and identity completion remain checked.
  Distinct negative take preserves forward representatives before slicing.
- Malformed-result witnesses retain their hostile values and now pin the public
  V2006 QueryError taxonomy, nonretryability and precise scalar-domain reason.
  They still prove strict refusal at direct and nested result placements.
- Generated collection transitions retain canonical success cases, exact error
  identity/code/message checks, boundary observations, full rollback snapshots
  and untouched-row comparisons. The retired supply-before-set expectation was
  replaced with the approved clear-before-supply contract: a missing set target
  refuses before later supply, observed at every boundary; a distinct existing
  set target still permits and retains the later supplied membership. Delete/
  create uses canonical ordering, while delete/update still proves the missing
  target was observed after deletion and that the operation rolls back.

These repairs preserve the intended positive, negative and effect guarantees;
obsolete assertions of intentionally corrected behavior were replaced with
explicit contract counterparts, not removed to make the gate pass. The latest
seven-file repair diff was reviewed independently before Final6. No semantic
failure remains in the completed query coverage receipt. All owned source,
tests and this report are now frozen; remaining release qualification and the
separate type-emission correction stay with their assigned owners.
