# Query Engine

The query engine validates input, builds SQL using the database adapter, and parses results into typed objects.

## Architecture

```
query-engine/
├── index.ts                      # Public exports
├── types.ts                      # Shared types
├── query-engine.ts               # Main orchestrator
├── validator.ts                  # Single validator using model schemas
│
├── context/
│   ├── index.ts
│   ├── alias-generator.ts        # Generates t0, t1, t2... aliases
│   └── query-context.ts          # Holds adapter, model, registry
│
├── builders/
│   ├── index.ts
│   ├── where-builder.ts          # WHERE clauses
│   ├── relation-filter-builder.ts # some/every/none/is/isNot
│   ├── select-builder.ts         # SELECT columns
│   ├── include-builder.ts        # Nested relation subqueries
│   ├── orderby-builder.ts        # ORDER BY clauses
│   ├── values-builder.ts         # VALUES for INSERT
│   └── set-builder.ts            # SET for UPDATE
│
├── operations/
│   ├── index.ts
│   ├── find-first.ts
│   ├── find-many.ts
│   ├── find-unique.ts
│   ├── create.ts
│   ├── update.ts
│   ├── delete.ts
│   ├── upsert.ts
│   └── count.ts
│
└── result/
    ├── index.ts
    └── result-parser.ts          # JSON parsing, type coercion
```

## Usage

### Basic Usage

```ts
import { createQueryEngine, PostgresAdapter } from "viborm";

// Create engine with adapter and models
const engine = createQueryEngine(
  new PostgresAdapter(),
  { user: userModel, post: postModel },
  connection // optional - for execution
);

// Build SQL without executing
const sql = engine.build(userModel, "findMany", {
  where: { name: { contains: "Alice" } },
  include: { posts: true },
  orderBy: { createdAt: "desc" },
  take: 10,
});

// Execute and get parsed result
const users = await engine.execute(userModel, "findMany", {
  where: { name: { contains: "Alice" } },
});
```

### Supported Operations

| Operation | Description |
|-----------|-------------|
| `findFirst` | Find single record matching criteria |
| `findMany` | Find multiple records |
| `findUnique` | Find by unique identifier |
| `create` | Insert single record |
| `createMany` | Insert multiple records |
| `update` | Update single record by unique key |
| `updateMany` | Update multiple records |
| `delete` | Delete single record by unique key |
| `deleteMany` | Delete multiple records |
| `upsert` | Insert or update on conflict |
| `count` | Count matching records |

### Input Validation

All inputs are validated against model schemas:

```ts
import { validate } from "viborm/query-engine";

try {
  const validated = validate(userModel, "findMany", input);
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(error.details); // Detailed validation error
  }
}
```

## Builders

### Where Builder

Builds WHERE clauses from filter objects:

```ts
import { buildWhere } from "viborm/query-engine";

const where = buildWhere(ctx, {
  name: { contains: "Alice" },
  age: { gte: 18 },
  posts: { some: { published: true } },
}, "t0");
```

Supported filters:
- **Scalar**: equals, not, gt, gte, lt, lte, in, notIn
- **String**: contains, startsWith, endsWith
- **Array**: has, hasEvery, hasSome, isEmpty
- **Logical**: AND, OR, NOT
- **Relations**: some, every, none, is, isNot

### Select Builder

Builds SELECT columns with JSON for relations:

```ts
import { buildSelect, buildSelectAsJson } from "viborm/query-engine";

// Regular columns
const cols = buildSelect(ctx, { name: true, email: true }, undefined, "t0");

// As JSON object (for subqueries)
const json = buildSelectAsJson(ctx, { name: true, email: true }, undefined, "t0");
```

### Include Builder

Builds nested relation subqueries:

```ts
import { buildInclude } from "viborm/query-engine";

const include = buildInclude(ctx, relationInfo, {
  select: { title: true },
  where: { published: true },
  orderBy: { createdAt: "desc" },
  take: 5,
}, "t0");
```

### Order By Builder

```ts
import { buildOrderBy } from "viborm/query-engine";

const orderBy = buildOrderBy(ctx, [
  { createdAt: "desc" },
  { name: "asc" },
], "t0");
```

### Set Builder

Builds SET clause for UPDATE:

```ts
import { buildSet } from "viborm/query-engine";

const set = buildSet(ctx, {
  name: "New Name",
  views: { increment: 1 },
  tags: { push: "new-tag" },
});
```

## Result Parsing

Results are automatically parsed:

- JSON strings (MySQL/SQLite) are parsed to objects
- Null values are coalesced for optional relations
- Empty arrays for missing to-many relations

```ts
import { parseResult } from "viborm/query-engine";

const users = parseResult<User[]>(ctx, "findMany", rawResult);
```

## Query Context

The context holds shared state for query building:

```ts
interface QueryContext {
  adapter: DatabaseAdapter;    // SQL generation
  model: Model<any>;          // Current model
  registry: ModelRegistry;    // Access related models
  nextAlias: () => string;    // Generate t1, t2, ...
  rootAlias: string;          // Root alias (t0)
}
```

## Cross-Database Support

The query engine works with all supported adapters:

| Feature | PostgreSQL | MySQL | SQLite |
|---------|:----------:|:-----:|:------:|
| JSON aggregation | ✅ | ✅ | ✅ |
| Nested includes | ✅ | ✅ | ✅ |
| Relation filters | ✅ | ✅ | ✅ |
| RETURNING clause | ✅ | ❌ | ✅ |
| Array operations | ✅ native | ✅ JSON | ✅ JSON |

For MySQL (no RETURNING), mutations return the input data or require a follow-up SELECT.

