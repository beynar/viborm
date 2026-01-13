# VibORM - Pending Work Summary

**Last Updated:** January 2026

This document tracks the actual remaining work for VibORM, replacing outdated planning documents.

---

## 🔴 Bugs to Fix

_No critical bugs currently tracked._

---

## 🟡 Skipped Tests to Fix

_No skipped tests currently tracked._

---

## 🟢 TODOs in Code

### 1. MySQL Migrations Adapter

**File:** `src/migrations/push.ts:43`

```typescript
// TODO: Add mysql adapter when migrations are implemented
```

Migrations currently only support PostgreSQL and SQLite.

---

### 2. Client Caching Layer

**File:** `src/client/client.ts:153`

```typescript
// TODO: Implement caching layer
```

Query result caching is not yet implemented.

---

## 🔵 Future Features (Documented but not implemented)

### 1. Polymorphic Relations

**Spec:** `features-docs/polymorphic-relations.md`

Full implementation plan for polymorphic relations allowing models to belong to multiple types:

```typescript
const comment = s.model("comment", {
  commentable: s.relation.polymorphic(() => ({
    post: Post,
    video: Video,
    photo: Photo,
  })),
});
```

**Estimated effort:** Large (8 phases documented)

---

### 2. Recursive Queries

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
| **Aggregate schema proper typing** | `src/schema/model/schemas/args/aggregate.ts` |
| **Prisma-compliant having schema** | `src/schema/model/schemas/args/aggregate.ts` |
| **Count args with select option** | `src/schema/model/schemas/args/aggregate.ts` |
| **NumericFieldKeys helper type** | `src/schema/model/helper.ts` |
| Enum literal types preserved through relations | `src/schema/fields/enum/`, `src/client/result-types.ts` |
| Create/CreateMany operations | `src/query-engine/operations/create.ts` |
| Update/UpdateMany operations | `src/query-engine/operations/update.ts` |
| Delete/DeleteMany operations | `src/query-engine/operations/delete.ts` |
| Upsert operations | `src/query-engine/operations/upsert.ts` |
| Cursor pagination | `src/query-engine/operations/find-common.ts` |
| DISTINCT queries | `src/query-engine/operations/find-common.ts` |
| Case insensitive filtering | `src/query-engine/builders/where-builder.ts` |
| Nested create with relations | `src/query-engine/operations/nested-writes.ts` |
| Nested update with relations | `src/query-engine/operations/nested-writes.ts` |
| Nested delete with relations | `src/query-engine/operations/nested-writes.ts` |
| Connect/Disconnect/Set operations | `src/query-engine/operations/nested-writes.ts` |
| ConnectOrCreate operations | `src/query-engine/operations/nested-writes.ts` |
| M2M junction logic utils | `src/query-engine/builders/many-to-many-utils.ts` |
| **Cursor pagination test (fixed)** | `src/query-engine/operations/find-common.ts` - Filter undefined values from cursor entries |
| **GroupBy HAVING query generation** | `src/query-engine/operations/groupby.ts` - Prisma-style field-keyed having structure |

---

## Priority Order

1. **Future:** MySQL migrations, caching, polymorphic relations, recursive queries
