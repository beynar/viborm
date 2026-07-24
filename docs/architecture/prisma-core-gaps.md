# Prisma Core Gaps Roadmap

## Purpose

This document lists the obvious Prisma-compatibility gaps VibORM should close
first. It intentionally avoids full Prisma parity and Prisma's heavier type
algebra. The goal is runtime correctness, fail-closed behavior, and familiar
core ORM semantics for normal Prisma-style application code.

Do not expand this file into a complete Prisma clone. Provider-specific,
preview, unsafe, Mongo-only, and query-planner-control APIs belong in the
contract matrix as unsupported or future work.

## Non-goals

- Do not clone Prisma's public `Exact`, `XOR`, `SelectSubset`, or checked /
  unchecked input helper surface.
- Do not implement `omit` as part of this roadmap.
- Do not implement Prisma raw or provider-specific APIs such as
  `createManyAndReturn`, `updateManyAndReturn`, `findRaw`, `aggregateRaw`,
  `$queryRawUnsafe`, `$executeRawUnsafe`, `$queryRawTyped`,
  `relationLoadStrategy`, `nativeDistinct`, or `_relevance` ordering.
- Do not expand aggregate/count pagination beyond the documented input-window
  contract unless a later contract row explicitly accepts the complexity.

## 1. Fail Closed for Accepted-but-ignored Inputs

Current risk:

- Inputs can validate or type-check, then disappear during query generation.
- This can broaden a restrictive query into a wider query than the caller
  requested.

Work:

- Inventory every public query input accepted by validation.
- Inventory every query-engine builder branch that implements those inputs.
- Reject unsupported scalar filter operators before SQL generation.
- Reject unsupported relation ordering before SQL generation.
- Remove or hard-fail unknown builder operations instead of returning
  `undefined`.

Done when:

- No Prisma-like input accepted by validation is silently skipped by query
  generation.
- Focused runtime tests prove unsupported filters and ordering fail closed.

## 2. `whereUnique` Safety

Current risk:

- Single-record operations can accept an empty or non-unique selector in some
  paths.
- A unique builder returning no condition is a dangerous query-widening failure.

Work:

- Require at least one real unique discriminator in `whereUnique`.
- Preserve compound ID and compound unique support.
- Apply the rule to `findUnique`, `update`, `delete`, and `upsert`.
- Add client runtime guards for empty unique selectors.

Done when:

- `where: {}` fails before query generation for unique operations.
- Compound unique selectors still pass.

## 3. Single-record Not-found Semantics

Current risk:

- Single-record mutation behavior can drift from Prisma by returning `null`,
  empty results, or default-shaped values when the row does not exist.

Work:

- Make `update` throw a stable VibORM not-found error when the target row does
  not exist.
- Make `delete` throw a stable VibORM not-found error when the target row does
  not exist.
- Preserve `updateMany` and `deleteMany` returning `{ count }`.
- Re-check `findUniqueOrThrow` and `findFirstOrThrow` for consistent error
  class and message conventions.

Done when:

- Missing-row `update` and `delete` throw.
- Batch mutations still return counts.

## 4. Top-level `select` / `include` Exclusivity

Current risk:

- Prisma users expect `select` and `include` to be mutually exclusive at the
  same level.
- Supporting both together creates ambiguous result-shaping behavior.

Work:

- Reject top-level `select` + `include` at runtime.
- Add direct object-literal type checks if this can be done without heavy
  Prisma-style type algebra.
- Keep nested selection rules separate from this first pass.

Done when:

- `find*`, `create`, `update`, `delete`, and `upsert` reject top-level
  `select` + `include`.
- Result inference no longer needs fallback behavior for that impossible shape.

## 5. Relation `orderBy`

Current risk:

- Relation ordering is visible in schemas but can be skipped by the order-by
  builder.

Work:

- Implement to-one relation ordering by scalar fields on the related model.
- Implement to-many relation aggregate ordering for `_count`.
- Reject arbitrary to-many relation scalar ordering because Prisma does not
  support ordering a parent row by an unaggregated child scalar.
- Ensure relation ordering uses stable aliases and does not duplicate parent
  rows.

Examples:

```ts
await orm.post.findMany({
  orderBy: { author: { name: "asc" } },
});
```

```ts
await orm.user.findMany({
  orderBy: { posts: { _count: "desc" } },
});
```

```ts
await orm.user.findMany({
  orderBy: { posts: { title: "asc" } },
});
// reject
```

Done when:

- Supported relation ordering generates correct SQL.
- Unsupported relation ordering fails before SQL generation.

## 6. Nested-write Safety

Current risks:

- `connect` may not fail consistently when the target record is missing.
- Specific to-many `disconnect` or `delete` can target a child by unique input
  without proving it belongs to the parent.
- Unsupported nested writes can be accepted too late.
- A child-write failure can leave partial parent or child changes if a path is
  not transactional or single-statement atomic.

Work:

- Make `connect` fail if the target record does not exist.
- Scope to-many `disconnect` and `delete` by parent correlation.
- Reject unsupported nested writes before parent mutation executes.
- Reject `disconnect` or `set: []` when the inverse FK is non-nullable and the
  operation would violate required relation constraints.
- Add rollback tests for every supported nested-write shape.

Done when:

- Supported nested writes cannot mutate unrelated rows.
- Unsupported nested writes fail before query generation.
- Failing child writes leave no partial parent or child mutation behind.

## 7. Cursor Pagination and Negative `take`

Current risk:

- Prisma-style pagination bugs are subtle and user-visible, especially cursor
  inclusion, `skip: 1`, compound cursors, and negative `take`.

Work:

- Ensure cursor inputs use `whereUnique`.
- Define default ordering when cursor pagination is used without explicit
  `orderBy`.
- Implement Prisma-compatible cursor inclusion semantics.
- Implement negative `take` behavior.
- Validate integer constraints for `take` and `skip`.
- Reject fractional and invalid pagination values.
- Apply input-window pagination to `count({ orderBy, cursor, take, skip })` and
  `aggregate({ orderBy, cursor, take, skip })` so aggregate operations consume
  the same filtered, ordered, limited rowset the caller requested.

Done when:

- Cursor pagination works with single-field and compound unique cursors.
- `skip: 1` excludes the cursor row.
- Negative `take` pages backward.
- `count` and `aggregate` do not ignore accepted pagination or ordering inputs.

## 8. Cross-dialect Mutation Returns

Current risk:

- Dialects without `RETURNING`, especially MySQL-style drivers, can return
  empty rows that parse as `null` even when the public API promises a row.

Work:

- Inventory mutation return paths for `create`, `update`, `delete`, `upsert`,
  nested `create`, nested `createMany`, and `connectOrCreate`.
- Implement follow-up select/refetch for MySQL-style adapters where safe.
- For `delete`, fetch before deleting because the public API returns the deleted
  row.
- For `update`, refetch by unique selector or primary key.
- For `create`, refetch by provided primary key, generated primary key, or a
  dialect-specific inserted-id mechanism.
- Reject any return path that cannot be refetched safely instead of returning
  fabricated data.

Done when:

- Mutations do not return `null` on dialects without `RETURNING` unless the
  public type says they can.
- MySQL-style driver tests cover basic mutation return paths.

## Recommended Order

1. Fail closed for accepted-but-ignored inputs.
2. `whereUnique` safety.
3. Single-record not-found semantics.
4. Top-level `select` / `include` exclusivity.
5. Relation `orderBy`.
6. Nested-write safety.
7. Cursor pagination and negative `take`.
8. Cross-dialect mutation returns.
