# Recursive queries — Raptor 3 co-release implementation plan

**Status: implemented through the ordinary projection and executed locally on
SQLite, PGlite, native PostgreSQL and native MySQL (2026-09-23); hosted
providers deferred.** The source-bound local release verdict, which is the §7
acceptance record and owns every executed and measured result, is
[rq07-release-verdict.md](../docs/architecture/raptor3-evidence/recursive-query/rq07-release-verdict.md);
the contract/placement and baseline record is
[RQ-00's ledger](../docs/architecture/raptor3-evidence/recursive-query/rq00-contract-baseline.md).
Recursive queries are part of the same release as the new
engine, as requested by Arnaud. This document is the canonical feature contract,
implementation sequence and acceptance gate.

**Planning review:** independently reviewed with Sol 5.6/high; the eligibility,
result-view, statement-accounting and measurement clarifications were accepted.
This is source/document review, not execution evidence for the proposed feature.

## 1. Goal, baseline and scope

Ship recursive **relation projections** through the normal client. Express
chains, hierarchies and graph walks by composing the existing resolved relation,
ordinary node projection, termination policy and occurrence identity.

This is a read/projection extension, not another engine rewrite. Keep the
command language, occurrence structure, transaction ownership, admission timing,
recovery permissions and shipped route. No recursive mutation language, public
CTE API, graph schema kind, new driver capability flag or fallback engine.

Two independent checkpoints must pass on the **same integrated source**:

1. [Final local engine closure](../docs/architecture/raptor3-local-release-finish.md):
   shared NULL-reference requirement, native MySQL, captured-set contracts and
   source-bound evidence.
2. This feature: public admission, SQL, parsing, types, caching and composition
   on SQLite, PGlite, native PostgreSQL and native MySQL.

Hosted/remote transport qualification is deferred. Do not request hosted
credentials or present a local fixture as hosted evidence. Local-provider
failures remain release blockers. Neither checkpoint alone authorizes publishing.

### Provenance and the RQ-00 baseline

The earlier inspected starting tree was
`cdd787ac8bbdb735535552dd5851a4758eb8789c`. RQ-00 rebased the implementation
baseline to current source `076fad02b1c77435ce7389a51996163c66aad819`.
Its production, harness, scripts, benchmarks and pinned configuration content
matches accepted measured checkpoint
`bd264d329221f1c6257aac264fedd59c413707e6`; exact identities and focused checks
are recorded in the RQ-00 ledger. Preserve concurrent work; never overwrite it
with either snapshot.

The public contract below incorporates the more complete recovered proposal at
`recursive-query-wip`, commit
`91507931da63f083b240144389045dba43b2878c`, file
`features-docs/recursive-query.md`. The earlier sketch survives at the inspected
starting commit. Their old per-file recipes are superseded, not historical
evidence erased. The historical D-54 private-fit boundary remains a record of
that milestone; the present co-release request authorizes public feature work.

Present at the RQ-00 baseline (the private slice has since been retired, §3.6):

- A real private `Queries.recursive()` slice with resolved correlation,
  complete keys, ordinary predicates/projections/codecs and adapter-owned CTEs.
- SQLite/PGlite and native PostgreSQL/MySQL recursive fit witnesses.
- A shared ordinary relation projection and result-shape system.

Not proven at that baseline (proven since, see the
[release verdict](../docs/architecture/raptor3-evidence/recursive-query/rq07-release-verdict.md)):

- Public recursive select/include, nested recursive carriers and graph semantics.
- Exhaustive traversal, the public cutoff contract, static inference and type text.
- Recursive cache snapshot/materialization and all normal operation placements.

That slice carried SQL paths, pruned cycles and initialized terminal relation
keys. Those were private-fit semantics, **not** the public contract below.
Its receipts prove their recorded slice only; do not relabel them.

Read [ELEGANCE.md](../ELEGANCE.md), the
[engine guide](../src/query-engine/AGENTS.md),
[Raptor 3 guide](../src/query-engine/raptor3/AGENTS.md), and applicable schema,
validation, adapter, client and cache guides before editing.

## 2. Public contract — implement, do not renegotiate in code

### 2.1 Eligible slots and identity

A recursive slot must target its own source model through an ordinary,
schema-resolved model-target relation. Its model must have a complete primary
row key. Supported shapes are:

| Shape | Existing resolved fact | Direction |
| --- | --- | --- |
| Singular chain | Self `toOne` over a foreign key | FK-owning direction, or inverse of a proven one-to-one edge |
| Collection hierarchy | Self `toMany` over a child-owned foreign key | The asking slot's child direction |
| Junction graph | Paired ordinary self `toMany`/`toMany` junction | The asking slot's oriented source/target sides |

Read `ResolvedSlot`, the existing bound membership and key catalog. Do not
call raw target getters, rescan inverse relations, infer topology from nullable
fields, or copy a relation resolver. Compound and mapped keys, alternate
referenced unique tuples and adapter namespaces retain their existing meaning.
A reference tuple is not the row's primary identity.
Keep private identity in its provider-addressable domain. Reuse the existing
physical-identity owner; do not decode it to public Date/Decimal and re-encode
it to make a map key. In particular, two distinct SQLite TEXT DateTime keys
representing the same instant must remain two rows throughout traversal.

Variant-target transitions, inverses bound to variant storage, non-self targets
and unresolved topology do not admit `recurse`. Ordinary variant projections
*inside* a returned node retain their existing support.

Static eligibility uses the existing static membership view. A declaration too
broad for TypeScript to prove fails closed statically; that is not a reason to
reject an otherwise valid resolved runtime schema. Do not add model brands or
a recursive whole-model structural-equality algorithm.
Runtime object identity remains authoritative: structural TypeScript agreement
is not proof that two model objects are the same. Include a structurally
indistinguishable non-self target in the runtime-negative tests; do not claim a
nominal static guarantee the current schema type system cannot express.

### 2.2 Syntax and defaults

```ts
type ForeignKeyRecurse = true | { depth?: number | false };

type GraphRecurse =
  | true
  | { depth?: number; preventCycles?: boolean }
  | { depth: false; preventCycles?: true };
```

These describe the options, not a requirement to expose these exact alias names.

- `true`, `{}`, and omitted/undefined nested `depth` mean **depth 100**.
- Numeric depth is a positive safe integer **1–1000**. Reject invalid input;
  do not clamp. Direct related records are level 1.
- `depth: false` means exhaustive traversal with no ORM depth cutoff.
- Graph `preventCycles` defaults to `true`; `false` is legal only with
  numeric/default depth.
- Foreign-key traversals do not admit `preventCycles`.
- `recurse: undefined` means no recursion under ordinary optional admission.
  Top-level `recurse: false` is invalid.
- Exhaustive graph traversal with `preventCycles: false` is invalid in both
  public types and runtime admission, before cache/provider work.

The existing admission boundary owns normalization once. Downstream consumers
receive effective meaning, not `true`/object/default branches.

### 2.3 Projection, filtering and ordering

`recurse` is a modifier on an ordinary relation node in **select or include**.

- Singular nodes retain `select`, `include`, `omit`; they gain no collection
  filter, order or pagination clauses.
- Collection nodes accept `where`, `orderBy`, `select`, `include`, `omit`.
  They do not accept `take`, `skip`, `cursor` or `distinct` with recursion.
  A global CTE limit is not per-parent pagination.
- Non-recursive nodes and root pagination keep their current contracts.
- A collection filter applies to **every hop**, including direct children.
  A filtered-out node and its branch are not traversed. The filter must answer
  the same for a row at every hop of one traversal: the statement discovers a
  parent's children at every level it reaches that parent and the decoder
  requires the transported facts to agree, so a volatile filter (a raw
  fragment such as `random()`) can make a legitimate statement's carrier
  disagree with itself. It is then refused at the carrier boundary as an
  invalid provider result, never decoded into a partial answer. Where one
  evaluation of the CTE feeds both readers (PostgreSQL), the per-level hop
  check refuses it: the caller receives the `QueryEngineError` V9001
  `Driver "…" returned a malformed recursive depth scalar for operation "…": ….`,
  whose `meta.scalarType` (`recursive depth`) names the kind of check, and
  whose message ends with the reason of the check that failed. SQLite
  evaluates the CTE once per reader and typically refuses it at the
  `recursive edge endpoint` or `unreachable recursive node` check. A carrier
  refused as an invalid provider result reaches the caller exactly as a
  malformed ordinary row or collection does (§3.3): as that V9001
  `QueryEngineError` through `OperationContext.failure`, except for a member
  of a `$transaction([...])` array on a batch-only transport (D1, neon-http).
  The array owner parses that member's result, and like an ordinary malformed
  member it surfaces as `QueryError` V2001. A contract limit, stated once here.
- Ordering applies independently to each parent's returned collection. Reuse
  the ordinary SQL order owner, provider collation/null rules and complete-key
  tie-breaking. Do not sort provider values with JavaScript comparison.
- The ordinary node projection repeats at every returned level: scalar codecs,
  model/query/default omit, supported counts/expressions and ordinary nested
  relations. Other eligible recursive slots may occur in that projection.
- The asking recursive slot may not also be spelled inside its own node's
  `select` or `include`. Reject this at admission: there cannot be two
  producers of the same output property. Do not silently strip the explicit key.
- Do not expand ordinary nested aggregates, bulk projections or other clauses
  merely to make this feature appear more uniform.

Example, using an already resolved parent/children schema:

```ts
await db.node.findUnique({
  where: { id: "root" },
  select: {
    name: true,
    children: {
      recurse: { depth: 2 },
      where: { active: true },
      orderBy: { name: "asc" },
      select: { name: true },
    },
  },
});
```

With one active child and grandchild the result is:

```ts
{
  name: "Root",
  children: [{ name: "Child", children: [{ name: "Grandchild" }] }],
}
```

The grandchild's `children` property is absent: depth 2 did not inspect its
children. A child with no matching children would instead contain
`children: []`, because that child is before the cutoff.

### 2.4 Output, cycles and termination

The requested outer slot is present. Use its actual name and resolved
cardinality: object/null for singular, array for collection.

| Situation | Required result |
| --- | --- |
| Numeric cutoff reached | Omit the repeated relation property on that occurrence |
| Natural collection end before cutoff | Present empty array |
| Natural singular end before cutoff | Present null only if the existing slot may be empty |
| Missing target for a required singular slot | Existing result-integrity failure — unreachable: CM002 refuses a required self foreign key, so every admitted singular recursive slot may be empty (the decoder asserts this as an invariant) |
| Exhaustive traversal | Repeated property present on every occurrence |
| FK cycle encountered inside the traversed window | `QueryEngineError` with relation attribution |
| Graph cycle prevention enabled | Skip only an edge revisiting the current active path |
| Graph cycle prevention disabled | Return repeated occurrences until numeric cutoff |

Seed the active path with the outer row. A graph edge back to that root is
therefore pruned by default; with prevention disabled it may return the root
as a new occurrence if it passes the target filter.

Never use a global visited set to eliminate separate paths. A diamond's shared
descendant occurs under both parents; overlapping roots remain independent.
Every returned occurrence owns fresh public objects and mutable scalar values,
including nested graphs, Date, Decimal, JSON and bytes. No shared/cyclic
JavaScript result graph, public path IDs or transport fields.

FK-cycle rejection belongs to this query contract. It does **not** make every
cycle in a self-FK schema invalid, authorize write-time cycle checks, or turn
the relation declaration into a tree declaration.

Inspect no extra hop beyond a numeric cutoff merely to classify a leaf or
discover a later cycle. Exhaustive means complete-or-error, never a truncated
success. Provider recursion/resource limits remain provider failures; do not
change session limits, retry, or silently substitute a numeric cutoff.

Graph output can be exponentially larger than its stored graph, even with cycle
prevention. Compact SQL facts remove redundant transport, not the user's
requested occurrences. Document this explicitly; depth 100 is not a size bound.

### 2.5 Applicable operations and integration

Support every existing placement that already admits an ordinary row relation
projection: eligible find operations, select/include nesting and supported
row-returning mutation projections. Enumerate exact verbs/placements from the
current schemas in RQ-00; “all reads” must not accidentally extend count,
aggregate or groupBy with unsupported relation nodes.

Preserve the existing pre-delete/post-write result lifecycle and ordinary
mutation readback routing. Recursive relation projection is not scalar
RETURNING-safe. Do not force a self-referencing subquery into DML RETURNING or
add a recursion-specific post-write query per root.

Each recursive **projected read** remains one provider statement independent
of data depth. A mutation may already need multiple statements; compare against
its ordinary relation-projection route, not a fictitious one-statement mutation.

Normal lazy execution, read-only build, callback transactions, supported array
preparation, query/statement/observation extensions and cache boundaries remain
in force. D-64's write-build restriction stays unchanged. Complete array
preparation must not start dispatch to discover a recursive projection.

Request extensions already protect `select/include/omit`. They do **not**
gain permission to inject or replace `recurse` inside those protected shapes.
The official default-omit path still composes normally. Add no extension hook,
top-level recursion option, transaction manager or stronger snapshot promise.

## 3. Representation and semantic owners

### 3.1 One finite prepared relation meaning

Extend the **existing prepared relation projection** with normalized recurrence
meaning. Reuse its bound membership, ordinary prepared node projection,
cardinality and emptiness facts.

There are four necessary facts:

1. The oriented relation edge.
2. The ordinary projection of one node.
3. The cutoff and cycle policy.
4. A returned path occurrence, distinct from a database row identity.

Relation-projection admission owns one runtime eligibility reader over the
existing resolved slot and key catalog: require actual self-model identity and
a complete primary key, then consume the resolved storage/cardinality facts.
An inverse singular FK traversal additionally requires the existing edge's
`unique` fact; a collection FK traversal requires the other endpoint to own the
FK; an ordinary junction traversal requires both slots to be collections
(each is an invariant of a resolved ordinary edge, so `recurrence.ts` reads
only self-identity, the edge kind and the complete row key).
Publish admitted recurrence meaning, not another persistent topology flag.

The current `StaticForeignKeyMembership` does not expose partner cardinality.
Extend the compile-time owner beside `StaticResolvedMembership` with a
fail-closed recursion-eligibility projection that reuses its **existing proven
partner** and declaration readers to prove the corresponding cardinality and
complete static primary-key conditions. Do not infer inverse one-to-one from
`kind: "foreignKey", owner: "inverse"` alone, run a second pairing scan, or
claim that the present static view already contains every needed proof.

Do not store a second topology enum where the membership already discriminates
reference/junction, a second nullability answer, evaluated paths in prepared
schema state, or one prepared node per requested depth.

Execution/parsing/cache use Raptor 3's `ProjectionShape`. Schema-only result
introspection still uses `ExpectedResultShape`. These are legitimate views for
different consumers: share the normalized recurrence contract, not a second
policy parser. Type text must not instantiate an adapter or operation context
merely to discover a result shape.

### 3.2 Preferred SQL: compact edge facts, ordinary node projection

Start with this representation; RQ-01 must prove it through actual engine
construction on every mandatory provider before broader consumers are built.

1. Anchor the traversal at the current outer row through its bound membership.
2. Carry complete physical root, predecessor and child identities, plus only
   fields needed to continue that exact edge. Deduplicate repeated column roles.
3. Include depth only for numeric traversal. Bound recursion in SQL.
4. Use `UNION DISTINCT` on bounded edge-depth facts; for exhaustive traversal,
   omit depth and deduplicate stable edge facts until no new facts appear.
5. Keep projected JSON, growing paths, aggregates and sibling ordering out of
   the recursive member. They are not needed to discover adjacency.
6. After closure, produce one transported ordinary projected document per unique
   node per recursive root. Produce ordered adjacency using the shared order
   owner. Measure actual database evaluation work separately; logical reuse does
   not force an optimizer to evaluate a subexpression exactly once.
7. Pack one private carrier into the ordinary relation value. The decoder
   unfolds distinct public occurrences from that carrier.

Conceptual carrier, not public output:

```text
root: complete row key
nodes: [{ key: complete row key, row: ordinary projected node }]
edges: [{ parent: complete row key, child: complete row key, depth?: number }]
```

Numeric carriers require depth; exhaustive carriers omit it. One node may occur
in several edges and at several depths without repeating its transported row.
The same child identity in two output paths still produces two public objects.

The SQL recursion references its CTE once at the top-level FROM. Correlation
inside filters/joins must use joined table aliases and carried operands without
smuggling another recursive reference into a subquery. Recursive relation
projection inside another node is lowered **after** that outer closure, not
inside the recursive member.

All predicates, scalar transport, membership correlation, ordering, qualification
and aliases retain their existing owners. Persistent tables use adapter
qualification; CTE names are statement-local. Carry exact compound tuples, not
joined-string identities or a first-key shortcut. Projected JSON must not be
part of the UNION equality key.

The path-free design relies on each edge's filter/order/node projection being
independent of the path used to reach it. This API admits no path-relative
predicate. If a future feature removes that invariant, revisit that feature's
representation; do not build a path framework now.

Database discovery may collect bounded walk facts that public path-local cycle
prevention later prunes. That is permitted; finite discovery is not evidence
that public output is small. Exhaustive SQL must terminate on cyclic stored
graphs through stable fact deduplication, before public path unfolding.

Extend the existing adapter CTE spelling only as demonstrated necessary, for
example an explicit column list. No provider SQL in query-engine, new driver
capability, handwritten test-only SQL engine or one query per depth.

### 3.3 Provider result boundary and occurrence assembly

One recursive-carrier branch in the existing projection decoder:

- Validate the new provider carrier before exposing or mutating output: complete
  tuple widths, dense carriers, known keys, unique node identities, legal edge
  endpoints, bounded/exhaustive depth form, duplicate facts and reachable
  structure. Reject malformed data through the existing result error model.
- Enforce singular successor cardinality and derived required/optional meaning.
  A key deliberately omitted from public select remains available privately.
- Reuse existing scalar/ordinary projection decoding for node occurrences.
  Transport nodes are borrowed; never mutate or return them as public nodes.
- Use an explicit enter/leave traversal stack for data-depth traversal. Numeric
  depth 1000 and longer exhaustive acyclic paths must not depend on JavaScript
  call-stack depth. Recursion in the finite *projection definition* remains
  ordinary composition.
- Apply the single cutoff/cycle contract from the descriptor; publish each
  occurrence independently. Do not cache mutable decoded documents by row key.

Separate carrier integrity from cycle policy. A cyclic junction carrier is valid;
a cyclic JavaScript carrier or malformed edge is not. Every new guard must name
the distinct failure it alone catches. Do not repeat admitted-input validation
or add a generic hostile-object parser for all internal values.

### 3.4 Public types, schema-only rendering and cache

The existing target thunks and lazy schemas already handle circular model/schema
references and preserve target types. Reuse that foundation. The new result work
is a small compositional extension: infer the ordinary selected/omitted node
through the existing owner, then wrap it recursively under the asking key.
Do not repeatedly resolve the complete model or re-run ordinary node inference
for every returned level. No new lazy mechanism or inference framework is needed
unless a concrete compiler failure demonstrates otherwise.

Static results use a named, finite, key-specific recursive helper around the
ordinary inferred node:

- Numeric/default recursion makes the repeated property optional.
- Literal `depth: false` makes it required.
- Cardinality and singular emptiness come from the existing relation result.
- Widened/optional input remains conservative; do not promise exhaustive shape
  without proof. Numeric depths are not unrolled into tuple-counted types.

Prove this at real public call sites, including fresh/non-fresh inputs, typo
beside a valid key, variables, transactions, extension chains and omitted keys.
A test of an internal type alias alone does not prove the API.

Extend schema-only operation-result rendering with a finite recursive reference
or helper expression. Render valid consumable TypeScript, not an infinitely
expanded object. If the text names an exported helper, ship and test that helper
through the built package. Rendering must require no driver, SQL preparation,
provider execution or client extension instance.

The **live cache path** is `cacheCodec/shapeCodec` in
`raptor3/route/client-route.ts`, not the recovered plan's old parser/cache tree.
Its recursive arm composes `recursiveRelationCodec`
(`result/cache-value-codecs.ts`) from the node's ordinary row codec; the former
refusal is deleted (§3.6). Do not create a second result parser.

Cache traversal must be iterative over recursive data depth, preserve exact
cutoff-key absence, enforce exhaustive-key presence, reject actual cyclic
snapshots, and create fresh occurrences and mutable scalar values on every hit.
A repeated row identity in distinct objects is valid. Do not JSON-clone typed
values or send cache hits through provider scalar parsing.

Canonical admitted args already own cache identity. Equivalent defaults must
normalize to identical keys; depth/policy/filter/projection changes must not.
Do not add a recursive key serializer or new invalidation graph. Preserve and
test the existing invalidation policy and transaction/statement-transform
bypass; do not claim stronger cross-model cache freshness.

### 3.5 File ownership map

Paths below are inspected owners, not permission to resurrect deleted modules.

| Responsibility | Current owner | Bounded change |
| --- | --- | --- |
| Runtime topology / row identity | [relation-resolution.ts](../src/schema/validation/relation-resolution.ts), [keys.ts](../src/schema/model/keys.ts), [storage.ts](../src/query-engine/raptor3/shared/storage.ts) | Consume existing resolved facts |
| Static eligibility | [static-membership.ts](../src/schema/relation/static-membership.ts) | Reuse its proven partner to project supported cardinality and primary-key proof; no second pairing scan |
| Relation admission | [recurrence.ts](../src/validation/relations/recurrence.ts), [relations/index.ts](../src/validation/relations/index.ts), [select-include.ts](../src/validation/relations/select-include.ts) | `recurrence.ts` owns the one normalization (`NormalizedRecurrence`), the runtime eligibility reader and `carriesRepeatedKey`, which the decoder and the cache codec read; the factories thread Source/Key/slot and build the recursive node arms |
| Prepared projection / SQL / decoder | [query.ts](../src/query-engine/raptor3/shared/query.ts) | Extend prepared relation and its ordinary lowering/decoding; replace private root-only slice |
| SQL spelling | [database-adapter.ts](../src/adapters/database-adapter.ts), [standard-sql.ts](../src/adapters/shared/standard-sql.ts) | None was needed (the existing `cte.recursive(…, "distinct")`, `joins.lateral` and `noLimitValue`) |
| Public result inference | [result-types.ts](../src/client/result-types.ts), [types.ts](../src/client/types.ts) (`RecursiveProjectionRootGuard`) | Finite recursive wrapper of ordinary node |
| Schema-only shape / type text | [types.ts](../src/query-engine/types.ts), [result-shape.ts](../src/query-engine/result/result-shape.ts), [typescript-type-renderer.ts](../src/client/typescript-type-renderer.ts) | Same recurrence meaning in the schema-only view |
| Omit composition | [omit.ts](../src/client/omit.ts) and existing relation admission | Preserve one repeated node projection, not expanded depth copies |
| Actual cache codec | [client-route.ts](../src/query-engine/raptor3/route/client-route.ts), [cache-value-codecs.ts](../src/query-engine/result/cache-value-codecs.ts) | Recursive structural consumer of the existing scalar codecs |
| Execution / lifecycle | Existing route, executor, command and operation-context owners | Reuse; change only for a demonstrated placement defect |

`query.ts` is already large. A concern-named composed owner may be extracted
if it owns this finite recurrence lowering/assembly responsibility and removes
a conflict. File size alone does not justify classes, parameter bags or a
second query interpreter. Charge moved code in full.

### 3.6 What must disappear — and why

| Superseded machinery | Replacement invariant |
| --- | --- |
| Independent root-only recursion builder/parser | Recurrence is an ordinary relation projection at every placement |
| Growing SQL path arrays and per-path projected documents | SQL discovers stable edge facts; the decoder owns occurrence paths |
| Carrying every stored scalar through the recursive member | Only complete identities and exact continuation fields are required |
| Silent removal of the asking key from select/include | Admission has already refused two producers of one property |
| Nested recursive-shape rejection | The finite carrier is a normal projection value |
| Blanket recursive cache-shape rejection | The same finite recurrence meaning has a cache consumer |
| Downstream default/topology rediscovery | Admission and resolved membership own those answers once |

Remove a mechanism only after its behavior witnesses pass through the shared
replacement. Retire the private fit entry or make it a thin test-only adapter to
that same implementation; do not retain two production algorithms.

These deletions follow the stated invariants, not a claim that every conceivable
future feature can never require a different representation. Report “no deletion”
for genuinely new behavior rather than inventing cosmetic compression.

## 4. Work units, sequencing and parallel execution

Use **gpt-5.6-sol / high** for implementation and an independent adversarial
review after each completed unit. One production author owns coupled query,
projection and adapter interfaces. The root coordinates, verifies decisive
evidence and performs the final integrated review.

Freeze each shared contract before splitting consumers. Parallelize independent
type/cache/witness work only on disjoint files; assign shared files to one author.
All validation is serial, through the existing shared lock/resource-safe runners,
on source that is not changing. Do not run native lanes beside typecheck or perf.

### RQ-00 — Freeze the contract and actual baseline

**Work**

- Merge/rebase accepted local-closure work through its existing owner; record
  actual source, dependency, runtime and provider identities.
- Map every contract in §2 to a public placement and authoritative witness.
  Enumerate eligible mutations/bulk modes from current validation schemas.
- Inventory private recursive pins whose expectations intentionally change:
  depth zero, cycle pruning, terminal empty keys and root-only result shape.
  Preserve historical receipts; name replacements rather than silently weakening
  assertions.
- Record cost, non-recursive performance controls, current typecheck and registered
  local gate inventory. Node remains **24.21.0** with pinned dependencies.
- Register a new feature evidence ledger under
  `docs/architecture/raptor3-evidence/recursive-query/`; keep failed attempts
  and source-bound receipts separate from review attestations.

**Exit:** independently reviewed behavior/ownership matrix, reproducible baseline,
no unassigned public placement or hidden scope reduction. Old private behavior
is not a candidate-derived oracle for the new contract.

### RQ-01 — Prove SQL placement and check type integration early

The principal feasibility proof is native SQL/projection placement. In parallel,
run a small public-call compile check for the recursive result wrapper over the
existing thunk/lazy and ordinary inference machinery. This is integration
verification, not a separate type-architecture experiment or new work stage.
Production interfaces have one writer. Retain useful production proof code,
charge it, and extend it later.

**SQL/projection proof**

Through actual prepared projection construction and execution, prove:

- Ordinary relation → recursive relation, recursive → ordinary relation,
  and a recursive node with another recursive slot.
- Both FK directions and one junction diamond/cycle, with mapped compound keys
  omitted from public select, multiple roots and sibling ordering.
- Bounded edge-depth facts and exhaustive fixed-point termination.
- One recursive projection SELECT per existing readback placement. Record the
  complete mutation's ordinary statement count separately and compare with
  the same ordinary relation projection. Prove pre-delete versus post-write
  visibility using the existing lifecycle, not assumed DML RETURNING behavior.
- Correlated CTE and nested JSON carrier behavior on SQLite, PGlite, native
  PostgreSQL and native MySQL. Record SQL/binds and actual results.

**Type integration check and shared contract freeze**

Infer the ordinary node once and apply the finite recursive wrapper from §3.4.
Use a small set of actual public-call probes covering selected/omitted fields,
singular/collection cardinality, numeric versus literal exhaustive depth, and
widened options. Check §3.1's eligibility projection at its existing owner.
Require correct inferred results without TS2589 or material compiler-cost
regression; do not numerically unroll depth or add whole-model equality scans.
The full composition matrix remains RQ-05, not a duplicate early campaign.

Freeze one normalized recurrence value/type and its two consumer views: Raptor
`ProjectionShape` for decoder and live cache, `ExpectedResultShape` for
schema-only rendering. Check agreement on depth, cycle policy, asking key and
cardinality. Static client inference shares that semantic contract, not a runtime
descriptor. Add no third result IR.

**Exit:** provider placement is executed and the small public-call type check
passes. Freeze carrier columns, normalized descriptor and consumer
interfaces after independent review. Do not build the full feature atop a
SQLite-only success. A failed representation is repaired/redesigned under §7,
not bypassed with per-depth queries or provider refusal.

### RQ-02 — Admit once and expose the public node

**Work**

- Thread existing Source/Key and resolved slot into select/include factories.
- Implement §3.1's runtime eligibility reader and fail-closed static projection
  at their existing owners, including the inverse-one-to-one and primary-key
  proofs. Add second-direction and non-self controls before downstream work.
- Add eligible recursive-node arms using existing validation primitives and
  select/include/omit normalization.
- Implement the single default owner, eligibility and contradictory-clause
  rejection; preserve non-recursive node types and schemas.
- Ensure both runtime operation admission and schema-only introspection consume
  the admitted form. No downstream payload checks or eager global schema walks.

**Falsifiers**

Depth/default/undefined forms; invalid numbers; forbidden FK cycle flag;
exhaustive graph without cycle prevention; pagination/distinct with recursion;
same asking key twice; unsupported topology; typos beside valid keys in fresh
and variable public arguments.

**Exit:** select and include are the second placements for the same rule;
invalid input reaches neither cache nor provider, and non-recursive input is
unchanged. Review production and type/runtime agreement.

### RQ-03 — Generalize the projection for FK chains and hierarchies

**Work**

- Extend the existing relation projection with the frozen recurrence descriptor.
- Lower compact bounded/exhaustive closure through existing membership,
  predicates, order, aliases and adapter primitives.
- Add the single provider-carrier decoder and iterative occurrence assembly.
- Use ordinary node projection/scalar codecs; implement cutoff absence,
  required-relation integrity and FK-cycle failure at the correct window.
- Replace the private root-only recursion mechanism and migrate its useful
  witnesses to ordinary projection entry points.

**Falsifiers**

Upward/downward and inverse one-to-one; natural ends; depth 1/2/100/1000;
exhaustive acyclic chain beyond 1000 where provider settings permit; closing
cycle inside/outside the window; alternate nullable reference versus primary
identity; omitted/mapped compound keys; independent roots and nested placements.

**Exit:** read and supported mutation-readback consumers use the same projection;
no SQL path payload, copied scalar decoder, repeated input admission or new
command interpreter. Review actual deletions and provider evidence.

### RQ-04 — Absorb junction graphs through the same mechanism

**Work**

Use the existing junction membership orientation as the hop. The carrier,
ordinary node projection and occurrence assembler remain the same owners.
Add only the distinct graph cycle-policy meaning; exhaustive SQL uses the same
stable-edge fixed point.

**Falsifiers**

Both paired directions; diamond; self-loop; cycle to the outer root; converging
paths; disconnected nodes; filtered bridge; default pruning versus bounded
cycle unfolding; exhaustive simple paths. Multiple roots and graph recursion
nested inside an ordinary relation are required second placements.

**Exit:** no graph engine, global result deduplication, topology registry or
per-position walker. Distinct paths have distinct public objects. Transport
growth is measured separately from required output growth.

### RQ-05 — Finish types, schema-only rendering, omit and cache

After RQ-01's interface freeze, independent work may proceed in parallel with
RQ-03/04 on explicitly assigned disjoint files. The completed unit is reviewed
only after its consumers run against the accepted common implementation.

**Work**

- Finish public inference and exact options through current client surfaces.
- Render recursive operation-result types without a driver; verify built-package
  helper exports if used.
- Complete the live recursive cache codec, iterative snapshot/materialization
  and exact cutoff-key integrity.
- Prove default/query/model omit at every level, canonical cache defaults,
  lifecycle bypasses and unchanged extension restrictions.

**Falsifiers**

Literal versus widened exhaustive depth; inline/variable/generic public calls;
0/1/5 extension chains; missing and typoed keys beside real keys; public
transaction client; nested second recursive slot; cold versus cache hit; scalar
freshness after caller mutation; malformed/cyclic snapshots; deep-chain stack
safety in parsing, snapshot and materialization separately.

**Exit:** public result, runtime type text, cached and uncached values agree.
Compare equivalent schema/projection contexts: schema-only rendering does not
gain knowledge of a client's default-omit or extension instance.
No second recursion policy switch, cache key language or provider parser on hits.
Typecheck has **zero diagnostics**, not a historical-error allowance.

### RQ-06 — Qualify composition and adversarial generated behavior

**Work**

- Exercise all RQ-00 placements through the shipped client, including supported
  mutations, both upsert arms, deletion result timing, arrays and borrowed
  callback transactions.
- Confirm one projection statement irrespective of depth, isolated aliases and
  carriers for repeated slots, complete preparation before array dispatch, and
  no additional admission/transform calls.
- Preserve original provider failure identity and existing write-outcome
  reporting. A result error after acknowledged work must not claim rollback.
- Extend the existing deterministic harness with an independent in-memory graph
  oracle. The oracle must not call candidate membership, SQL or decode owners.

Run **100 fixed seeds for each of three profiles**—singular FK, collection FK,
junction graph—on SQLite and native PostgreSQL/MySQL. Reuse the same saved cases
across providers; use simple numeric ordering in the common oracle and separate
native pins for collation/null/codec distinctions. PGlite runs the focused
matrix and existing recursive lanes. These feature seeds are not renamed G3
campaign receipts and need no new test framework.

**Exit:** all 900 provider/profile seed cases plus focused PGlite and composition
pins pass with replayable evidence. Malformed-result/cache boundaries use
dedicated falsifiers, not randomized happy-path coverage. The independent
review challenges the oracle, cross-position reuse and failure timing.

### RQ-07 — Freeze, measure and close the co-release gate

**Work**

1. Root reviews integrated code and unit reviews before expensive closure runs.
2. Freeze production, harness, dependency and provider identities.
3. Run the complete **current local release inventory**, including all newly
   registered feature gates, typecheck, package/build probes and required native
   suites. Re-run recursive seeds/replay against this exact integrated identity.
   Reuse intact historical receipts only as history, never final-source proof.
4. Measure cost and performance under §6. Re-run affected non-recursive decoder,
   preparation, cache and write controls through the existing quiet protocol.
5. Update the central plan, relevant architecture guides, public feature docs,
   examples, refusal map and changelog. Replace “private only/deferred” claims
   about this feature; retain dated historical decisions.
6. Record a source-bound local release verdict and independent review. Make a
   task-scoped local Conventional Commit containing only audited work, with the
   accepted engine-closure ancestry. Do not push, open a PR or publish.

**Exit:** both local engine closure and this full public feature pass on one
source identity. No partial feature advertised as complete, source-only claim
of bundle improvement, or unmeasured hosted-provider promise.

## 5. Required evidence matrix

| Concern | Mandatory falsifiers |
| --- | --- |
| Input boundary | All depth/default/undefined forms; invalid depth and cycle combinations; extra keys; relation eligibility; no provider/cache work on invalid input |
| Identity/correlation | Complete compound primary and alternate reference tuples; mapped columns; namespaces; nullable references; both junction orientations |
| Occurrence ownership | Diamond, overlapping roots, repeated slots, self-loop, independent nested recursive projection; fresh objects/scalars per occurrence |
| Result semantics | Cutoff absence versus natural empty; singular required slot refused by CM002 before any projection; exact relation name/cardinality; node omit/count/ordinary relation composition |
| Cycle/window rules | FK error only when closing edge is in the traversed window; graph path-local pruning; numeric unfolding; exhaustive termination |
| Ordering/filter | Filter prunes descendants; each parent's order; root pagination unchanged; ties/nulls/provider collation; no JS substitute |
| Carrier integrity | Missing/duplicate nodes, dangling/unreachable edges, wrong tuple width, mixed/invalid depth, duplicate edge fact, singular multi-successor, private-field collisions |
| Codec breadth | Every admitted scalar/list codec in ordinary nodes; decimal, DateTime, bigint, bytes, JSON, vector and GeoPoint on supported local tiers; same freshness as ordinary output |
| Cache | Equivalent defaults/same key; differing policy/different key; detached hits, stale refresh, invalidation controls, transaction/statement-transform bypass, malformed snapshot |
| Type surface | Fresh/non-fresh public calls; typo alone and beside a real key; nested levels; static eligibility; widened depth; compile rendered type text from built package |
| Execution placement | Read/build, supported row-returning mutations, pre-delete/post-write snapshots, arrays, callback transactions, concurrency, original errors/progress |
| Resource behavior | Deep-chain stack safety; exhaustive provider limit failure without partial success; SQL/bind count independent of depth; controlled graph fan-out |

For the MySQL limit-failure pin, a test-owned isolated session may temporarily
lower its limit and restore it through fixture cleanup. This grants the engine
no permission to modify provider settings or retry the failed traversal.

Use real SQLite and native PostgreSQL/MySQL execution for SQL/transaction
claims. Adapter snapshots and a capability-forced transport cannot qualify those
claims. Provider-supported codec tiers stay explicit; do not silently weaken
existing GeoPoint/vector availability to get a green recursive suite.

Register new tests in the existing manifests/workspaces. Verified current entry
points include:

```sh
node scripts/run-raptor3.mjs g3p05-recursive-read-fit
node scripts/run-raptor3.mjs g4-read-recursive-fit
node scripts/run-raptor3.mjs g4-read-envelope-pg-contracts
node scripts/run-raptor3.mjs g4-read-envelope-mysql-contracts
node scripts/run-typecheck.mjs
pnpm package:build
```

These lanes now carry the feature. `g4-read-envelope-{pg,mysql}-contracts` run
`provider-sql-native` and `campaign-native` beside `read-envelope-native`. The
two fit modes run the migrated pins through the public projection. The
deterministic suites run in the fixed lane, and `provider-sql-pglite` is an
isolated credential-free PGlite stage. `scripts/raptor3-manifest.mjs` owns
every registered cell count (the feature's suites in its `RQ*_COUNTS` groups).
Discover and record the current full release manifest at RQ-00; do not invent
command names or run stale historical campaigns repeatedly after every edit.

## 6. Cost, work and performance

Record before/after **engine core**, broader charged/shared production, public
type/validation/cache additions, tests and evidence separately. Measure
token-bearing LOC, parser tokens, source bytes and the same package bundle
imports used by the local release benchmark. Count moved code and retained
proof code; separate genuine compression from retiring the old private slice.

There is no defensible fixed LOC promise before RQ-01. This is a new public
feature, not free reuse. Each unit records:

1. Necessary new semantic rule and its single owner.
2. Owners/exceptional paths changed.
3. Actual deletion or “no deletion”.
4. Whole incremental cost.
5. Cross-position witness and reviewed result.

Seek net reuse and bounded new meaning, not shortened names or a tiny SQL
builder hiding a large new compiler. Growth requires an explicit ownership
review; no arbitrary percentage veto and no automatic “future payoff” excuse.

Measure depths **1, 2, 8, 32**, then long chains at 100/1000 and a supported
exhaustive path beyond 1000. Measure widths 1/2/8/32 at controlled shallow depth,
and graph diamonds/cycles at controlled output size. Do not accidentally request
a width-32/depth-32 result as a benchmark.

Record SQL statements, SQL/bind bytes, transported nodes/edge facts, projected
documents, returned occurrences, parse/cache allocation, peak memory and CPU.
Use external profiling or explicitly labeled source-derived transient counts;
do not add a production allocation-instrumentation API to measure this feature.
Separate database facts from public output:

- Numeric SQL transports distinct reachable edge-depth facts, not every path.
- Exhaustive SQL transports distinct reachable edge facts.
- Node projection is shared per recursive root in the carrier.
- Public construction necessarily scales with returned occurrences and fields.
- Scalar decoding/fresh allocation per public occurrence is not automatically
  redundant work; mutable public values may not alias.

Use the accepted resource ceilings and performance protocol. A repeatable
regression in ordinary non-recursive preparation/decoding or a required release
budget blocks acceptance until repaired or explicitly accepted; do not redefine
a budget from the new measurement. No claims of runtime, allocation or bundle
improvement without their corresponding measurement.

## 7. Acceptance, bounded repair and stop conditions

This plan chooses the public semantics and preferred representation. Implementers
do not have open product choices to settle by opportunistic branch behavior.

Pause the affected unit for Arnaud only when:

- Two repairs fail on the same minimized defect, or two representation attempts
  fail to satisfy the frozen seam. Preserve consumed budgets across units.
- Passing requires a new interpreter, changed mutation visibility/authority,
  expanded retry, per-depth/per-root side queries, missing public scope, new
  blanket provider refusal or a changed compatibility contract.
- Required local provider evidence cannot run. Mark qualification incomplete;
  do not substitute snapshots or hosted fixtures.

A further redesign requires a decision; renaming a class or unit does not
reset the budget. Preserve the accepted engine and failed feature evidence.
Do not integrate a half alternative or erase other work.

**Done means all of the following:**

- Full §2 scope works through ordinary public relation projections.
- Chains, hierarchies and graphs share prepared projection, hop lowering,
  node decoding and occurrence assembly rather than per-topology interpreters.
- Types, schema-only rendering, omit and the live cache path agree.
- Superseded private machinery in §3.6 is removed without equivalent duplication.
- Failure identity/timing, transaction ownership and acknowledged progress remain
  intact; exhaustive/provider failures never masquerade as partial success.
- Required local-provider, fixed, generated, type, package and cost/performance
  evidence identifies the final merged source and actual harness.
- Both engine closure and recursion have independent acceptance and root review.
- Documentation accurately states support and limits; publication remains a
  separately authorized action.

## 8. SQL constraints checked while preparing this plan

These facts motivate early execution gates, not claims that the proposed SQL is
already qualified:

- SQLite requires one top-level recursive-table reference and excludes aggregate
  and window functions from the recursive term. This supports keeping adjacency
  discovery separate from node projection.
  [SQLite WITH documentation](https://sqlite.org/lang_with.html)
- MySQL infers CTE column types from the anchor, constrains recursive-member
  placement, and defaults its recursive-iteration ceiling to 1000. Prove column
  types and correlated placement natively; never translate that limit into a
  silent ORM cutoff.
  [MySQL 8.4 WITH documentation](https://dev.mysql.com/doc/refman/8.4/en/with.html)
- PostgreSQL's recursive UNION removes previously seen full rows. A changing
  depth/path prevents that from being a stable exhaustive closure key.
  [PostgreSQL WITH documentation](https://www.postgresql.org/docs/current/queries-with.html)
- SQLite does not promise deterministic visibility for a RETURNING subquery
  reading the table being mutated. Preserve the current ordinary relation
  readback lifecycle instead of inventing direct recursive RETURNING.
  [SQLite RETURNING documentation](https://sqlite.org/lang_returning.html)

The chosen compact representation and owner mapping are design conclusions from
these constraints **and inspected repository code**, not prescriptions from
the database documentation.

### Sources

- [SQLite WITH](https://sqlite.org/lang_with.html)
- [MySQL 8.4 WITH](https://dev.mysql.com/doc/refman/8.4/en/with.html)
- [PostgreSQL WITH](https://www.postgresql.org/docs/current/queries-with.html)
- [SQLite RETURNING](https://sqlite.org/lang_returning.html)
