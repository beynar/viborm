# VibORM - Pending Work Summary

**Last Updated:** January 2026

This document tracks the actual remaining work for VibORM, replacing outdated planning documents.

---

## 🔴 Bugs to Fix

### 1. Aggregate Schema Not Properly Typed

**File:** `src/schema/model/schemas/args/aggregate.ts:18`  
**Priority:** Low

```typescript
// TODO this is not typed properly
export type AggregateFieldSchemas<T extends ModelState> = {
  count: V.FromKeys<string[], OptionalBoolean>;  // Should infer actual field names
  // ...
}
```

The aggregate field schemas use `string[]` instead of inferring actual field names from the model.

---

## 🟡 Skipped Tests to Fix

### 1. Cursor Pagination Test

**File:** `tests/query-engine/sql-generation.test.ts:142`

```typescript
test.skip("with cursor pagination", () => {
  // Cursor pagination requires more complex setup - skip for now
```

**Note:** Implementation exists in `src/query-engine/operations/find-common.ts` (`buildCursorCondition`). Test just needs proper setup.

---

### 2. GroupBy with HAVING Test

**File:** `tests/query-engine/sql-generation.test.ts:729`

```typescript
// TODO: having clause with aggregate functions (_count, etc.) needs special schema support
test.skip("with having", () => {
```

**Issue:** HAVING clause with aggregate functions like `_count: { gt: 5 }` needs schema-level support for aggregate conditions.

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

---

## Priority Order

1. **Medium:** Unskip cursor pagination test
2. **Medium:** GroupBy HAVING schema support
3. **Low:** Aggregate schema typing
4. **Future:** MySQL migrations, caching, polymorphic relations, recursive queries
