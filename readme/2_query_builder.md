# 4. Query Builder — Developer Specification

## Introduction

The Query Builder provides a type-safe, ergonomic API for querying and mutating data, closely mirroring Prisma's API. It must support methods like `findMany`, `findUnique`, `create`, `update`, `delete`, and allow raw SQL queries. All queries must be type-safe and infer types from the schema. Transactions are not required for the initial version.

---

## Goals

- **Type Safety:** All queries must be fully type-safe and infer their types from the schema.
- **Prisma-like API:** The API must closely match Prisma's for familiarity and ease of use.
- **Extensibility:** The Query Builder must be easily extensible for future features (e.g., transactions, hooks).
- **Raw Queries:** Support for raw SQL queries as a utility.

---

## Implementation Rules

### 1. Directory & File Structure

- All Query Builder code must reside in `/src/query/queryBuilder.ts`.
- All query type helpers must be in `/src/types/`.
- No code outside these directories may define or modify query logic.

### 2. Query Builder API

- Implement a `QueryBuilder` class (or factory) with methods for:
  - `findMany`
  - `findUnique`
  - `create`
  - `update`
  - `delete`
  - `raw` (for raw SQL queries)
- The API must match Prisma's as closely as possible in method names, arguments, and return types.
- All methods must be type-safe and infer types from the schema.

### 3. Type Inference

- The Query Builder must use TypeScript generics to infer the result type of each query based on the model definition.

### 4. Raw Queries

- Implement a `raw` method that allows execution of raw SQL queries, returning results as-is.

### 5. Extensibility

- The Query Builder must be designed to allow future features (e.g., transactions, hooks).
- All internal state must be accessible for future introspection.

---

## Example Usage

```ts
const users = await orm.user.findMany({ where: { name: "Alice" } });
const user = await orm.user.findUnique({ where: { id: "..." } });
const created = await orm.user.create({ data: { ... } });
const updated = await orm.user.update({ where: { id: "..." }, data: { ... } });
const deleted = await orm.user.delete({ where: { id: "..." } });
const rawResult = await orm.raw("SELECT * FROM user WHERE ...");
```

---

## Deliverables

- `queryBuilder.ts` in `/src/query/`
- All query type helpers in `/src/types/`
- Full TypeScript support and type inference
- Unit tests for all query builder features

---

## Prohibited

- No decorators
- No runtime type generation (all types must be inferred at compile time)
- No code outside `/src/query/` and `/src/types/` may define query logic

---

## Review Checklist

- [ ] All query methods are type-safe and match Prisma's API
- [ ] All query type helpers are in `/types/`
- [ ] Raw queries are supported
- [ ] No decorators are used
- [ ] Example usage compiles and infers correct types
