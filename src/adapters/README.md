# Database Adapters

The adapter layer provides a **monadic, composable interface** for database-specific SQL generation. Each adapter method is a pure function that transforms SQL fragments or primitives into new SQL fragments, enabling clean composition without side effects.

## Design Principles

1. **Pure Functions**: Same inputs always produce same outputs
2. **Composable**: Outputs can be inputs to other methods
3. **Database-Agnostic Inputs**: Query engine speaks a neutral language
4. **Database-Specific Outputs**: Adapter handles syntax differences

The query engine calls adapter methods to build SQL fragments, then composes them into complete queries. The adapter never needs to understand query semantics - just SQL syntax.

---

## Supported Databases

| Database | Adapter Class | Min Version |
|----------|---------------|-------------|
| PostgreSQL | `PostgresAdapter` | 12+ |
| MySQL | `MySQLAdapter` | 8.0+ (requires JSON functions) |
| SQLite | `SQLiteAdapter` | 3.38+ (requires JSON functions) |

---

## Interface Sections

### `raw`

Escape hatch for raw SQL strings. Use sparingly.

```ts
adapter.raw("CURRENT_TIMESTAMP")
// → CURRENT_TIMESTAMP
```

### `identifiers`

Database-specific identifier escaping.

```ts
// Escape single identifier
adapter.identifiers.escape("users")
// PostgreSQL/SQLite → "users"
// MySQL → `users`

// Qualified column reference
adapter.identifiers.column("t0", "name")
// PostgreSQL/SQLite → "t0"."name"
// MySQL → `t0`.`name`

// Table with alias
adapter.identifiers.table("users", "t0")
// PostgreSQL/SQLite → "users" AS "t0"
// MySQL → `users` AS `t0`

// Aliased expression
adapter.identifiers.aliased(someExpr, "total")
// → someExpr AS "total" (or `total` for MySQL)
```

### `literals`

Value wrapping with proper parameterization.

```ts
adapter.literals.value("hello")  // → $1 (parameterized)
adapter.literals.null()          // → NULL
adapter.literals.true()          // → TRUE (PG/MySQL) or 1 (SQLite)
adapter.literals.false()         // → FALSE (PG/MySQL) or 0 (SQLite)
adapter.literals.list([a, b, c]) // → (a, b, c)
```

### `operators`

Comparison and logical operators.

```ts
// Comparison
adapter.operators.eq(left, right)      // → left = right
adapter.operators.neq(left, right)     // → left <> right
adapter.operators.lt(left, right)      // → left < right
adapter.operators.lte(left, right)     // → left <= right
adapter.operators.gt(left, right)      // → left > right
adapter.operators.gte(left, right)     // → left >= right

// Pattern matching
adapter.operators.like(col, pattern)      // → col LIKE pattern
adapter.operators.ilike(col, pattern)     // → col ILIKE pattern (PG)
                                          // → col LIKE pattern COLLATE utf8mb4_unicode_ci (MySQL)
                                          // → col LIKE pattern COLLATE NOCASE (SQLite)

// Set membership
adapter.operators.in(col, values)      // → col = ANY(values) (PG) or col IN values
adapter.operators.notIn(col, values)   // → col <> ALL(values) (PG) or col NOT IN values

// Null checks
adapter.operators.isNull(expr)         // → expr IS NULL
adapter.operators.isNotNull(expr)      // → expr IS NOT NULL

// Range
adapter.operators.between(col, min, max)     // → col BETWEEN min AND max
adapter.operators.notBetween(col, min, max)  // → col NOT BETWEEN min AND max

// Logical
adapter.operators.and(a, b, c)    // → (a AND b AND c)
adapter.operators.or(a, b, c)     // → (a OR b OR c)
adapter.operators.not(condition)  // → NOT (condition)

// Subquery existence
adapter.operators.exists(subquery)     // → EXISTS (subquery)
adapter.operators.notExists(subquery)  // → NOT EXISTS (subquery)
```

### `expressions`

Computed values and functions.

```ts
// Arithmetic
adapter.expressions.add(a, b)       // → (a + b)
adapter.expressions.subtract(a, b)  // → (a - b)
adapter.expressions.multiply(a, b)  // → (a * b)
adapter.expressions.divide(a, b)    // → (a / b)

// String operations
adapter.expressions.concat(a, b, c) // → (a || b || c) (PG/SQLite)
                                    // → CONCAT(a, b, c) (MySQL)
adapter.expressions.upper(expr)     // → UPPER(expr)
adapter.expressions.lower(expr)     // → LOWER(expr)

// Utility
adapter.expressions.coalesce(a, b)  // → COALESCE(a, b)
adapter.expressions.greatest(a, b)  // → GREATEST(a, b) (PG/MySQL) or MAX(a, b) (SQLite)
adapter.expressions.least(a, b)     // → LEAST(a, b) (PG/MySQL) or MIN(a, b) (SQLite)
adapter.expressions.cast(expr, "INTEGER") // → CAST(expr AS INTEGER)
```

### `aggregates`

Aggregate functions.

```ts
adapter.aggregates.count()           // → COUNT(*)
adapter.aggregates.count(expr)       // → COUNT(expr)
adapter.aggregates.countDistinct(expr) // → COUNT(DISTINCT expr)
adapter.aggregates.sum(expr)         // → SUM(expr)
adapter.aggregates.avg(expr)         // → AVG(expr)
adapter.aggregates.min(expr)         // → MIN(expr)
adapter.aggregates.max(expr)         // → MAX(expr)
```

### `json`

JSON building and extraction. **Critical for nested includes.**

```ts
// Build JSON object from key-value pairs
adapter.json.object([["id", idExpr], ["name", nameExpr]])
// PostgreSQL → json_build_object('id', idExpr, 'name', nameExpr)
// MySQL → JSON_OBJECT('id', idExpr, 'name', nameExpr)
// SQLite → json_object('id', idExpr, 'name', nameExpr)

// Build JSON array
adapter.json.array([a, b, c])
// PostgreSQL → json_build_array(a, b, c)
// MySQL → JSON_ARRAY(a, b, c)
// SQLite → json_array(a, b, c)

// Aggregate rows into JSON array (with empty array fallback)
adapter.json.agg(jsonExpr)
// PostgreSQL → COALESCE(json_agg(jsonExpr), '[]'::json)
// MySQL → COALESCE(JSON_ARRAYAGG(jsonExpr), JSON_ARRAY())
// SQLite → COALESCE(json_group_array(jsonExpr), json_array())

// Build JSON from explicit columns (same as object, use for clarity)
adapter.json.objectFromColumns([["id", idCol], ["name", nameCol]])

// Extract value from JSON
adapter.json.extract(col, ["user", "name"])
// PostgreSQL → col#>'{user,name}'
// MySQL → JSON_EXTRACT(col, '$.user.name')
// SQLite → json_extract(col, '$.user.name')
```

### `arrays`

Array operations. PostgreSQL uses native arrays, MySQL/SQLite use JSON arrays.

```ts
// Create array literal
adapter.arrays.literal([a, b, c])
// PostgreSQL → ARRAY[a, b, c]
// MySQL/SQLite → JSON_ARRAY(a, b, c) / json_array(a, b, c)

// Check if array contains value
adapter.arrays.has(col, value)
// PostgreSQL → value = ANY(col)
// MySQL → JSON_CONTAINS(col, value)
// SQLite → EXISTS (SELECT 1 FROM json_each(col) WHERE value = value)

// Check if array contains ALL values
adapter.arrays.hasEvery(col, values)
// PostgreSQL → col @> values
// MySQL → JSON_CONTAINS(col, values)

// Check if array contains ANY value
adapter.arrays.hasSome(col, values)
// PostgreSQL → col && values
// MySQL → JSON_OVERLAPS(col, values)

// Array utilities
adapter.arrays.isEmpty(col)   // Check if empty or NULL
adapter.arrays.length(col)    // Get array length
adapter.arrays.get(col, idx)  // Get element at index
adapter.arrays.push(col, val) // Append value
adapter.arrays.set(col, idx, val) // Set value at index
```

### `orderBy`

Ordering helpers.

```ts
adapter.orderBy.asc(col)        // → col ASC
adapter.orderBy.desc(col)       // → col DESC
adapter.orderBy.nullsFirst(expr) // → expr NULLS FIRST (PG only, no-op elsewhere)
adapter.orderBy.nullsLast(expr)  // → expr NULLS LAST (PG only, no-op elsewhere)
```

### `clauses`

SQL clause keywords.

```ts
adapter.clauses.select(cols)         // → SELECT cols
adapter.clauses.selectDistinct(cols) // → SELECT DISTINCT cols
adapter.clauses.from(table)          // → FROM table
adapter.clauses.where(cond)          // → WHERE cond
adapter.clauses.orderBy(orders)      // → ORDER BY orders
adapter.clauses.limit(n)             // → LIMIT n
adapter.clauses.offset(n)            // → OFFSET n
adapter.clauses.groupBy(cols)        // → GROUP BY cols
adapter.clauses.having(cond)         // → HAVING cond
```

### `set`

UPDATE SET operations.

```ts
adapter.set.assign(col, value)     // → col = value
adapter.set.increment(col, by)     // → col = col + by
adapter.set.decrement(col, by)     // → col = col - by
adapter.set.multiply(col, by)      // → col = col * by
adapter.set.divide(col, by)        // → col = col / by
adapter.set.push(col, value)       // → col = array_append(col, value) (PG)
                                   // → col = JSON_ARRAY_APPEND(col, '$', value) (MySQL)
```

### `filters`

Relation filter wrappers for subqueries.

```ts
// To-many relation filters
adapter.filters.some(subquery)  // → EXISTS (subquery)
adapter.filters.every(subquery) // → NOT EXISTS (subquery) [with negated inner condition]
adapter.filters.none(subquery)  // → NOT EXISTS (subquery)

// To-one relation filters
adapter.filters.is(subquery)    // → EXISTS (subquery)
adapter.filters.isNot(subquery) // → NOT EXISTS (subquery)
```

### `subqueries`

Subquery wrappers.

```ts
adapter.subqueries.scalar(query)        // → (query)
adapter.subqueries.correlate(query, alias) // → (query) AS "alias"
adapter.subqueries.existsCheck(from, where) // → SELECT 1 FROM from WHERE where
```

### `assemble`

Build complete SQL statements from parts.

```ts
adapter.assemble.select({
  columns: columnsExpr,
  from: tableExpr,
  joins: [join1, join2],  // optional
  where: whereExpr,       // optional
  groupBy: groupExpr,     // optional
  having: havingExpr,     // optional
  orderBy: orderExpr,     // optional
  limit: limitExpr,       // optional
  offset: offsetExpr,     // optional
})
// → SELECT columns FROM table JOIN ... WHERE ... GROUP BY ... ORDER BY ... LIMIT ... OFFSET ...
```

### `cte`

Common Table Expressions.

```ts
// Simple CTE
adapter.cte.with([
  { name: "active_users", query: activeUsersQuery }
])
// → WITH "active_users" AS (...)

// Recursive CTE
adapter.cte.recursive("tree", anchorQuery, recursiveQuery)
// → WITH RECURSIVE "tree" AS (anchor UNION ALL recursive)
```

### `mutations`

Insert, Update, Delete operations.

```ts
// Insert
adapter.mutations.insert(table, ["col1", "col2"], [[val1, val2], [val3, val4]])
// → INSERT INTO table ("col1", "col2") VALUES (val1, val2), (val3, val4)

// Update
adapter.mutations.update(table, setsExpr, whereExpr)
// → UPDATE table SET ... WHERE ...

// Delete
adapter.mutations.delete(table, whereExpr)
// → DELETE FROM table WHERE ...

// Returning (for getting back mutated rows)
adapter.mutations.returning(cols)
// PostgreSQL/SQLite → RETURNING cols
// MySQL → (empty - not supported)

// Upsert
adapter.mutations.onConflict(target, action)
// PostgreSQL/SQLite → ON CONFLICT (target) DO action
// MySQL → ON DUPLICATE KEY UPDATE action
```

### `joins`

Join operations.

```ts
adapter.joins.inner(table, condition) // → INNER JOIN table ON condition
adapter.joins.left(table, condition)  // → LEFT JOIN table ON condition
adapter.joins.right(table, condition) // → RIGHT JOIN table ON condition (LEFT for SQLite)
adapter.joins.full(table, condition)  // → FULL OUTER JOIN (LEFT for MySQL/SQLite)
adapter.joins.cross(table)            // → CROSS JOIN table
```

---

## Building Nested Includes (Prisma-like)

The query engine builds nested JSON structures using `json.objectFromColumns` and `json.agg`:

```ts
// For a query like:
// findFirst({
//   select: { name: true, posts: { select: { title: true } } }
// })

// 1. Build innermost subquery (posts)
const postsJson = adapter.json.agg(
  adapter.json.objectFromColumns([
    ['title', adapter.identifiers.column('t1', 'title')]
  ])
);

const postsSubquery = adapter.subqueries.scalar(
  adapter.assemble.select({
    columns: postsJson,
    from: adapter.identifiers.table('posts', 't1'),
    where: adapter.operators.eq(
      adapter.identifiers.column('t1', 'authorId'),
      adapter.identifiers.column('t0', 'id')
    )
  })
);

// 2. Build main query with nested JSON
const mainQuery = adapter.assemble.select({
  columns: adapter.json.objectFromColumns([
    ['name', adapter.identifiers.column('t0', 'name')],
    ['posts', postsSubquery]
  ]),
  from: adapter.identifiers.table('users', 't0'),
  where: whereCondition,
  limit: sql`1`
});
```

This produces (PostgreSQL):
```sql
SELECT json_build_object(
  'name', "t0"."name",
  'posts', (
    SELECT COALESCE(json_agg(json_build_object('title', "t1"."title")), '[]'::json)
    FROM "posts" AS "t1"
    WHERE "t1"."authorId" = "t0"."id"
  )
)
FROM "users" AS "t0"
WHERE ...
LIMIT 1
```

---

## Database-Specific Limitations

### PostgreSQL

Full feature support. No limitations.

### MySQL

**RETURNING not supported**
- `adapter.mutations.returning()` returns empty SQL
- Query engine must execute a separate SELECT after INSERT/UPDATE to fetch mutated rows
- Use `LAST_INSERT_ID()` for auto-increment IDs

**NULLS FIRST/LAST not supported**
- `adapter.orderBy.nullsFirst/Last()` returns the expression unchanged (no-op)
- NULL ordering follows MySQL defaults (NULLs sort first in ASC)

**FULL OUTER JOIN not supported**
- `adapter.joins.full()` falls back to LEFT JOIN
- For true FULL OUTER JOIN, use UNION of LEFT and RIGHT joins

**Array type uses JSON**
- No native ARRAY type
- All array operations use JSON functions
- Scalar list fields stored as JSON columns

### SQLite

**RETURNING requires SQLite 3.35+**
- Supported in modern SQLite versions

**NULLS FIRST/LAST not supported**
- Same as MySQL - returns no-op

**RIGHT JOIN not supported**
- `adapter.joins.right()` falls back to LEFT JOIN
- Swap table order manually if needed

**FULL OUTER JOIN not supported**
- Same as MySQL - falls back to LEFT JOIN

**Array type uses JSON**
- Same as MySQL - uses JSON functions
- Requires SQLite 3.38+ for full JSON support

**GREATEST/LEAST use MAX/MIN**
- `adapter.expressions.greatest()` uses `MAX()`
- `adapter.expressions.least()` uses `MIN()`
- Behavior differs slightly for NULL handling

---

## Query Engine Responsibilities

The adapter handles SQL syntax differences. The query engine must handle:

1. **MySQL RETURNING workaround**: Execute SELECT after mutations
2. **JSON result parsing**: MySQL/SQLite may return JSON as strings - parse if needed
3. **Feature degradation**: Document features that don't work on all databases
4. **Transaction management**: All databases support transactions, but syntax varies slightly

---

## Usage

```ts
import { PostgresAdapter, MySQLAdapter, SQLiteAdapter } from "@adapters";

// Choose adapter based on database
const adapter = new PostgresAdapter();
// or
const adapter = new MySQLAdapter();
// or
const adapter = new SQLiteAdapter();

// Use adapter methods to build queries
const query = adapter.assemble.select({
  columns: adapter.identifiers.column("t0", "name"),
  from: adapter.identifiers.table("users", "t0"),
  where: adapter.operators.eq(
    adapter.identifiers.column("t0", "id"),
    adapter.literals.value(userId)
  )
});
```

