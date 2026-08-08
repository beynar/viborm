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
| `relation-data-builder.ts` | bound relation topology and relation SQL data |
| `where-builder.ts` | scalar and logical filters |
| `relation-filter-builder.ts` | relation `some`/`every`/`none` and `is`/`isNot` |
| `include-builder.ts` | nested relation reads and JSON projection |
| `select-builder.ts` | selected columns and result pairs |
| `correlation-utils.ts` | inverse relation resolution and model keys |
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

## Bound relation topology

`relation-data-builder.ts` owns `bindRelation` and `BoundRelation`.

Classification is:

1. many-to-many → `junction`;
2. current model holds FK → `parentHeldToOne`;
3. child-held to-one → `childHeldToOne`;
4. remaining child-held edge → `childHeldToMany`.

The bound value contains the source model, ordered foreign and referenced
fields, and update action. It does not contain scopes, aliases, identity
values, reference sources, transition state, junction metadata, SQL, or
execution policy.

Bind at the first topology decision. Early binding can change which schema or
arm-specific failure surfaces first. Field/value pairing and arity checks stay
in `write-engine/foreign-key-reference.ts` after existing legality checks.

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

## Anti-patterns

- stateful builder objects;
- hardcoded quotes or JSON functions;
- SQL token regexes that infer provider semantics;
- reparsing canonical nested data;
- raw relation-mutation key inspection downstream;
- early relation binding that changes failure timing;
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
