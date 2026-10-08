# Query engine remediation evidence

Scope: `src/query-engine/**`, then `src/extensions/**` and `src/cache/**`, with their regression tests. Integration base is
`a4a5b8dc6` in `/Users/arnaud/.codex/worktrees/v1-review-remediation/viborm`.
The original checkout was 19 commits behind that reviewed base; its pre-existing
changes remain untouched. Session baseline counts must therefore distinguish
upstream additions from this remediation.

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
| relations-03/sql-perf-01/recursive-projections-02 | Junction membership lowers to target-key IN (source-filtered junction query), allowing source membership lookup before target identity lookup. This applies at ordinary and recursive correlation through the one owner. | Expected collection/filter results passed. Real-provider plans and timing pending; duplicated recursive CTE carrier work remains open. |
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
