# Database Adapters - SQL Dialect Layer

**Location:** `src/adapters/`  
**Layer:** L7 - Database-Specific SQL (see [root AGENTS.md](../../AGENTS.md))

## Purpose

ALL database-specific SQL generation lives here. Query engine calls adapter methods to build dialect-correct SQL.

**The Separation Principle:** Query engine = WHAT to query. Adapter = HOW to express it.

## Why This Layer Exists

VibORM supports PostgreSQL, MySQL, and SQLite from one codebase. These databases have dozens of syntax differences:

| Concept | PostgreSQL | MySQL | SQLite |
|---------|------------|-------|--------|
| Identifier quotes | `"column"` | `` `column` `` | `"column"` |
| JSON aggregation | `json_agg()` | `JSON_ARRAYAGG()` | `json_group_array()` |
| Case-insensitive | `ILIKE` | `LIKE` (default) | `LIKE` + COLLATE |
| Array contains | `= ANY(col)` | `JSON_CONTAINS()` | `json_each()` subquery |
| Empty JSON array | `'[]'::json` | `JSON_ARRAY()` | `json_array()` |

Without adapters, we'd have `if (postgres) ... else if (mysql) ...` scattered everywhere. The adapter pattern centralizes all dialect knowledge in one place per database.

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `database-adapter.ts` | Interface & base implementation | ~720 |
| `databases/postgres/postgres-adapter.ts` | PostgreSQL dialect | ~570 |
| `databases/mysql/mysql-adapter.ts` | MySQL dialect | ~620 |
| `databases/sqlite/sqlite-adapter.ts` | SQLite dialect | ~570 |
| `databases/*/migrations.ts` | DDL for each database | varies |
| `shared/` | Cross-dialect helpers (standard SQL ops, SELECT/JSON assembly) | varies |

---

## DatabaseAdapter Interface

**12+ method groups** (all return `Sql` fragments):

| Group | Methods | Critical For |
|-------|---------|--------------|
| `identifiers` | escape, column, table, aliased | Identifier quoting; `table()` also applies `namespace` |
| `literals` | value, null, true, false, list, json | Value formatting |
| `operators` | eq, neq, like, ilike, in, between, and, or | WHERE conditions |
| `json` | object, array, agg, extract | **Nested includes!** |
| `arrays` | literal, has, hasEvery, hasSome | Array operations |
| `aggregates` | count, sum, avg, min, max | Aggregate queries |
| `orderBy` | asc, desc, nullsFirst, nullsLast | Sorting |
| `clauses` | select, where, orderBy, limit | Query structure |
| `subqueries` | scalar, correlate, existsCheck | Relation filters |
| `mutations` | insert, update, delete, returning | Write operations |

---

## Core Rules

### Rule 1: All Methods Return Sql Fragments
Every adapter method takes primitives/Sql and returns Sql. Never return strings. Fragments preserve parameterization.

`mutations.insert` accepts either literal row tuples or `{ select: Sql }`.
Adapters own the dialect spelling of both `INSERT ... VALUES` and
`INSERT ... SELECT`; query-engine code must not hand-build either form.

### Rule 2: Implement for ALL Databases
Every interface method MUST be implemented in postgres, mysql, AND sqlite. TypeScript enforces this, but incomplete implementations can return wrong results.

### Rule 3: No Query Logic
Adapters transform syntax only. Don't decide which tables to join or what conditions to apply - that's query engine's job.

### Rule 4: Test Across All Databases
A change that works in PostgreSQL might break MySQL or SQLite. Always run the full test suite.

### Rule 5: The Adapter Owns The One Namespace Fact
`adapter.namespace` is the sole normalized SQL qualification value — a
PostgreSQL schema, a MySQL database, a requested Vitess keyspace qualifier.
`PostgresAdapter` defaults it to `public`; `MySQLAdapter` leaves it `undefined`
when unbound; SQLite adapters carry no such property at all (`"namespace" in
sqliteAdapter === false`). It is selected once in the constructor and installed
non-writable, and THAT INSTALL is where its immutability lives — not in a ban on
copies: models, relations, query scopes, operation programs, result types,
journals, cache identity, and instrumentation all read it or do without it, and
the two readers that capture it once — the bound migration driver at bind time
(`getMigrationDriver`), and the `dbAttributes` snapshot a cached read takes at
`$withCache` — are safe precisely because the property they read cannot be
reassigned under them.

`identifiers.table()` is the one renderer that applies it, and its alias is
optional. Everything statement-local — CTEs, aliases, columns, constraints,
temporaries — goes through `escape()`, which must never become namespace-aware.
Compose the qualified text through `renderQualifiedIdentifier` /
`createQualifiedIdentifierRenderer` in `src/sql/identifiers.ts`; never build
`schema.table` by hand, and never hand a dotted name to a quoter.

Do not add a second configurable namespace source, a per-model or per-query
namespace, a compatibility alias (`databaseSchema`, `databaseName`,
`databaseNamespace`, `pgSchema`, `keyspace`, `searchPath`), or a SQLite
attachment equivalent. Runtime emits neither `SET search_path` nor `USE`.

---

## Database Capability Matrix

| Feature | PostgreSQL | MySQL | SQLite | Handling |
|---------|:----------:|:-----:|:------:|----------|
| RETURNING | ✅ | ❌ | ✅ (3.35+) | MySQL: follow-up SELECT |
| Native arrays | ✅ | ❌ | ❌ | Use JSON columns |
| JSON functions | ✅ | ✅ (8.0+) | ✅ (3.38+) | All supported |
| ILIKE | ✅ | ❌ | ❌ | MySQL/SQLite: COLLATE |
| NULLS FIRST/LAST | ✅ | ❌ | ❌ | Emulate with `(col IS NULL)` sort key |

**Important:** When PostgreSQL has a feature others lack, the adapter must either emulate it or the capability check must prevent its use.

---

## Anti-Patterns

### Query Logic in Adapter
Putting WHERE clause construction or JOIN decisions in adapter. Adapters only transform syntax, not structure. If you're writing control flow, it belongs in query-engine.

### Returning Strings Instead of Sql
Returning raw strings breaks composition and parameterization. Always return `Sql` fragments.

### Assuming PostgreSQL Features
Using RETURNING, native arrays, or ILIKE without checking capability. MySQL lacks all three. Your PostgreSQL tests pass but MySQL users hit errors.

### Copy-Paste Between Adapters
Copying implementation between databases without adjusting syntax. Each dialect has quirks. Review carefully.

### Incomplete Method Groups
Adding a method to PostgreSQL but forgetting MySQL/SQLite. All 3 must implement every interface method.

---

## Common Tasks

### Adding New Adapter Method

1. **Define in interface** (`database-adapter.ts`):
   ```typescript
   myNewOp(left: Sql, right: Sql): Sql;
   ```

2. **Implement in PostgreSQL** (`databases/postgres/postgres-adapter.ts`)

3. **Implement in MySQL** (`databases/mysql/mysql-adapter.ts`)

4. **Implement in SQLite** (`databases/sqlite/sqlite-adapter.ts`)

5. **Use in query-engine** via `ctx.adapter.myNewOp()`

6. **Test on all 3 databases**

### Debugging Dialect Issues

If a query works in PostgreSQL but fails in MySQL:
1. Log the generated SQL: `console.log(sql.text, sql.values)`
2. Compare output between adapters
3. Check the capability matrix - is the feature supported?
4. Look for hardcoded syntax that slipped through

---

## Critical Dialect Differences (Detail)

### JSON Aggregation

This is the #1 source of multi-database bugs. Used for every nested include.

```sql
-- PostgreSQL
COALESCE(json_agg("t1".*), '[]'::json)

-- MySQL  
COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id', t1.id, ...)), JSON_ARRAY())

-- SQLite
COALESCE(json_group_array(json_object('id', t1.id, ...)), json_array())
```

### Identifier Quoting

```sql
-- PostgreSQL/SQLite
SELECT "user"."email" FROM "users" AS "user"

-- MySQL
SELECT `user`.`email` FROM `users` AS `user`
```

### Boolean Literals

```sql
-- PostgreSQL
WHERE "active" = TRUE

-- MySQL/SQLite
WHERE `active` = 1
```

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Query Engine** ([query-engine/AGENTS.md](../query-engine/AGENTS.md)) | Calls adapter methods. **CRITICAL BOUNDARY!** |
| **Migrations** ([migrations/AGENTS.md](../migrations/AGENTS.md)) | Uses adapter for DDL generation |
| **SQL Utils** (`src/sql/`) | Provides Sql template tag for composition |
| **Drivers** | Executes the SQL that adapters generate |
