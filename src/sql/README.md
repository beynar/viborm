# SQL Template Literals

A safe and composable SQL query builder using ES6 template literals, forked from [`sql-template-tag`](https://github.com/blakeembrey/sql-template-tag).

## Basic Usage

```typescript
import sql from "./sql";

// Simple query with parameters
const query = sql`SELECT * FROM users WHERE id = ${userId}`;
console.log(query.text); // "SELECT * FROM users WHERE id = $1"
console.log(query.values); // [42]

// Multiple parameters
const name = "John";
const age = 25;
const query2 = sql`SELECT * FROM users WHERE name = ${name} AND age > ${age}`;
console.log(query2.text); // "SELECT * FROM users WHERE name = $1 AND age > $2"
console.log(query2.values); // ["John", 25]
```

## Composable Queries

The power of this library comes from composing SQL fragments:

```typescript
import sql from "./sql";

// Build WHERE conditions dynamically
const conditions = [];
if (name) conditions.push(sql`name = ${name}`);
if (minAge) conditions.push(sql`age >= ${minAge}`);

const whereClause =
  conditions.length > 0 ? sql`WHERE ${sql.join(conditions, " AND ")}` : sql``;

const query = sql`
  SELECT * FROM users 
  ${whereClause}
  ORDER BY created_at DESC
`;
```

## Database-Specific Output

The library supports multiple parameter placeholder formats:

```typescript
const query = sql`SELECT * FROM users WHERE id = ${userId}`;

// PostgreSQL style ($1, $2, ...)
console.log(query.text); // "SELECT * FROM users WHERE id = $1"

// MySQL style (?, ?, ...)
console.log(query.sql); // "SELECT * FROM users WHERE id = ?"

// Named parameters (:1, :2, ...)
console.log(query.statement); // "SELECT * FROM users WHERE id = :1"
```

## Utility Functions

### `sql.join()`

Join multiple SQL fragments with a separator:

```typescript
const fields = ["name", "email", "age"];
const fieldList = sql.join(
  fields.map((field) => sql`${sql.raw(field)}`),
  ", "
);

const query = sql`SELECT ${fieldList} FROM users`;
// Result: "SELECT name, email, age FROM users"
```

### `sql.bulk()`

Insert multiple rows efficiently:

```typescript
const users = [
  ["John", 25, "john@example.com"],
  ["Jane", 30, "jane@example.com"],
];

const query = sql`
  INSERT INTO users (name, age, email) 
  VALUES ${sql.bulk(users)}
`;
// Result: "INSERT INTO users (name, age, email) VALUES ($1, $2, $3), ($4, $5, $6)"
```

### `sql.raw()`

Insert raw SQL (use carefully!):

```typescript
const tableName = "users";
const query = sql`SELECT * FROM ${sql.raw(tableName)}`;
// Result: "SELECT * FROM users" (no parameter binding for table name)
```

### `sql.empty`

Placeholder for conditional SQL:

```typescript
const orderBy = shouldOrder ? sql`ORDER BY name` : sql.empty;
const query = sql`SELECT * FROM users ${orderBy}`;
```

## Security Features

### Automatic Parameter Binding

All interpolated values are automatically parameterized:

```typescript
const maliciousInput = "'; DROP TABLE users; --";
const query = sql`SELECT * FROM users WHERE name = ${maliciousInput}`;
// Safe: produces parameterized query, not string concatenation
console.log(query.text); // "SELECT * FROM users WHERE name = $1"
console.log(query.values); // ["'; DROP TABLE users; --"]
```

### Safe Composition

Nested SQL fragments are safely merged:

```typescript
const whereClause = sql`age > ${18}`;
const havingClause = sql`COUNT(*) > ${5}`;

const query = sql`
  SELECT name, COUNT(*) 
  FROM users 
  WHERE ${whereClause}
  GROUP BY name 
  HAVING ${havingClause}
`;
// All parameters are properly collected and indexed
```

## Integration with BaseORM Adapters

This SQL builder integrates seamlessly with BaseORM's adapter system:

```typescript
// In database adapters
class PostgresDatabaseAdapter {
  buildSelectQuery(params) {
    const whereClause = this.buildWhereClause(params.where);
    const orderClause = this.buildOrderClause(params.orderBy);

    return sql`
      SELECT * FROM ${sql.raw(params.table)}
      ${whereClause}
      ${orderClause}
      ${params.limit ? sql`LIMIT ${params.limit}` : sql.empty}
    `;
  }

  private buildWhereClause(conditions) {
    if (!conditions) return sql.empty;

    const clauses = Object.entries(conditions).map(
      ([field, value]) => sql`${sql.raw(field)} = ${value}`
    );

    return sql`WHERE ${sql.join(clauses, " AND ")}`;
  }
}
```

## Best Practices

1. **Always use template literals** for dynamic queries
2. **Use `sql.raw()`** only for trusted identifiers (table/column names)
3. **Compose complex queries** from smaller fragments
4. **Validate inputs** before passing to SQL functions
5. **Use appropriate output format** for your database (`.text` for PostgreSQL, `.sql` for MySQL)

## Type Safety

The library is fully typed for TypeScript:

```typescript
import sql, { Sql, Value, RawValue } from "./sql";

// Type-safe usage
const query: Sql = sql`SELECT * FROM users WHERE id = ${userId}`;
const values: Value[] = query.values;
const sqlString: string = query.text;
```

This SQL template literal system provides the foundation for BaseORM's secure and composable query building capabilities.
