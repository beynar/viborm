# Query Engine Builders

**Location:** `src/query-engine/builders/`

**Parent:** [Query engine](../AGENTS.md)

**Layer:** L6 — database-agnostic query construction

## Purpose

Builders turn trusted query meaning into composable `Sql` fragments. They use
adapter methods for dialect syntax and keep values parameterized.

## Main owners

| File | Responsibility |
| --- | --- |
| `relation-mutation-parser.ts` | scalar/relation partition and lossless mutation programs |
| `relation-data-builder.ts` | bound ordinary/polymorphic inverse topology and relation SQL data |
| `polymorphic-relation.ts` | row-held public discriminator resolution |
| `polymorphic-read-builder.ts` | row-held CASE projection and correlated target filters |
| `polymorphic-mutation.ts` | resolved row-held intent and atomic private `(type, id)` values |
| `polymorphic-collection-read-builder.ts` | collection read: one correlated JSON document, one branch per member junction in declaration order; reads `only` and `variants` and nothing else |
| `polymorphic-collection-filter-builder.ts` | collection `some`/`every`/`none` over member tables |
| `polymorphic-collection-mutation.ts` | binds one collection member for a write leaf |
| `polymorphic-member-join-parts.ts` | the shared member-table join legs collection reads and filters traverse |
| `where-builder.ts` | scalar and logical filters |
| `relation-filter-builder.ts` | relation `some`/`every`/`none` and `is`/`isNot` |
| `include-builder.ts` | nested relation reads and JSON projection |
| `select-builder.ts` | selected columns and result pairs |
| `relation-traversal.ts` | the physical read traversal of one relation occurrence |
| `correlation-utils.ts` | ordinary/polymorphic correlation predicates and primary-key selectors |
| `many-to-many-utils.ts` | junction identity and joins |
| `values-builder.ts` | INSERT values and destination scalar conversion |
| `set-builder.ts` | UPDATE assignments |
| `where-unique-builder.ts` | unique-selector SQL |

## Builder contract

A SQL builder normally takes `QueryScope` or `QueryContext` first and returns a
`Sql` fragment. It has no provider side effect.

```ts
function buildWhere(
  ctx: QueryScope,
  where: Record<string, unknown>
): Sql {
  // Compose adapter-owned identifiers and operators.
}
```

Use the adapter for identifiers, operators, JSON, locking, returning,
conflicts, casts, and other dialect syntax. Do not use string templates as a
second SQL API.

## Canonical mutation input

Partitioning and mutation interpretation are separate:

- `partitionModelData` distinguishes scalar fields from relation payloads. It
  does not inspect mutation keys.
- A relation schema transforms each untrusted payload once.
- `buildRelationMutationProgram` records the transformed meaning in fixed kind
  order.
- `buildParsedRelationPrograms` is only for a complete tree that is already
  parsed.

`RelationMutationProgram` preserves array order, duplicates, `set: []`, to-one
filters, and normalized update/upsert targets. It removes only false boolean
no-ops. It does not contain execution deduplication.

Downstream code consumes `program.entries`. Do not inspect the raw payload,
normalize arrays again, or recreate a per-kind optional mutation bag.

Polymorphic relation payloads ride in the one parsed collection instead of
changing `RelationMutationProgram`. `buildParsedRelationPrograms` returns
`{ scalarData, relations }`, and `relations` is an ordered
`ParsedRelationMutation[]` with one entry per relation key the payload writes:
`ordinary` (program), `polymorphicTarget` (program plus the resolved edge, once
the public discriminator names one concrete target), `polymorphicDisconnect`
(storage only — a targetless disconnect builds no program and becomes an empty
private storage assignment), or `polymorphicCollection` — one
`PolymorphicCollectionArm` per collection key, carrying that relation, its
relation-wide `clearsAll` fact, and one entry per named variant holding that
variant's PRE-BOUND member junction plus an ordinary `RelationMutationProgram`.
Binding the member here, once, is what the classifier's carrier guard protects.
Entries keep spelling `set` because the payload did; the write-side coordinator
owns the rewrite into an insert run plus its own barrier. Collection order is
every ordinary relation in
payload key order, then every polymorphic one; it is a behavior surface, so keep
the two passes. Consumers walk the collection and switch on `kind`; do not
rebuild a name-keyed map or a companion map beside it.

`PolymorphicStorageValue` is the only write representation for the private
columns. Its linked and empty variants always lower type and id together. Never
add hidden keys to scalar data, call `getColumnName` for a private column, or
expose an arbitrary physical-column escape in `values-builder.ts` or
`set-builder.ts`.

## Bound relation topology

`relation-data-builder.ts` owns `bindRelation` and `BoundRelation`.

`classifyRelation` is that classification handed back as a value — the arm, plus a
lazy bind typed to that arm — and `bindRelation` is defined through it, so the
estate holds one spelling of the test. Classify when the physical shape must be
known before topology may be resolved (a read traversal placing its aliases, a
junction statement refusing a non-junction relation); bind when the bound value
itself is needed. There is no second entry point per arm.

ONE RESOLVED EDGE, SEVERAL DERIVED VIEWS. Classification DISCOVERS NOTHING. It
reads the `ResolvedSlot` L5 published — which endpoint owns the stored reference,
which pairs live in a junction, which member of a carrier a bound inverse views —
and answers three orthogonal axes over that one edge. Nothing downstream stores a
second copy of any of them, and every question about an edge is asked of the axis
that owns it:

1. `edge.kind === "junction"` → position `junction` (cardinality `many`, junction
   membership);
2. a slot holding a MEMBER of a variant-junction carrier → position `junction`,
   junction membership carrying that member, oriented by whether the asking slot
   IS the carrier (`owner`) or its bound inverse (`variant`). Cardinality comes
   from that member's own `inverseCardinality`: `many` for a plural inverse and
   `one` for a singular one, backed by that member table's UNIQUE over the
   complete target side — the sole producer of a singular junction;
3. everything else is ROW-HELD, and the edge says which row holds it:
   `edge.owner` for a foreign key and `edge.carrier` for a variant row. The
   current model holding it → `parentHeld` (cardinality `one`); the other model
   holding it → `childHeld` with cardinality from the asking slot.

The arms are exclusive because a resolved slot carries exactly ONE edge: there
is no ladder, no fallback, and no order-dependent placement to get wrong.
Classification is a read of already-decided facts, so it is refusal-free.

The bound value contains the relation declaration, the source model, and the
membership: its holder and referenced models, ordered foreign and referenced
fields, those fields PAIRED member for member, and the update action. Consumers
read `membership.members` rather than re-pairing the two field lists by index —
the pairing has one owner because it owns a refusal. A polymorphic membership carries one referenced
FIELD, not a list — its discriminator is a fixed qualifier, not a member. The bound
value does not contain scopes, aliases, identity values, reference sources,
transition state, junction metadata, SQL, or execution policy.

Bind at the first topology decision. Early binding can change which schema or
arm-specific failure surfaces first. The FIELD pairing is not derived here at
all: `ResolvedStoredReference.members` arrives already paired from the topology
owner, and the two flat lists are projections of it — which is why the old
mismatched-foreign-key-metadata refusal is gone rather than merely unreached
(an unequal `.fields()`/`.references()` pair is refused at construction).
Attaching VALUE sources to those members, source resolution, and membership
lowering stay in `write-engine/relation-membership.ts` after existing legality
checks.

## Physical read traversal

`relation-traversal.ts` owns `buildRelationTraversal`, the one answer to "how does
a read reach this relation's rows": the aliases it spends, the FROM source, the
conditions tying those rows to the parent row, and the tables it reads. Include
(correlated and lateral), relation filters, relation counts and to-one order
chains all construct one traversal per relation occurrence and keep only their own
statement shape. Nothing else classifies a relation as many-to-many to pick a
physical shape, and nothing else copies a target FROM source.

The traversal builder calls the two arm owners rather than reimplementing them:
`buildCorrelation` for a row-held edge, `buildManyToManyJoinParts` for a junction.

Three properties are load-bearing:

- classification and alias allocation are EAGER, and a traversal allocates exactly
  its junction and target aliases. Alias numbers are SQL bytes, so it is
  constructed where its builder used to allocate them — before any lateral alias
  and before nested selection or nested where. Lateral, inner, sub and
  mutation-hide aliases belong to the builders that wrap;
- topology is LAZY and memoized. Binding resolves inverses and junction sides and
  can refuse, so a builder that classifies and then short-circuits (an `every`
  quantifier with no inner condition) must still leave silently;
- the row-held arm contributes EXACTLY ONE, already-folded condition. A compound
  foreign key and a polymorphic inverse compare several columns as one group, and
  splitting that group flattens the statement once an inner `where` is appended.
  The junction arm contributes its two conjuncts flat, which is the junction
  read's own shape.

The traversal owns no meaning: selection, aggregation, lateral strategy, windows,
filter quantifiers, negation, ordering, result parsing and mutation-target hiding
stay with their builders — it only supplies the table list the hiding rule tests.
Direct polymorphic reads stay outside it: `polymorphic-read-builder.ts` traverses
a payload-selected variant target-first, and such a field is not a bound relation.

## Parse-once rule

Validation transforms are not assumed to be idempotent. Never feed a
schema-transformed subtree back through its schema. Pass the canonical program
or transformed record data to the next owner.

Validation has one owner at the trust boundary. Do not add downstream shape
guards for states that the boundary cannot produce.

## SQL boundary

The query engine decides statement structure. The adapter decides syntax.

Never recognize provider behavior by matching generated SQL text. When a fold
needs to know a semantic such as target table or SQL-level skip behavior, carry
that semantic fact from construction. Provider message and assertion-marker
recognition belongs to driver error mapping.

Structural `Sql` checks used for composition are permitted. They must not infer
a dialect capability from tokens.

## Correlation and field order

Correlation predicates protect parent membership and wrong-row behavior.
Preserve conjunct and parameter order. A selected-record write uses the primary
key captured by its owner read, not a re-evaluated selector.

Compound FK and referenced-field arrays remain in schema order. Do not sort or
re-pair them in a builder.

A ROW-HELD polymorphic read uses one portable CASE expression with a correlated
target subquery per configured variant. It uses exact-text discriminator
equality and the existing nested selection builder. The variant count controls
SQL size; returned row count does not create more statements. Ordinary relation
LATERAL selection remains unchanged.

A COLLECTION read is the sibling of that shape, not a second mechanism:
`select-builder.ts` dispatches on cardinality and
`polymorphic-collection-read-builder.ts` composes one correlated JSON document
with one branch per member junction, in `storage.members` declaration order —
which is the single ordering truth, so the `only` allow-list never changes
result order. Correlated rather than lateral on every adapter, because the
result boundary decodes exactly one relation value per relation column. It reads
`only` and `variants` from the validated selection and nothing else; `only` is
already deduped and canonicalized at the parse boundary, so no builder re-derives
it.

A row-held variant carrier's inverse — plural `s.toMany` or singular `s.toOne` —
is still an ordinary public relation, but its membership predicate is two-part: private id
correlation followed by exact stored-discriminator equality.
`correlation-utils.ts` owns this conjunction. Ordinary relation builders own
the cardinality-specific include, filter, count, ordering, and null behavior.
Never rebuild the private conjunction at individual call sites.

`polymorphic-mutation.ts` parses one ROW-HELD verb into a concrete target edge and
an ordinary mutation program. Record compilers own single-record lowering.
Root createMany is different only because its connect selectors must be grouped
before the bulk INSERT: `write-engine/bulk-polymorphic-connect.ts` owns that
shared count/returning preparation. Never add per-row target queries or expose
private storage columns through public row data.

A COLLECTION key parses into the parser's fourth arm: one
`PolymorphicCollectionArm` carrying, per named variant, that variant's pre-bound
member junction (`polymorphic-collection-mutation.ts`, owner-oriented, from
pre-resolved topology) plus an ordinary `RelationMutationProgram`. The binding
happens ONCE here, which is what the classifier's carrier guard protects. The
arm also carries the relation-wide `clearsAll` fact that `set` needs; the entries
keep spelling `set` because the payload did, and the write-side coordinator owns
the rewrite.

## Anti-patterns

- stateful builder objects;
- hardcoded quotes or JSON functions;
- SQL token regexes that infer provider semantics;
- reparsing canonical nested data;
- raw relation-mutation key inspection downstream;
- early relation binding that changes failure timing;
- treating a direct payload-selected polymorphic field as `AnyRelation` or
  `BoundRelation`; fixed polymorphic inverses are correctly bound relations;
- writing one private polymorphic storage column without the other;
- omitting the discriminator conjunct from an inverse predicate;
- a generic payload walker;
- concern-free `utils` or `helpers` modules.

## Validation

For a builder change, compare SQL and parameter arrays across the affected
dialects. Then run:

```bash
pnpm test:types
pnpm test:layer:query-engine
pnpm package:build
```
