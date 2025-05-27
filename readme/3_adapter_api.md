# 5. Adapter API — Developer Specification

## Introduction

The Adapter API abstracts database-specific logic, allowing the ORM to support both MySQL and Postgres. Each adapter must implement a common interface for database operations. The API must be modular, allowing easy addition of new adapters in the future.

---

## Goals

- **Modularity:** All database-specific logic must be encapsulated in adapters.
- **Extensibility:** The Adapter API must allow easy addition of new database backends.
- **Overlapping Features:** Only features supported by both MySQL and Postgres should be exposed in the core ORM.

---

## Implementation Rules

### 1. Directory & File Structure

- All Adapter API code must reside in `/src/query/adapter.ts`.
- No code outside this file may define or modify adapter logic.

### 2. Adapter Interface

- Define an `Adapter` interface with methods for:
  - Connecting/disconnecting to the database
  - Executing queries (with parameter binding)
  - Mapping results to model types
- Implement adapters for MySQL (using `mysql2`) and Postgres (using `pg`).
- Adapters must only expose features supported by both databases.

### 3. Extensibility

- The Adapter API must be designed to allow future adapters (e.g., SQLite).
- All internal state must be accessible for future introspection.

---

## Example Usage

```ts
const adapter = new PostgresAdapter({ ...config });
await adapter.connect();
const result = await adapter.query("SELECT * FROM user WHERE id = $1", [id]);
await adapter.disconnect();
```

---

## Deliverables

- `adapter.ts` in `/src/query/`
- Full TypeScript support
- Unit tests for all adapter features

---

## Prohibited

- No decorators
- No code outside `/src/query/` may define adapter logic

---

## Review Checklist

- [ ] All adapters implement the common interface
- [ ] Only overlapping features are exposed
- [ ] No decorators are used
- [ ] Example usage compiles and works for both MySQL and Postgres
