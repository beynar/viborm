# Recursive Self-Relation and Graph Traversal Plan

**Status:** implementation-ready

**Rewritten:** 2026-08-31

**Target:** before the V1 release candidate

This document replaces the old recursive-query sketch. The public API idea
survives; its former implementation does not. The old design predates the
unified relation resolver, the compiled result parser, the six-capability
extension chain, official cache result codecs, namespaces, exact decimals, and
GeoPoint transport.

## 1. Outcome

Add one recursive projection to an ordinary self-referencing collection. It
serves both hierarchy storage and graph storage without adding another relation
factory or a graph-specific direction language.

An inverse collection over a child-held foreign key produces a hierarchy:

```ts
const category = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  name: s.string(),

  parent: s.toOne(() => category)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => category),
});

const tree = await db.category.findUnique({
  where: { id: "root" },
  include: {
    children: {
      recurse: true,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    },
  },
});
```

VibORM emits one typed statement containing a recursive CTE. It returns a
nested public hierarchy, not a flat CTE result and not an N+1 sequence.
Here `recurse: true` means the default depth of 100, not unbounded traversal.

A self junction produces a directed graph traversal. The asking relation slot
already names the direction:

```ts
const person = s.model({
  id: s.string().id(),
  name: s.string(),
  following: s.toMany(() => person).name("Follows"),
  followers: s.toMany(() => person).name("Follows"),
});

const network = await db.person.findUnique({
  where: { id: "alice" },
  include: {
    following: {
      recurse: { depth: 3 },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    },
  },
});
```

For the graph form, `recurse: true` and `recurse: {}` are equivalent safe
defaults: depth 100 with path-local cycle prevention. Callers override either
policy independently, for example
`recurse: { depth: 20, preventCycles: false }`.

`following` walks the resolved junction from that slot toward its paired target
side. Asking through `followers` walks the same physical table in reverse. No
`direction`, `incoming`, `outgoing`, or symmetric option is introduced.

The feature introduces no relation factory, graph relation kind, direction
selector, public path/edge carrier, query manager, public CTE object, driver
wrapper, cache-key language, or second result parser.

## 2. Final public contract

### 2.1 Eligible relation

`recurse` exists only when all of these common facts are proven:

1. the slot was declared with `s.toMany()`;
2. its target is the same model object as its source;
3. the schema-wide resolver paired it through an ordinary model-target edge;
4. the model has a complete primary row key when the query is compiled; and
5. the resolved edge is one of these two topologies:
   - **hierarchy**: a foreign-key edge owned by the other endpoint, so each
     returned child has at most one parent through this relation;
   - **graph**: a junction edge whose paired endpoints are both self-targeting
     collection slots.

In normal schema language, this is the collection side of:

```ts
parent: s.toOne(() => node).fields("parentId").references("id"),
children: s.toMany(() => node),
```

Literal relation names, mapped columns, compound foreign keys, compound primary
keys, and namespaces do not change eligibility.

The following do not receive `recurse` at runtime in V1:

- ordinary `s.toOne()` slots;
- variant-target relations, including one-variant maps;
- ordinary inverses bound to variant storage;
- a relation targeting another model; and
- an unresolved or ambiguous runtime topology.

A runtime-valid topology whose declaration is too broad for TypeScript to prove
is different: the resolved runtime schema accepts `recurse`, while the public
static surface fails closed and does not expose the property. Runtime must not
pretend to reproduce TypeScript's proof.

The two accepted topologies are derived from the existing resolved edge. No
declaration flag says "tree" or "graph", and no consumer rescans for an
inverse. A singular chain still needs a different terminal contract at a depth
cutoff and remains outside this feature.

### 2.2 Accepted forms

```ts
type HierarchyRecurse = true | { depth?: number | false };
type GraphRecurse =
  | true
  | {
      depth: false;
      preventCycles?: true;
    }
  | {
      depth?: number;
      preventCycles?: boolean;
    };
```

- On either topology, `recurse: true` and `recurse: {}` select the defaults and
  normalize to an effective depth of 100. Literal true never means unbounded
  traversal.
- The object form returns at most the effective depth in related levels, where
  direct related records are level 1. An omitted or explicitly `undefined`
  `depth` normalizes to `100`.
- `depth: false` removes the ORM cutoff. On a hierarchy it traverses until no
  reachable child remains. On a graph it unfolds every reachable simple path,
  so path-local cycle prevention is mandatory.
- On a graph, both default spellings also normalize `preventCycles` to `true`.
- Graph `preventCycles` defaults to `true`. It is path-local: an edge to an
  identity already present on that occurrence's active path is skipped, while
  the same target reached through two different acyclic paths remains present
  twice. `preventCycles: false` retains cyclic walks through the effective
  depth.
- Hierarchies do not expose `preventCycles`: a hierarchy cycle is corrupt data
  and fails when encountered inside the effective traversal rather than being
  hidden or admitted by query policy.
- A numeric `depth` must be a positive safe integer from 1 through 1000. It is
  rejected, never clamped. `Infinity` remains invalid; `false` is the one
  explicit, serializable unbounded spelling.
- Graph `{ depth: false, preventCycles: false }` is rejected through public
  types and runtime validation because it denotes infinitely many walks on a
  cyclic graph.
- An explicitly `undefined` recurse property is absent, matching the operation
  object's existing normalization rule. Inside an object, explicitly
  `undefined` options receive their defaults. Top-level `recurse: false` is
  invalid; only the nested `depth: false` spelling removes the cutoff.

The recursive node also accepts:

- `where`;
- `orderBy`;
- `select`;
- `include`; and
- `omit`.

It does not accept `take`, `skip`, `cursor`, or `distinct`. Those options are
per-parent windows. Correct portable lowering needs partitioned window
semantics, including cursor order and distinct-before-window behavior. Global
CTE pagination would be a different and incorrect operation.

The ordinary non-recursive relation node keeps all existing options.

### 2.3 Exact semantics

`where` is applied to every hop, including direct children. A rejected node is
not returned and its branch is not traversed.

`orderBy` is applied independently to each parent's child array. It uses the
existing order compiler, database collation, null ordering, relation ordering,
and stable row-key tie-breaker. The database supplies sibling order; JavaScript
does not reimplement database comparison.

`select`, `include`, and `omit` describe every returned node. Nested ordinary
and recursive projections remain valid. The asking recursive relation key is
reserved by `recurse`: spelling that same key inside the node's own `select` or
`include` is rejected, because two producers cannot own one output property.

In a bounded traversal, occurrences before the cutoff have the recursive
relation key. In an exhaustive `depth: false` traversal, every occurrence has
it. A natural leaf contains an empty array:

```ts
{
  id: "leaf",
  children: [],
}
```

An occurrence exactly at the cutoff omits the key, which distinguishes “not
loaded beyond this depth” from a fully evaluated child collection:

```ts
// recurse: { depth: 2 }
{
  children: [
    {
      id: "level-1",
      children: [
        { id: "level-2" }, // children was not loaded past the cutoff
      ],
    },
  ],
}
```

If a hierarchy branch or graph walk ends before the cutoff, its last occurrence
contains the asking relation key with `[]`.

When graph cycle prevention rejects a closing edge, that edge and its repeated
target occurrence are omitted entirely. VibORM does not return a truncated
repeat or a cycle marker. Consequently, graph `[]` means “no child admitted by
the recursive `where` and active-path cycle policy,” not necessarily “no
physical outgoing membership.”

Graph recursion returns a **walk unfolding**. One public object represents one
record occurrence along one root-to-record path. If two paths reach the same
database row, that row appears as two fresh objects. By default, an edge that
would revisit an identity on the current active path is omitted. With
`preventCycles: false`, the earlier row appears again at the later level and
traversal continues until the effective cutoff. Both modes preserve acyclic
path multiplicity without creating shared or cyclic JavaScript objects and
without inventing a canonical parent.

The public result type follows the query form without numerically unrolling a
depth: bounded/default traversal has an optional recursive key, while literal
`depth: false` has a required recursive key at every occurrence. A widened or
unprovable depth remains optional-safe.

On a row-returning mutation, recursion runs at the same existing projection
stage as an ordinary nested include and inherits that operation's documented
snapshot visibility. It does not invent a separate before/after graph snapshot
or an extra provider round trip; PlanetScale/MySQL retains its existing refetch
route where applicable.

### 2.4 Cycles and provider limits

A self foreign key can contain corrupt cyclic data even though its intended
shape is a hierarchy. A self junction can contain cycles by design. Those are
different truths and the result descriptor must preserve the distinction.

- The strict hierarchy-carrier validator detects a repeated identity on an
  active path before parsing public rows and throws one `QueryEngineError`
  naming the relation whenever the cycle-closing edge lies within the traversed
  window. Data beyond a numeric cutoff remains intentionally unknown;
  `depth: false` examines the whole reachable closure.
- In the public graph result, the walk path distinguishes occurrences.
  SQL transports compact bounded edge-depth or exhaustive edge facts, and the
  parser applies the normalized path-local cycle policy while reconstructing
  occurrences without a public or provider path token. It never uses a global
  visited set.
- Every bounded traversal stops in SQL at the effective depth. Data beyond the
  effective cutoff was not queried and does not affect the result.
- `depth: false` has no ORM cutoff but still obeys provider recursion limits.
  Such a limit surfaces as an operation failure, never a partial result.

MySQL's default recursive-iteration limit is 1000. Numeric traversal defaults
to 100 and is capped at 1000. `depth: false` may therefore fail on a reachable
chain whose provider evaluation exceeds that limit; “unbounded” means no ORM
cutoff, not immunity from provider limits.

### 2.5 Self-junction graph semantics

A self many-to-many relation's resolved junction topology describes a directed
graph. One node can have several predecessors and the same node can be reached
through several paths. Direction belongs to the asking relation slot: the
existing junction binder orients `membership.source` from that slot and
`membership.target` toward the related row. Canonical physical side order is
not query direction.

V1 settles the graph contract as follows:

- traversal follows the asking slot's already-resolved source-to-target
  orientation;
- the public result is a nested walk unfolding, not a unique-node closure, edge
  list, path list, or shared object graph;
- repeated rows appear once per path as fresh objects;
- cycles are valid graph data; they are skipped per active path by default and
  repeat records through the effective depth only when
  `preventCycles: false`;
- with `depth: false`, cycle prevention is mandatory and the result exhausts
  every simple path rather than every possible walk;
- `where` filters the target node at every hop and prunes that walk branch;
- `orderBy` orders each occurrence's outgoing target collection;
- the ordinary junction has no public edge model or payload, so V1 exposes no
  edge projection or edge predicate; and
- `take`, `skip`, `cursor`, and `distinct` remain unavailable because their
  correct meaning is a per-occurrence graph window.

The root record is not inserted into its own relation merely because traversal
started there. With the default cycle policy it cannot reappear on the same
path. With `preventCycles: false`, it appears inside the nested result only if a
traversed path returns to it through a real junction membership **and** it
passes `where` as the target of that hop. The root query's own predicate is not
a permanent exemption from the recursive relation predicate.

## 3. Scope and non-goals

### In scope

- recursive relation nodes in both `select` and `include` positions;
- bounded and exhaustive hierarchy traversal over an inverse child-held self
  foreign key;
- bounded graph walks and exhaustive simple-path traversal over an ordinary
  paired self junction;
- all current read operations;
- every row-returning mutation projection on which ordinary relation includes
  already work;
- compound and mapped keys;
- default omit, exact scalar parsing, nested relations, relation counts,
  `_distance`, and aggregates already legal inside a nested node;
- PostgreSQL, MySQL, and SQLite adapter families;
- cache snapshot/materialization;
- operation-result TypeScript rendering; and
- request, query, statement, observation, and transaction composition.

### Not in scope

- recursive writes;
- arbitrary CTE composition;
- an unbounded graph traversal that permits cyclic walks;
- flat unique-node closures, edge/path result documents, or shared/cyclic
  JavaScript object graphs;
- junction-edge projection or filtering;
- polymorphic recursive transitions;
- singular ancestor/lineage recursion;
- breadth limits or per-parent pagination;
- shortest path, path return values, cycle markers, search order controls, or
  graph mutation;
- raw SQL result shaping; and
- migration or schema changes.

## 4. Current owners and required changes

| Concern | Existing owner | Required change |
|---|---|---|
| Runtime topology | `src/schema/validation/relation-resolution.ts` | Project eligible recursive storage as the existing `"foreignKey"` or `"junction"` discriminant from `ResolvedSlot`; never invoke a target getter |
| Static topology | `src/schema/relation/static-membership.ts` | Reuse exact model identity, row-key proof, and `StaticResolvedMembership` to project the same existing discriminants |
| Operation schemas | `src/validation/relations/index.ts`, `select-include.ts` | Thread `Source`, `Key`, and the resolved slot; add the recursive node arm |
| Physical traversal | `relation-data-builder.ts`, `relation-traversal.ts` | Reuse the already-oriented ordinary or junction traversal for anchor and recursive hops |
| Include compilation | `include-builder.ts`, `select-builder.ts` | Route a validated recursive node to one recursive include builder |
| Dialect SQL | `DatabaseAdapter.cte`, `createCteBuilders()` | Admit an explicit CTE column list; keep all spelling in the adapter |
| Result contract | `ExpectedRelationResultShape`, `result-shape.ts` | Carry one finite recursive descriptor beside the normal node shape |
| Relation parsing | `relation-result-parser.ts` | Add one strict recursive-carrier branch using the compiled row parser |
| Cache values | `cache-result-codec.ts` | Compile the public hierarchy/walk unfolding lazily from the same result descriptor |
| Static client result | `client/result-types.ts` | Wrap the normal node projection in one key-specific recursive result helper |
| Runtime type text | `client/typescript-type-renderer.ts` | Render the same helper without infinitely expanding `TypeNode` |
| Documentation | client docs and V1 records | Document the API and remove “deferred” claims after it ships |

No cache-key, instrumentation, driver, migration serializer, or relation
declaration change is planned.

## 5. Implementation program

### Phase 0 — prove the SQL placement first

Before touching public types, build a throwaway adapter-level prototype of the
exact intended statement shape and execute it on SQLite3, PGlite, and MySQL2.
It must prove:

1. a correlated `WITH RECURSIVE` can live inside the scalar relation subquery;
2. an explicit CTE column list works with compound values;
3. the recursive member references the CTE exactly once at top level;
4. an ordinary self-junction traversal can start from either public slot and
   uses the binder's already-swapped source and target sides;
5. `UNION` deduplicates bounded `(root, parent, child, depth)` facts and
   exhaustive `(root, parent, child)` facts without erasing a diamond or
   admissible public path;
6. JSON aggregation happens outside the recursive member;
7. one carrier can contain unique node rows plus ordered edge facts;
8. an outer row lookup and nested scalar subquery are accepted;
9. requested sibling ordering survives the derived-table aggregation;
10. bounded and `depth: false` hierarchy, chain, diamond, self-loop,
    two-node-cycle, and strongly connected graph fixtures produce the specified
    carrier and terminate;
11. adding the exhaustive arm does not alter the bounded prototype's statement
    or behavior for the same normalized numeric input; and
12. the same expression works on every row-returning mutation projection that
   currently accepts a relation include.

This is a gate. If one mandatory dialect rejects the placement, amend this plan
before adding a side query, operation-specific fallback, or capability flag.
Adapter snapshots alone are not evidence.

PlanetScale/Vitess is not a Phase 0 blocker: recursive CTE support is still
documented as experimental and SELECT-only. It receives a hosted contract before
VibORM makes a production support claim.

### Phase 1 — eligibility and operation schema

#### 1.1 One runtime answer

Place one derived reader beside `ResolvedSlot` that returns `"foreignKey"`,
`"junction"`, or `undefined`. It reads only resolved facts:

- the asking slot has cardinality `many`;
- both endpoint sources are the same model object;
- a `foreignKey` edge is eligible only when its owner is the other endpoint;
  and
- a `junction` edge is eligible only when its paired endpoint also has
  cardinality `many`.

These are existing storage discriminants, not a new tree/graph representation.
“Hierarchy” and “graph walk” remain documentation terms derived from them.

Do not read `ResolvedJunctionTopology.sourceIsFirst` as graph direction. The
asking `(model, field)` slot already orients the junction when it is bound; its
inverse field swaps the same physical sides.

The schema registry already has the exact source model, field key, relation,
and resolved slot. Pass those facts into the current select/include factories.
Do not add `isSelfReferencing()` to the declaration layer and do not call
`state.target.getter` or a raw lazy getter.

At compile time, add the corresponding fail-closed projection beside
`StaticResolvedMembership`. Reuse its existing exact `Equal` model test and
mutual-degree proof. A proven inverse-owned foreign key projects
`"foreignKey"`; a `StaticJunctionMembership` projects `"junction"`. Add one
fail-closed row-key proof over the source model's scalar ID or compound ID; a
self relation without a statically complete row key receives no `recurse`
property. The junction arm retains the mutual-`many` proof already required by
`StaticJunctionMembership`. A broad or otherwise unprovable relation also
receives no property, even when equal dynamic names later resolve at runtime.

#### 1.2 One nested projection builder

Refactor the existing to-many nested-node builder only enough to share its
projection core:

```text
shared:               where, orderBy, select, include, omit
ordinary:             take, skip, cursor, distinct
hierarchy recursive:  recurse: true | { depth?: number | false }
graph recursive:      recurse: true
                      | { depth?: number, preventCycles?: boolean }
                      | { depth: false, preventCycles?: true }
```

The ordinary arm remains byte-for-byte equivalent after normalization. The
polymorphic collection arm continues using only the ordinary node. Do not copy
the omit desugaring, select/include exclusivity check, default projection, or
target-schema lookup.

Make all three public type arms structurally disjoint: the ordinary arm refuses
`recurse`, and both recursive arms refuse `take`, `skip`, `cursor`, and
`distinct` with `never`-style exclusions that also catch non-fresh variables.
Do not rely on union excess-property checking; a union otherwise accepts a bag
whose keys are distributed across different arms.

Build the recursive arm only for an eligible resolved slot. Remove the asking
relation key from its nested `select` and `include` schemas through the current
schema projection primitives. This gives the collision rule one owner at the
untrusted-input boundary.

The hierarchy recurse schema accepts only:

```ts
true
{ depth?: integerBetween(1, 1000) | false }
```

The graph schema accepts:

```ts
true
{
  depth?: integerBetween(1, 1000)
  preventCycles?: boolean
}
{
  depth: false
  preventCycles?: true
}
```

The validated output normalizes literal `true`, `{}`, and omitted or explicitly
undefined `depth` to effective depth 100 on either topology. Graph omission or
explicit undefined also normalizes `preventCycles` to true. This validation
boundary is the one default owner; the query compiler, result descriptor,
cache key, and runtime type renderer consume the normalized values. Supplying
`preventCycles` on a hierarchy must fail there. No query-engine guard repeats
that refusal.

The same boundary preserves `depth: false` rather than defaulting it and refuses
the graph combination `depth: false, preventCycles: false`. It rejects
`Infinity`; no downstream consumer interprets a numeric sentinel.

It rejects promises, arrays, unknown members, accessors that throw, non-safe
integers, and extra JavaScript arguments through existing validation behavior.
No downstream defensive copy of this validation is added.

### Phase 2 — one recursive include compiler

Add `src/query-engine/builders/recursive-include-builder.ts`. It is a cohesive
branch of the existing include compiler, not a second read engine.

`buildInclude()` performs one own-property check on the already validated node.
When `recurse` is absent, its current path is unchanged. When present, it calls
the recursive builder with the same `QueryScope`, `RelationRef`, and subquery
nested-selection callback.

#### 2.1 Identity and continuation

Use existing facts for their current jobs:

- `ModelKeyCatalog.rowKey` is the stable node identity used for assembly and
  cycle detection. A missing row key fails before SQL is rendered.
- the bound foreign-key membership's ordered referenced tuple is the
  continuation state needed to traverse from the current CTE row.
- a bound junction membership's `source` and `target` sides are the already-
  oriented continuation from the asking slot to its related row.

Do not assume an `id` field, a single key member, declaration column names, or
that the referenced tuple equals the primary key. Deduplicate overlapping
fields while preserving each owner's order. Resolve every physical name through
`getColumnName()`.

#### 2.2 CTE shape

Allocate the CTE name and aliases through the existing query scope. Persistent
tables use `adapter.identifiers.table()` and therefore retain namespace
qualification. The statement-local CTE name and its columns use adapter
identifier escaping and never receive a namespace.

The CTE carries only comparable physical values:

- current child row-key members;
- current continuation members;
- predecessor row-key members, which are the edge's parent identity;
- the outer root row-key members; and
- depth only for a numerically bounded traversal.

It does not carry selected row JSON, JSON scalar columns, relation carriers, or
the public projection. This keeps aggregates and nested subqueries out of the
recursive member and avoids `UNION` equality over provider JSON types.

Build the anchor with `buildRelationTraversal()` from the outer root alias. The
CTE exposes every current-node field needed for the next hop under that field's
exact mapped physical name: the complete row key plus the foreign-key
continuation tuple, deduplicated in model order. Predecessor, root, and depth
copies receive collision-free private CTE column names outside that mapped
field set. The ordinary correlation owner can therefore address the CTE alias
exactly as it addresses a model alias; do not pass arbitrary semantic column
names and hope they match.

For the recursive hop:

1. a foreign-key hierarchy calls `buildRelationTraversal()` with the CTE alias,
   whose mapped current-field projection satisfies its correlation contract;
2. a junction graph binds the anchor traversal once, then gives that exact
   already-oriented membership to `buildMembershipJunctionTraversal()` with
   the CTE alias. It does not reclassify the relation or rederive direction.

Both compile the same validated `where` through `buildWhere()`. The recursive
term refers to the CTE once in its top-level `FROM`, satisfying MySQL and SQLite
restrictions.

- A numeric traversal carries `depth`, adds `depth < effectiveDepth`, and uses
  `UNION` over `(root, parent, child, continuation, depth)`.
- A `depth: false` traversal omits depth and uses `UNION` over
  `(root, parent, child, continuation)`. Deduplicating the finite reachable
  edge facts makes SQL terminate even for corrupt hierarchy cycles or valid
  graph cycles; the parser then applies the topology's cycle contract.

In exhaustive mode, depth is absent from the CTE column list, anchor, recursive
member, union key, carrier, and predicates. Carrying a changing depth would
defeat deduplication and make cyclic input non-terminating. Per outer root, the
CTE emits at most one fact for each reachable physical edge and deterministic
continuation state, regardless of public path count. Anchor and recursive
`where` remain identical, so a filtered target never enters the reachable
closure and its branch cannot continue.

The graph CTE deliberately deduplicates one physical edge at one depth in
bounded mode and one physical edge overall in exhaustive mode, even when
several paths reached its parent. The parser later applies that adjacency fact
to every public parent occurrence. SQL work therefore grows with reachable
edge-depth facts or reachable edge facts rather than with the possibly
exponential number of public paths. Diamonds remain visible in every mode.
Cycle-producing facts stay available for the parser to skip by active path or,
only in bounded mode, unfold when `preventCycles: false`.

The SQL CTE does not carry a path and therefore does not stop early merely
because the public default will prune a cycle. It may produce compact
edge-depth facts through the effective depth—100 by default—even when public
materialization stops that walk earlier. This bounded over-fetch is the
deliberate price of avoiding path-sized SQL state and exponential provider
rows; measure it in the cycle benchmarks.

For `depth: false`, the same path-free CTE collects each reachable adjacency
fact once. The parser, not SQL, expands those facts into every simple public
path. Provider work remains proportional to the reachable graph; public output
can still be exponential and is an explicit caller opt-in.

This compression is sound because every V1 predicate, projection, and ordering
expression is a function of the current node and query arguments, never of the
path used to reach it. Path-local cycle prevention only discards an otherwise
valid adjacency while materializing an occurrence; it needs no additional SQL
fact. A future path-sensitive predicate, edge predicate, or path ordering would
instead change which facts must be queried and would invalidate the proof
without a separately reviewed representation.

#### 2.3 Public row carrier

Outside the recursive CTE, join each edge back to the target model by the
complete row key. Build the requested node JSON through the existing
`BuildNestedSelection` callback. This preserves:

- default and query-local omit;
- bigint and blob JSON transport;
- exact decimal conversion;
- Date/DateTime conversion;
- JSON validation;
- GeoPoint transport and `_distance`;
- relation counts; and
- nested ordinary or recursive relations.

The private aggregate is one normalized carrier for both topologies:

```ts
type RecursiveEdge =
  | {
      parent: readonly unknown[];
      child: readonly unknown[];
      depth: number;
    }
  | {
      parent: readonly unknown[];
      child: readonly unknown[];
    };

type RecursiveCarrier = {
  root: readonly unknown[];
  nodes: readonly {
    key: readonly unknown[];
    row: Record<string, unknown>;
  }[];
  edges: readonly RecursiveEdge[];
};
```

`root`, `key`, `parent`, and `child` use the same existing scalar-to-JSON
transport for each row-key field. Extract that transport rule from
`select-builder.ts` into the existing `scalar-transport.ts` owner rather than
reimplementing bigint, blob, decimal, or point cases.

The `nodes` query first selects distinct row keys from the CTE, then joins those
keys back to the target table and builds each requested row document exactly
once. It never applies SQL `DISTINCT` to selected JSON. The `edges` query emits
one structural fact per `(parent, child, depth)` for bounded traversal or
`(parent, child)` for `depth: false`. This separates record projection from
traversal multiplicity: a diamond transports `D` once while the parser can
materialize it once under each path.

The descriptor selects one exact edge arm for the whole carrier. Exhaustive SQL
must omit the `depth` property rather than emit `null`; bounded SQL must include
it. A carrier cannot mix the two arms.

For ordering, bounded carriers order edge facts by depth, then predecessor
identity; exhaustive carriers start with predecessor identity. Both then use
the existing normalized child order and row-key tie-breaker. Feed that ordered
derived query through the same adapter select assembly and no-limit
materialization rule used by nested reads before JSON aggregation. The parser
groups in carrier order; JavaScript never reimplements database comparison.

Return the relation carrier through the existing scalar include result. Do not
return provider outer arrays or expose the private envelope.

#### 2.4 Adapter seam

Change the internal `DatabaseAdapter.cte.recursive()` contract to accept the
ordered CTE column list. `createCteBuilders()` remains its one implementation
owner and escapes every name. Keep `union: "all" | "distinct"`; recursive
traversal selects `"distinct"`, and exhaustive cyclic data must never use
`UNION ALL`. Do not add a recursive-query capability object or dialect branch
in the query engine.

### Phase 3 — finite result shape, strict parse, fresh result

#### 3.1 Result descriptor

Extend `ExpectedRelationResultShape` with one optional finite descriptor:

```ts
type ExpectedRecursiveRelationShape =
  | {
      readonly kind: "foreignKey";
      readonly field: string;
      readonly identityWidth: number;
      readonly depth: number | false;
    }
  | {
      readonly kind: "junction";
      readonly field: string;
      readonly identityWidth: number;
      readonly depth: number;
      readonly preventCycles: boolean;
    }
  | {
      readonly kind: "junction";
      readonly field: string;
      readonly identityWidth: number;
      readonly depth: false;
      readonly preventCycles: true;
    };
```

`result-shape.ts` recognizes `recurse` while building the ordinary relation
entry. It builds the target's normal finite node shape once and stores the
descriptor beside it. It does not recursively nest `ExpectedResultShape`.

The descriptor receives normalized values, never raw option presence. Both
arms store either the effective numeric depth or literal false. The two
junction arms make unbounded/cycle-admitting traversal unrepresentable:
numeric depth carries either boolean policy, while false carries literal true.
Literal recurse true and every defaulted object spelling therefore become
identical descriptors for the same slot.

This exact descriptor is shared by provider parsing, cache compilation, and
runtime TypeScript rendering. No consumer re-reads raw query arguments.

#### 3.2 One relation-parser branch

`parseRelationValueDefault()` remains the only ordinary relation-carrier
dispatcher. When the descriptor is present, it calls one recursive-carrier
routine. That routine must validate the complete carrier before parsing or
mutating any public row:

1. carrier is a plain exact `{ root, nodes, edges }` record;
2. `nodes` and `edges` are dense arrays whose entries are plain exact records;
3. every node key is unique and every `row` satisfies the normal expected row
   contract before any scalar is parsed;
4. `key`, `parent`, `child`, and `root` are dense arrays of the exact compound width and
   contain only admitted JSON scalar transport leaves;
5. every edge child has exactly one matching node row, while a non-root parent
   also has a matching node row;
6. a numeric descriptor requires depth on every edge, positive and no greater
   than the effective depth; a `false` descriptor requires depth to be absent
   on every edge. Mixed carriers are refused;
7. bounded depth-1 edges start at `root` and deeper parents are reachable at the
   preceding depth; exhaustive edges form one connected adjacency graph
   reachable from `root`;
8. duplicate bounded `(parent, child, depth)` facts, duplicate exhaustive
   `(parent, child)` facts, impossible predecessors, structurally unreferenced
   node rows, and unreachable entries are refused. Reachability is not measured
   against the later public expansion, because cycle prevention may validly
   prune a structurally reachable fact. A fact used only by a back-edge is not
   “unused” merely because materialization later prunes it;
9. hierarchy mode proves at most one predecessor per identity and, with the
   outer root seeded on the active path, rejects every identity repeat as a
   relation cycle; and
10. junction mode permits several predecessors and repeated identities across
    bounded depths. The same physical `(parent, child)` edge at distinct depths
    is valid. Cycle policy is not a carrier-validity rule and runs only after
    this complete structural pass.

JSON arrays of validated primitive leaves can be keyed by their canonical JSON
array spelling inside this private parser. This is not a general serializer and
must not be exported.

Only after all structural checks pass:

- if `nodes` and `edges` are both empty, return `[]` after validating the root
  tuple at full width, without compiling a row parser;
- otherwise compile the normal row parser once from the first node row;
- retain raw private node rows and invoke the compiled parser without a reusable
  output target for every public occurrence;
- iteratively expand adjacency from the root, avoiding a JavaScript call-stack
  dependency at numeric depth 1000 or on a longer exhaustive acyclic path;
- in bounded graph mode, apply one `(parent identity, depth)` adjacency list to
  every parent occurrence at the preceding level; in exhaustive graph mode,
  apply the one parent adjacency list at every occurrence. Both produce equal
  but non-identical rows for diamonds and, when allowed, bounded cycles;
- when graph `preventCycles` is true—which is mandatory for `depth: false`—use
  one iterative depth-first enter/leave stack and seed the active-path identity
  set with the outer root. Skip only a child already on that path; never use a
  global visited set. If every outgoing edge is skipped away from a numeric
  cutoff, attach `[]` because the traversal proved no admissible child;
- when graph `preventCycles` is false, materialize every structurally valid
  bounded adjacency occurrence, including repeated cycle identities;
- attach child arrays in carrier order; and
- omit the relation key only on occurrences at a numeric effective depth
  cutoff. Exhaustive occurrences always receive the relation key, including
  `[]` at a leaf or cycle-pruned end.

Parsing one transported node repeatedly is intentional: shallow-cloning one
parsed row would share Date, Decimal, bytes, JSON, and nested-relation values
between graph paths. Each public occurrence must be fully fresh.

Provider-returned object graphs remain borrowed. Even when the carrier came
from `JSON.parse`, no private carrier object becomes a public row. The public
outer array is always fresh.

### Phase 4 — static and rendered result types

#### 4.1 Type proof before runtime expansion

Prototype the public type through real client calls before finalizing the
runtime implementation. The type must be keyed by the asking relation, not by
“every array property” as the old plan proposed.

Use one exported result helper in the client result owner, conceptually:

```ts
type RecursiveRelationResult<
  Node,
  Key extends PropertyKey,
  Exhaustive extends boolean,
> = Node & (
  Exhaustive extends true
    ? { [K in Key]: RecursiveRelationResult<Node, Key, true>[] }
    : { [K in Key]?: RecursiveRelationResult<Node, Key, false>[] }
);
```

The actual spelling may use an interface boundary if TypeScript measurements
show that it preserves laziness better. There must still be one exported
meaning, used by both inference and the runtime renderer.

`InferRelationNodeResult` first computes the ordinary projected node, including
default omit, then applies the recursive wrapper only when one internal
`NodeRecurse<Node>` reader says the normalized property is present. Put that
reader beside `NodeSelect`, `NodeInclude`, and `NodeOmit` so explicit
`undefined`, optional spreads, index signatures, and generic forwarding retain
the same established semantics:

- literal `true`, `{}`, and numeric depth select the bounded optional-key shape;
- literal `depth: false` selects the exhaustive required-key shape; and
- widened or optional depth values yield the honest union, which remains safe
  to consume as an optional key.

The same reader supplies the depth proof; one local conditional recognizes only
literal false as exhaustive. Do not add a second recurse-state carrier or infer
exhaustiveness from topology.

Do not numerically unroll literal depths. That would make editor cost
proportional to the user's number and invite TS2589.

Audit `Prettify` so it does not eagerly expand the recursive helper. Change the
smallest result boundary that forces expansion: the recursive row-operation and
bulk-projection boundaries in `client/result-types.ts` and `client/types.ts`
must use the existing shallow `Simplify`, while finite non-recursive pieces may
retain `Prettify`. Do not change global `Prettify`, add a brand, or add an
assertion to hide the problem.

#### 4.2 Runtime TypeScript renderer

Add a recursive `TypeNode`/reference form that renders
`import("viborm").RecursiveRelationResult<Node, Key, Exhaustive>` around the
finite node type. The third argument comes only from normalized `depth ===
false`, not from topology. Do not inline an infinite object and do not emit a
second, differently shaped helper. `renderOperationResultType()` must remain a
valid standalone type expression.

Export the same type helper from both the package root and `viborm/client`.
Add source, built-package, and package-export smoke probes so the renderer never
names an internal helper that consumers cannot import from the published
package.

### Phase 5 — cache and extension composition

#### 5.1 Cache values

`compileRelationCodec()` reads the recursive descriptor and builds one
depth-aware iterative recursive value codec over the finite row codec:

- bounded hierarchy and graph occurrences require the key before the cutoff and
  require its absence at the exact cutoff;
- exhaustive occurrences require the key everywhere;
- either form requires `[]` when traversal found no admissible child before a
  cutoff or at an exhaustive leaf, including after graph cycle pruning;
- snapshots preserve every scalar with the current shape-directed codecs;
- every cache hit materializes a fully fresh hierarchy or walk unfolding; and
- an actual cyclic JavaScript reference or malformed cached value fails at the
  cache boundary, while repeated graph row identities in distinct objects are
  valid.

Do not implement this as an unqualified self-calling codec: it cannot know
whether a missing key is an early corruption, the requested cutoff, or invalid
in exhaustive mode, and depth 1000 or an exhaustive hierarchy could overflow
the JavaScript call stack. Snapshot and materialization both use an explicit
work stack. The finite row codec still owns scalar and non-asking nested fields.

Do not route cache hits back through `ResultParser` and do not use JSON stringify
as a public clone.

#### 5.2 Cache identity and invalidation

No cache-key code changes. Official cache identity already hashes canonical
post-request validated arguments, so `recurse`, effective depth, cycle policy,
filters, ordering, and projection naturally differ. Because validation owns the
defaults, hierarchy `recurse: true`, `recurse: {}`, and
`recurse: { depth: 100 }` share one canonical meaning. Graph `recurse: true`,
`recurse: {}`, and `recurse: { depth: 100, preventCycles: true }` likewise share
one canonical meaning and one cache identity.

`depth: false` has a distinct canonical identity from every numeric depth. A
graph `{ depth: false }` and `{ depth: false, preventCycles: true }` share one
identity. A graph cannot produce a cache key for the invalid
unbounded/cycle-admitting combination because validation refuses it before
cache lookup.

No new invalidation graph exists. An eligible recursive relation reads the same
model as its root, and current model-prefix invalidation retains its existing
opt-in/default behavior. Add falsifiers; do not add another dependency registry.

#### 5.3 Extensions and instrumentation

No extension capability changes:

- request transforms may add or alter `recurse` before validation;
- query interceptors wrap the logical operation;
- cache remains inside ordinary query interceptors;
- statement transforms see the final typed recursive statement and keep their
  existing cache bypass;
- observers see the existing operation and physical-statement lifecycle; and
- transaction clients reuse the same immutable extension chain.

Do not add a built-in recursive span attribute. The old plan's `SPAN_BUILD`
does not exist, and instrumentation is now an official extension.

### Phase 6 — documentation and cleanup

Add a client documentation page beside selection/filtering that covers:

- eligible schema shape;
- default, explicitly bounded, and `depth: false` hierarchy/graph examples;
- where pruning and sibling ordering;
- the absent key at a depth cutoff;
- hierarchy cycle failures, default graph-cycle prevention, and explicit
  bounded graph-cycle unfolding;
- path multiplicity for graph diamonds;
- the explicit cost warning that `depth: false` graph output can contain an
  exponential number of simple-path occurrences even though SQL transports
  each reachable edge once;
- slot-defined `following`/`followers` direction;
- unsupported relation kinds and pagination options;
- provider recursion limits; and
- indexing guidance for the child foreign-key tuple and both generated junction
  access directions.

Update:

- `docs/content/docs/client/meta.ts`;
- `docs/architecture/v1-release-closure.md`;
- `docs/architecture/capability-matrix-2026-07.md`;
- relevant `AGENTS.md` ownership notes; and
- release notes.

Remove every obsolete claim from this document during implementation. Do not
keep old and new recursive designs together.

## 6. Provider contract

`depth: false` is exhaustive-or-error. No adapter may silently substitute 100,
1000, or a provider limit, and no provider-limit failure may become a partial
result. PostgreSQL, SQLite, D1, and their embedded families may still reject an
exhaustive statement for recursion, statement, memory, or execution limits;
that failure remains visible.

### PostgreSQL family

Use standard `WITH RECURSIVE`. Do not use PostgreSQL-only `SEARCH` or `CYCLE`;
order and cycle semantics must remain portable. Execute contracts on PGlite,
`pg`, postgres.js, Neon HTTP, and Bun SQL where its runtime is available.

### MySQL family

MySQL infers recursive CTE column types from the non-recursive arm. The explicit
column list and anchor values must therefore have the exact intended physical
types. The recursive member cannot contain aggregate/window functions,
`GROUP BY`, `ORDER BY`, or `DISTINCT`, and may reference the CTE only once at
top level. The design keeps projection, order, and JSON aggregation outside it.

Execute MySQL2. PlanetScale receives a production claim only after a hosted
SELECT contract; its own documentation calls recursive CTE support
experimental. Mutation projections on PlanetScale use the existing refetch
path rather than a recursive CTE inside a mutation statement.

The MySQL2 live contract must execute a finite cyclic fixpoint successfully and
also prove that a deliberately exceeded `cte_max_recursion_depth` fails the
whole operation without a partial result.

### SQLite family

SQLite likewise forbids aggregate and window functions in the recursive
member and requires the recursive table exactly once at top level. Execute
SQLite3, Bun SQLite, libSQL, and D1. D1's SQLite compatibility is not a substitute
for the Workers contract.

No provider may parse a private recursive carrier through a driver-specific
recursive builder.

## 7. Public contract changes

- Eligible self hierarchy collections gain
  `recurse: true | { depth?: 1..1000 | false }` in their nested
  `select`/`include` node; literal true and the empty object both mean depth
  100, while false removes the ORM cutoff.
- Eligible ordinary self-junction collections gain only
  `recurse: true | { depth?: 1..1000; preventCycles?: boolean } | { depth: false; preventCycles?: true }`;
  literal true and the empty object both mean depth 100 with cycle prevention,
  while false exhausts simple paths. Each public slot follows its
  already-resolved direction through the shared junction.
- Recursive nodes retain `where`, `orderBy`, `select`, `include`, and `omit`.
- `take`, `skip`, `cursor`, and `distinct` are unavailable beside `recurse`.
- Bounded recursive results have an optional recursive collection key;
  `depth: false` results have it as a required key.
- `viborm` and `viborm/client` export the same type-only
  `RecursiveRelationResult` helper used by public inference and schema
  introspection; it adds no runtime API.
- A hierarchy cycle whose closing edge is inside the traversed window throws.
  Graph cycles are pruned per active path by default; with
  `preventCycles: false`, they produce repeated fresh occurrences through the
  effective depth.
- No relation declaration, model, driver, raw SQL, migration, or extension API
  changes.
- No compatibility alias is added because VibORM is unreleased.

## 8. Focused falsifiers

### Eligibility and validation

- self to-many inverse over a foreign key accepts `true`, `{}`,
  `{ depth: undefined }`, numeric depth, and `depth: false`; all default
  spellings stop at level 100 and false exhausts reachable children;
- mapped and named compound self foreign keys accept it;
- both slots of a paired self junction accept `recurse: true`, `{}`, and custom
  bounded options plus `depth: false` in their own resolved directions;
- a self junction whose paired endpoint is singular is refused through runtime
  validation and the public type surface;
- default and explicit `.through().source().target()` self junctions behave the
  same apart from physical names;
- non-self, to-one, variant carrier, variant inverse, ambiguous, and unresolved
  slots reject it;
- a model without a complete row key fails before SQL rendering and receives no
  statically visible `recurse` property;
- a runtime-valid relation with a broad, non-provable name accepts recursion at
  runtime while its public type surface fails closed;
- graph `recurse: true` and `recurse: {}` both normalize to depth 100 with
  path-local cycle prevention;
- hierarchy `recurse: true`, `recurse: {}`, and explicit undefined depth all
  normalize to depth 100;
- hierarchy descriptors for `true`, `{}`, `{ depth: undefined }`, and
  `{ depth: 100 }` are identical by value, and no downstream consumer branches
  on the caller's raw spelling;
- omitted and explicitly undefined graph options are semantically identical to
  `{ depth: 100, preventCycles: true }`, while `preventCycles: false` is
  preserved;
- `depth` accepts 1, 1000, and false and rejects 0, negatives, 1001, fractions,
  NaN, Infinity, strings, unknown members, arrays, and promises;
- graph `depth: false` accepts omitted/true cycle prevention and rejects
  `preventCycles: false` through fresh and non-fresh public types plus hostile
  runtime input;
- graph `preventCycles` accepts true, false, omission, and explicit undefined;
  it rejects strings, numbers, arrays, promises, and throwing accessors through
  the normal validation error boundary;
- hierarchy object form rejects `preventCycles` rather than silently ignoring
  it;
- explicit `recurse: undefined` stays non-recursive and `recurse: false`
  rejects;
- recurse plus take/skip/cursor/distinct rejects through public types and runtime;
- selecting or including the asking relation inside its own recursive node
  rejects;
- fresh and non-fresh objects reject extra keys, with typo-beside-real-key
  probes at the relation node and recurse object levels; and
- relation target getters remain settled exactly once.

### SQL and topology

- direct children are depth 1;
- omitted depth compiles an effective cutoff of 100 on both bounded topologies,
  while an explicit depth overrides it;
- bounded SQL carries and bounds depth; `depth: false` SQL omits depth and
  deduplicates finite reachable edge facts so cycles terminate;
- every compound FK, referenced tuple, and primary-key member participates;
- graph SQL deduplicates `(root, parent, child, depth)` facts without
  multiplying SQL rows by path count;
- exhaustive graph SQL deduplicates `(root, parent, child)` facts, carries no
  depth column or cutoff predicate, and terminates on strongly connected data;
- asking the inverse graph field swaps the resolved junction sides without
  reading `sourceIsFirst`;
- `.map()` column/table names and PostgreSQL/MySQL namespaces are exact;
- anchor and recursive filters are identical;
- requested order is per parent with a stable row-key tie-breaker;
- absent order makes no ordering promise;
- no recursive member contains aggregation, windowing, or a second CTE
  reference;
- both bounded and exhaustive carriers use the correct all-present or
  all-absent depth form; mixed depth carriers fail;
- multiple recursive includes allocate distinct aliases; and
- one recursive read dispatches one provider statement; returning writes retain
  their existing provider/refetch count.

### Result integrity

- empty hierarchy/graph, one level, deep chain, wide hierarchy, multiple roots,
  and compound identities;
- natural leaves before the cutoff contain `[]`;
- bounded cutoff leaves omit the recursive key;
- exhaustive hierarchy and graph occurrences never omit the recursive key;
  their terminal leaves contain `[]`;
- a natural leaf or fully cycle-pruned graph occurrence before the cutoff
  contains `[]`, and a prevented closing edge returns no repeated target;
- where-filtered nodes prune their branch;
- hierarchy self-loop, two-node cycle, and longer cycle fail before any row is
  parsed when their closing edge lies inside the traversed window;
- `depth: false` hierarchy cycles always reach their closing edge and fail;
- graph chain and diamond traverse identically under both cycle policies;
- graph self-loop, two-node cycle, inverse-direction cycle, and longer cycle are
  pruned only when they revisit an active-path identity under the default
  policy; a sibling path to the same identity remains;
- with `preventCycles: false`, those cycle fixtures unfold exactly through the
  effective depth;
- with `depth: false`, graph cycle-closing edges are pruned and every simple
  path is returned; a diamond target still occurs independently per path;
- synthetic exhaustive hierarchy and graph carriers with an acyclic path longer
  than 1000 parse iteratively without JavaScript stack overflow;
- a graph cycle returning to the root is absent by default; when cycles are
  allowed, it appears only when the returning membership is real and the root
  passes the recursive `where` predicate;
- a diamond returns equal but non-identical copies of the shared target under
  both paths, including fresh nested values;
- structurally malformed row 2 fails before row 1 is parsed; a scalar or nested
  failure in row 2 returns no partial result and mutates no carrier row;
- missing/extra carrier keys, sparse tuples, wrong tuple width, invalid or
  mixed depth, duplicate node, duplicate bounded edge-depth fact, duplicate
  exhaustive edge fact, orphan, unused node, and unreachable entry fail, while
  the same `(parent, child)` edge at two distinct bounded depths remains valid;
- a hierarchy cycle whose closing edge lies beyond the requested cutoff is not
  queried and therefore does not fail that bounded operation;
- a user field named `row`, `key`, `parent`, `root`, or `depth` cannot collide
  with the private envelope;
- public outer arrays and row objects are fresh; and
- manual/public `parseResult()` never gains a recursive ownership token.

### Projection and scalar preservation

- select, include, omit, model omit, and official default omit apply at every
  level;
- nested ordinary and recursive includes work;
- bigint, blob, boolean, Date, DateTime, Decimal, enum, JSON, nullable, list,
  vector, and GeoPoint leaves match one-hop include behavior;
- `_distance`, relation `_count`, negative nested pagination in a different
  included relation, and aggregates already legal inside the node remain exact;
  and
- public key order stays deterministic.

### Client and cache

- inferred bounded and exhaustive recursive types through real public client
  calls;
- hierarchy and graph numeric/default results expose the recursive key as
  optional; literal `depth: false` makes it required, while widened values stay
  optional-safe;
- graph `preventCycles` alone never changes the result type; fresh and non-fresh
  option objects accept both booleans and reject unknown keys, including a
  typo-beside-real-key probe for `preventCycles`;
- explicit `undefined`, optional spreads, index signatures, and generic
  forwarding exercise the internal recurse reader through real client calls;
- inline, variable, generic, transaction, 0/1/5-extension, default-omit, and
  compound-key probes;
- no TS2589 or TS2590;
- `renderOperationResultType()` emits valid recursive type source;
- source and built-package type probes require the helper's third exhaustive
  boolean and prove it matches literal `depth: false`;
- cache keys differ for depth/filter/order/projection changes;
- hierarchy literal true, empty/defaulted objects, and explicit depth 100 share
  one canonical cache key;
- graph cache keys differ for `preventCycles: true` and `false`, while literal
  true, omitted defaults, explicit `undefined`, and explicit default values
  share one canonical key;
- `depth: false` cache keys differ from numeric depth and round-trip the required
  recursive key at every occurrence;
- cache hit and miss return equal but fully non-identical hierarchies and graph
  walk unfoldings;
- bounded cache values require the recursive key before the cutoff, forbid it at
  the cutoff, and retain `[]` when no child is admitted before the cutoff;
- hierarchy and graph cache hit/miss paths execute at depth 1000 without
  recursive JavaScript stack growth;
- exhaustive hierarchy and graph cache hit/miss paths use the same iterative
  stack discipline;
- malformed/cyclic cache snapshots fail;
- transaction and statement-transform cache bypass remains unchanged; and
- mutation invalidation retains existing commit-bound behavior.

### Operation and provider coverage

- findUnique, findFirst, findMany, and OrThrow aliases;
- every row-returning create/update/delete/upsert path that accepts ordinary
  relation projections, including bulk returning where supported;
- callback and array transactions;
- successful finite `depth: false` cyclic fixpoints on every mandatory provider
  family and an atomic MySQL recursion-limit failure control;
- SQLite3, Bun SQLite, libSQL, D1, PGlite, pg, postgres.js, Neon, Bun SQL,
  MySQL2, and an honestly reported PlanetScale hosted leg; and
- raw and unsafe raw results remain byte-identical.

## 9. Sequential validation

During implementation, run only the focused file or layer that owns the current
change. Do not rerun a 20-minute full suite after each edit. Run the full ladder
once after the integrated feature is stable:

1. focused relation-schema, recursive-builder, result-parser, cache, type, and
   introspection suites;
2. `pnpm test:layer:relations`;
3. `pnpm test:layer:schema-validation`;
4. `pnpm test:layer:validation`;
5. `pnpm test:layer:query-engine`;
6. `pnpm test:layer:adapters`;
7. `pnpm test:layer:client`;
8. `pnpm test:layer:cache`;
9. relevant result/query-engine/client/cache coverage gates;
10. `pnpm test:types`, with before/after extended diagnostics, no TS2589 or
    TS2590, wall under 300 seconds, RSS under 4 GB, and deterministic
    instantiations no more than 5% above baseline;
11. `pnpm package:build` and `pnpm test:package`, including root and
    `viborm/client` export probes for `RecursiveRelationResult`;
12. repository-pinned Biome on touched TypeScript files;
13. `git diff --check`;
14. `pnpm --dir docs validate`;
15. SQLite3, Bun SQLite, libSQL, D1, PGlite, pg, postgres.js, Neon, Bun SQL,
    MySQL2, and PlanetScale provider contracts where credentials/runtime exist;
16. `pnpm test:core`;
17. `pnpm test:all`;
18. `pnpm test:providers`, with hosted/runtime skips named honestly; and
19. five alternating fresh-process performance runs.

Performance runs cover 1, 20, 1000, and 10,000 produced occurrences; hierarchy
depth/breadth plus graph chain/diamond/cycle shapes under both cycle policies;
default depth 100, explicit numeric overrides, and `depth: false`; one and many
outer roots; selected scalars; nested includes; and compound keys.
Report SQL count, allocation, framework CPU, wall time, retained heap, and peak
RSS. Require SQL carrier growth proportional to unique nodes plus bounded
edge-depth or exhaustive edge facts, and parser/allocation growth proportional
to the public occurrences it must return. A branching graph can have
exponentially many bounded walks or simple exhaustive paths; the benchmark must
report that result cardinality rather than calling it an implementation
regression. Require one provider dispatch, no 10% control regression, and no
unexplained result copy. The one-dispatch requirement applies to reads;
mutation controls retain their established execution shape.

## 10. Completion criteria

The feature is complete only when all statements below are true:

1. The public language is still only `s.toOne()` and `s.toMany()` for relation
   declaration.
2. `recurse` appears only on proven self hierarchy and ordinary self-junction
   collection surfaces.
3. Runtime eligibility reads the resolved index; no raw target getter is added.
4. Static eligibility has one fail-closed owner beside static membership.
5. The normal to-many and polymorphic collection nodes do not gain recursive
   options accidentally.
6. Literal true always means the defaults. Numeric/default traversal exposes
   its cutoff by property absence; `depth: false` has no ORM cutoff and exposes
   the recursively loaded key everywhere.
7. Filtering prunes branches and ordering is per sibling collection.
8. Per-parent pagination options are refused rather than miscompiled.
9. Anchor and recursive correlation reuse the current traversal/binding owners.
10. Compound/mapped keys and namespaces are exact.
11. Recursive SQL contains no dialect spelling in the query engine.
12. The recursive member satisfies PostgreSQL, MySQL, and SQLite restrictions.
13. One finite result descriptor drives parser, cache, and renderer behavior.
14. The existing relation parser remains the one carrier dispatcher.
15. Every private carrier row is validated before any public row is parsed.
16. No provider object or private envelope becomes a public object.
17. Hierarchy cycles encountered inside the traversed window fail. Graph cycles
    are prevented per active path by default and unfold to a numeric bound only
    when explicitly allowed. Unbounded cycle-admitting graph traversal is
    refused; no mode can hang SQL or construct cyclic JavaScript objects.
18. Existing scalar and nested-relation behavior is reused, not reimplemented.
19. Cache identity needs no recursive special case and cached hierarchy/graph
   values materialize fully fresh.
20. Extensions, statement transforms, transactions, and observations retain
   their current lifecycle.
21. The public inferred type and runtime-rendered type state the same result.
22. The recursive result helper is present in both supported public type export
    surfaces and in the built package.
23. Non-recursive SQL, results, types, cache behavior, and performance remain
   unchanged within the declared gates.
24. Provider claims are backed by executed contracts, not adapter snapshots.
25. V1 and capability documentation no longer call recursive queries deferred.
26. Both directions of an ordinary self junction execute bounded and exhaustive
    graph traversal using the asking slot's resolved orientation.
27. A graph diamond preserves every path through equal but non-identical public
    occurrences. The default cycle policy skips only active-path repeats, the
    opt-out repeats cycles only through a numeric depth, and `depth: false`
    exhausts simple paths.
28. SQL transports each unique node row once and deduplicates bounded edge-depth
    or exhaustive edge facts; only public materialization expands path
    multiplicity.
29. No V1 graph filter, projection, or ordering rule depends on the path used to
    reach a node; compact adjacency reuse is therefore semantically exact.

## 11. Research anchors

- [PostgreSQL WITH queries](https://www.postgresql.org/docs/current/queries-with.html): recursive evaluation, explicit search ordering, and portable cycle considerations.
- [MySQL 8.4 WITH](https://dev.mysql.com/doc/refman/8.4/en/with.html): anchor-derived CTE types, recursive-member restrictions, top-level single reference, and the default recursion limit.
- [SQLite WITH](https://www.sqlite.org/lang_with.html): recursive-table placement, aggregate/window restrictions, subquery placement, and UNION behavior.
- [PlanetScale MySQL compatibility](https://planetscale.com/docs/vitess/troubleshooting/mysql-compatibility): recursive CTE support is experimental and SELECT-only.
- [Cloudflare D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/): D1 follows most SQLite conventions, which still requires an executed D1 contract.

## 12. Retired old-plan ideas

The following ideas from the previous document must not return:

- a relation-layer `isSelfReferencing()` that invokes the getter;
- optional parent-model plumbing into relation declarations;
- TypeScript as the only invalid-use guard;
- a generic flat-row `buildTreeFromFlatRows()` outside the result parser;
- a hardcoded `children` field or scalar `id` assumption;
- selecting only the first compound-key member;
- converting a `Sql` fragment to a column name with `.toString()`;
- silently clamping depth;
- globally ordering or paginating the flat CTE and calling it per-parent;
- changing `recurse` into a topology-dependent flat unique-node closure;
- parsing a graph node once and shallow-cloning it across path occurrences;
- treating canonical junction `sourceIsFirst` as public traversal direction;
- recursive cache-key code;
- built-in recursive span attributes;
- adapter snapshots presented as provider support; and
- claims that adapters, result shapes, cache codecs, or runtime type rendering
  require no work.
