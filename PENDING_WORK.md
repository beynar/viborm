# VibORM - Pending Work Summary

**Last Updated:** August 2026

This document tracks the actual remaining work for VibORM, replacing outdated planning documents.

---

## 🔴 Bugs to Fix

_No critical bugs currently tracked._

---

## 🟡 Skipped Tests to Fix

_No skipped tests currently tracked._

---

## 🟢 TODOs in Code

_No `TODO`/`FIXME` markers currently tracked in `src/`. The MySQL migrations adapter (`src/migrations/drivers/mysql/`) and the client caching layer (`src/cache/`, `orm.$withCache()`) are both implemented; see "Recently Completed" below._

---

## 🔵 Future Features

### 1. Recursive Queries

**Spec:** `features-docs/recursive-query.md`

Implementation plan for `WITH RECURSIVE` CTE queries on self-referencing models:

```typescript
const user = await orm.user.findUnique({
  where: { id: "manager-1" },
  include: {
    subordinates: { recurse: { depth: 5 } }
  }
});
```

**Estimated effort:** Medium (CTE adapters already exist)

---

## ✅ Recently Completed (formerly listed as pending)

For historical reference, these were previously documented as pending but are now implemented:

| Feature | Location |
|---------|----------|
| **Aggregate schema proper typing** | `src/validation/model/args/aggregate.ts` |
| **Prisma-compliant having schema** | `src/validation/model/args/aggregate.ts` |
| **Count args with select option** | `src/validation/model/args/aggregate.ts` |
| **NumericScalarKeys helper type** | `src/schema/model/helper.ts` |
| Enum literal types preserved through relations | `src/schema/scalars/enum/`, `src/client/result-types.ts` |
| Create/CreateMany operations | `src/query-engine/operations/create.ts` |
| Update/UpdateMany operations | `src/query-engine/operations/update.ts` |
| Delete/DeleteMany operations | `src/query-engine/operations/delete.ts` |
| Upsert operations | `src/query-engine/operations/upsert.ts` |
| Cursor pagination | `src/query-engine/operations/find-common.ts` |
| DISTINCT queries | `src/query-engine/operations/find-common.ts` |
| Case insensitive filtering | `src/query-engine/builders/where-builder.ts` |
| Nested create with relations and parent-derived FK omission | `src/validation/builder.ts`, `src/query-engine/operations/nested-writes/create.ts` |
| Nested update with relations | `src/query-engine/operations/nested-writes/update.ts` |
| Nested delete with relations | `src/query-engine/operations/nested-writes/delete.ts` |
| Connect/Disconnect/Set operations | `src/query-engine/operations/nested-writes/connect.ts`, `disconnect.ts`, `set.ts` |
| ConnectOrCreate operations | `src/query-engine/operations/nested-writes/connect-or-create.ts` |
| M2M junction logic utils | `src/query-engine/builders/many-to-many-utils.ts` |
| **Cursor pagination test (fixed)** | `src/query-engine/operations/find-common.ts` - Filter undefined values from cursor entries |
| **GroupBy HAVING query generation** | `src/query-engine/operations/groupby.ts` - Prisma-style field-keyed having structure |
| **MySQL migrations adapter** | `src/migrations/drivers/mysql/index.ts` - Full DDL driver, registered in `src/migrations/drivers/index.ts` |
| **Client query caching layer** | `src/cache/`, `orm.$withCache()` / `orm.$invalidate()` in `src/client/client.ts` |
| **Upsert atomicity** | `src/query-engine/operations/nested-writes/upsert.ts`, `src/query-engine/operations/nested-writes/atomic-runner.ts` |
| **MySQL upserts** | `src/adapters/databases/mysql/mysql-adapter.ts` |
| **Relation filters on updateMany/deleteMany** | `src/query-engine/operations/nested-writes/update-many.ts`, `delete-many.ts` |
| **LIKE wildcard escaping** | `src/query-engine/builders/where-builder.ts` - `escapeLikeValue()` |
| **`distinct` + `orderBy`** | `src/query-engine/operations/find-common.ts` |
| **`skip` without `take`** | `src/adapters/databases/{postgres,mysql,sqlite}/*-adapter.ts` |
| **`NULLS FIRST`/`NULLS LAST` ordering** | `src/query-engine/builders/sort-order-builder.ts`, `src/adapters/shared/standard-sql.ts` |
| **Case-insensitive mode on `equals`/`in`** | `src/query-engine/builders/where-builder.ts` |
| **Polymorphic to-one slots** (a variant `s.toOne`) | `src/schema/relation/polymorphic.ts`; `features-docs/polymorphic-relations.md` §§2–16 |
| **Polymorphic collection slots** (a variant `s.toMany`) — declaration, migration, reads, direct writes, both inverse arities, and the bulk/progressive routes | `src/schema/relation/junction-topology.ts`, `src/query-engine/write-engine/PolymorphicCollectionPart.ts`, `RelationJunctionToOnePart.ts`, `junction-singular-transfer.ts`; `features-docs/polymorphic-relations.md` §17 |

---

## Priority Order

1. **Future:** recursive queries
