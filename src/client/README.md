# VibORM Client

The client module provides a fully type-safe, Prisma-like API for querying and mutating data. All operations are type-inferred from your schema definitions — no code generation required.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Operations Reference](#operations-reference)
   - [Query Operations](#query-operations)
   - [Mutation Operations](#mutation-operations)
   - [Aggregate Operations](#aggregate-operations)
3. [Filtering](#filtering)
   - [Common Filter Operators](#common-filter-operators)
   - [String Filters](#string-filters)
   - [Number Filters](#number-filters)
   - [Boolean Filters](#boolean-filters)
   - [DateTime Filters](#datetime-filters)
   - [BigInt Filters](#bigint-filters)
   - [JSON Filters](#json-filters)
   - [Array Field Filters](#array-field-filters)
   - [Logical Operators](#logical-operators)
4. [Relation Filtering](#relation-filtering)
   - [To-One Relations](#to-one-relations-onetoone-manytoone)
   - [To-Many Relations](#to-many-relations-onetomany-manytomany)
5. [Selecting Fields](#selecting-fields)
   - [Basic Select](#basic-select)
   - [Nested Select](#nested-select)
6. [Including Relations](#including-relations)
   - [Basic Include](#basic-include)
   - [Nested Include](#nested-include)
   - [Filtering Included Relations](#filtering-included-relations)
7. [Sorting](#sorting)
8. [Pagination](#pagination)
9. [Unique Identifiers](#unique-identifiers)
   - [Single-Field Unique](#single-field-unique)
   - [Compound Keys](#compound-keys)
10. [Nested Writes](#nested-writes)
    - [Create with Relations](#create-with-relations)
    - [Update with Relations](#update-with-relations)

---

## Quick Start

```ts
import { createClient, s } from "viborm";
import { PostgresAdapter } from "viborm/adapters/postgres";

// Define schema
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  name: s.string().nullable(),
  posts: s.relation.oneToMany(() => post),
}).map("users");

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  published: s.boolean().default(false),
  authorId: s.string(),
  author: s.relation
    .fields("authorId")
    .references("id")
    .manyToOne(() => user),
}).map("posts");

// Create client
const client = createClient({
  schema: { user, post },
  adapter: new PostgresAdapter({ connectionString: "..." }),
});

// Query with full type safety
const users = await client.user.findMany({
  where: { email: { contains: "@example.com" } },
  include: { posts: true },
});
```

---

## Operations Reference

### Query Operations

| Operation | Description | Returns |
|-----------|-------------|---------|
| `findMany` | Find multiple records matching criteria | `T[]` |
| `findFirst` | Find first record matching criteria | `T \| null` |
| `findUnique` | Find record by unique identifier | `T \| null` |
| `findFirstOrThrow` | Find first or throw if not found | `T` |
| `findUniqueOrThrow` | Find unique or throw if not found | `T` |
| `exist` | Check if any records match criteria | `boolean` |

```ts
// findMany - multiple records
const users = await client.user.findMany({
  where: { role: "admin" },
  orderBy: { createdAt: "desc" },
  take: 10,
  skip: 0,
});

// findFirst - single record or null
const user = await client.user.findFirst({
  where: { email: { contains: "alice" } },
});

// findUnique - by unique field
const user = await client.user.findUnique({
  where: { id: "user_123" },
});

// findUnique - by compound key
const membership = await client.membership.findUnique({
  where: { orgId_userId: { orgId: "org_1", userId: "user_1" } },
});

// findFirstOrThrow - throws NotFoundError if no match
const user = await client.user.findFirstOrThrow({
  where: { email: "alice@example.com" },
});

// exist - boolean check
const hasAdmins = await client.user.exist({
  where: { role: "admin" },
});
```

### Mutation Operations

| Operation | Description | Returns |
|-----------|-------------|---------|
| `create` | Create a new record | `T` |
| `createMany` | Create multiple records | `{ count: number }` |
| `update` | Update a single record | `T` |
| `updateMany` | Update multiple records | `{ count: number }` |
| `delete` | Delete a single record | `T` |
| `deleteMany` | Delete multiple records | `{ count: number }` |
| `upsert` | Create or update a record | `T` |

```ts
// create - single record
const user = await client.user.create({
  data: {
    email: "alice@example.com",
    name: "Alice",
  },
});

// createMany - batch insert
const result = await client.user.createMany({
  data: [
    { email: "bob@example.com", name: "Bob" },
    { email: "carol@example.com", name: "Carol" },
  ],
  skipDuplicates: true, // Skip records that violate unique constraints
});
// result: { count: 2 }

// update - single record
const user = await client.user.update({
  where: { id: "user_123" },
  data: { name: "Alice Smith" },
});

// updateMany - batch update
const result = await client.user.updateMany({
  where: { role: "guest" },
  data: { role: "user" },
});
// result: { count: 42 }

// delete - single record
const user = await client.user.delete({
  where: { id: "user_123" },
});

// deleteMany - batch delete
const result = await client.user.deleteMany({
  where: { lastLogin: { lt: new Date("2023-01-01") } },
});
// result: { count: 15 }

// upsert - create or update
const user = await client.user.upsert({
  where: { email: "alice@example.com" },
  create: { email: "alice@example.com", name: "Alice" },
  update: { name: "Alice Updated" },
});
```

### Aggregate Operations

| Operation | Description | Returns |
|-----------|-------------|---------|
| `count` | Count matching records | `number` or `{ field: number }` |
| `aggregate` | Run aggregate functions | `{ _count, _avg, _sum, _min, _max }` |
| `groupBy` | Group and aggregate | Array of grouped results |

```ts
// count - total records
const total = await client.user.count({
  where: { role: "admin" },
});
// total: 5

// count - with field selection
const counts = await client.user.count({
  where: { role: "admin" },
  select: { _all: true, email: true },
});
// counts: { _all: 5, email: 5 }

// aggregate - multiple functions
const stats = await client.post.aggregate({
  where: { published: true },
  _count: true,
  _avg: { views: true },
  _sum: { views: true },
  _min: { createdAt: true },
  _max: { views: true },
});
// stats: { _count: 100, _avg: { views: 45.5 }, _sum: { views: 4550 }, ... }

// groupBy - group with aggregates
const byAuthor = await client.post.groupBy({
  by: ["authorId"],
  where: { published: true },
  _count: true,
  _avg: { views: true },
  orderBy: { _count: { views: "desc" } },
  having: { views: { _avg: { gt: 10 } } },
});
// byAuthor: [{ authorId: "user_1", _count: 5, _avg: { views: 100 } }, ...]
```

---

## Filtering

Filters are passed to the `where` argument. Each field type has specific filter operators.

### Common Filter Operators

These operators work on most scalar field types:

| Operator | Description | Example |
|----------|-------------|---------|
| `equals` | Exact match (also shorthand) | `{ status: "active" }` or `{ status: { equals: "active" } }` |
| `not` | Not equal | `{ status: { not: "deleted" } }` |
| `in` | Value in array | `{ status: { in: ["active", "pending"] } }` |
| `notIn` | Value not in array | `{ status: { notIn: ["deleted"] } }` |

### String Filters

```ts
// Shorthand - equals
{ email: "alice@example.com" }

// Explicit equals
{ email: { equals: "alice@example.com" } }

// Negation
{ email: { not: "admin@example.com" } }

// Array membership
{ role: { in: ["admin", "moderator"] } }
{ role: { notIn: ["banned", "deleted"] } }

// Pattern matching
{ email: { contains: "@gmail.com" } }
{ name: { startsWith: "Dr." } }
{ name: { endsWith: "PhD" } }

// Case-insensitive (PostgreSQL only)
{ email: { contains: "alice", mode: "insensitive" } }

// Comparison (lexicographic)
{ name: { lt: "M" } }    // Names before "M"
{ name: { gte: "A" } }   // Names starting with "A" or later
```

**String Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `equals` | `string` | Exact match |
| `not` | `string \| null` | Not equal |
| `in` | `string[]` | In array |
| `notIn` | `string[]` | Not in array |
| `contains` | `string` | Contains substring |
| `startsWith` | `string` | Starts with prefix |
| `endsWith` | `string` | Ends with suffix |
| `mode` | `"default" \| "insensitive"` | Case sensitivity |
| `lt` | `string` | Less than |
| `lte` | `string` | Less than or equal |
| `gt` | `string` | Greater than |
| `gte` | `string` | Greater than or equal |

### Number Filters

Works for `int`, `float`, and `decimal` fields.

```ts
// Shorthand - equals
{ age: 25 }

// Explicit equals
{ age: { equals: 25 } }

// Negation
{ age: { not: 0 } }

// Array membership
{ priority: { in: [1, 2, 3] } }

// Range queries
{ age: { gte: 18 } }           // >= 18
{ age: { lt: 65 } }            // < 65
{ price: { gte: 10, lte: 100 } } // Between 10 and 100

// Comparison operators
{ score: { gt: 50 } }    // Greater than
{ score: { lte: 100 } }  // Less than or equal
```

**Number Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `equals` | `number` | Exact match |
| `not` | `number \| null` | Not equal |
| `in` | `number[]` | In array |
| `notIn` | `number[]` | Not in array |
| `lt` | `number` | Less than |
| `lte` | `number` | Less than or equal |
| `gt` | `number` | Greater than |
| `gte` | `number` | Greater than or equal |

### Boolean Filters

```ts
// Shorthand - equals
{ published: true }

// Explicit equals
{ published: { equals: true } }

// Negation
{ active: { not: false } }

// Nullable boolean
{ verified: { equals: null } } // Find unverified users
```

**Boolean Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `equals` | `boolean` | Exact match |
| `not` | `boolean \| null` | Not equal |

### DateTime Filters

DateTime fields accept both `Date` objects and ISO 8601 strings.

```ts
// Shorthand - equals
{ createdAt: new Date("2024-01-01") }
{ createdAt: "2024-01-01T00:00:00Z" }  // ISO string also works

// Range queries
{ createdAt: { gte: new Date("2024-01-01") } }
{ createdAt: { lt: "2024-02-01" } }

// Last 7 days
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
{ createdAt: { gte: weekAgo } }

// Between dates
{
  createdAt: {
    gte: new Date("2024-01-01"),
    lt: new Date("2024-02-01"),
  }
}

// Not equal
{ updatedAt: { not: null } }  // Has been updated
```

**DateTime Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `equals` | `Date \| string` | Exact match |
| `not` | `Date \| string \| null` | Not equal |
| `in` | `(Date \| string)[]` | In array |
| `notIn` | `(Date \| string)[]` | Not in array |
| `lt` | `Date \| string` | Before |
| `lte` | `Date \| string` | Before or equal |
| `gt` | `Date \| string` | After |
| `gte` | `Date \| string` | After or equal |

### BigInt Filters

Same operators as numbers, but for `bigint` values.

```ts
{ largeNumber: { gte: 9007199254740992n } }
{ balance: { in: [1000n, 2000n, 3000n] } }
```

### JSON Filters

JSON fields support path-based filtering and special operators.

```ts
// Equality
{ metadata: { equals: { type: "premium" } } }

// Negation
{ settings: { not: null } }

// Path-based queries (PostgreSQL/MySQL specific)
{ metadata: { path: ["user", "preferences", "theme"], equals: "dark" } }

// String operations on JSON strings
{ data: { string_contains: "important" } }
{ data: { string_starts_with: "prefix" } }
{ data: { string_ends_with: "suffix" } }

// Array operations on JSON arrays
{ tags: { array_contains: "featured" } }
{ tags: { array_starts_with: "important" } }
{ tags: { array_ends_with: "archive" } }
```

**JSON Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `equals` | `JsonValue` | Deep equality |
| `not` | `JsonValue \| null` | Not equal |
| `path` | `string[]` | Path to nested value |
| `string_contains` | `string` | JSON string contains |
| `string_starts_with` | `string` | JSON string starts with |
| `string_ends_with` | `string` | JSON string ends with |
| `array_contains` | `JsonValue` | JSON array contains element |
| `array_starts_with` | `JsonValue` | JSON array starts with element |
| `array_ends_with` | `JsonValue` | JSON array ends with element |

### Array Field Filters

For fields defined with `.array()` (e.g., `s.string().array()`).

```ts
// Exact array match
{ tags: { equals: ["featured", "popular"] } }

// Has specific element
{ tags: { has: "featured" } }

// Has ALL specified elements
{ tags: { hasEvery: ["featured", "popular"] } }

// Has ANY of specified elements
{ tags: { hasSome: ["featured", "trending", "new"] } }

// Check if empty
{ tags: { isEmpty: true } }
{ tags: { isEmpty: false } }  // Has at least one element
```

**Array Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `equals` | `T[]` | Exact array match |
| `has` | `T` | Contains element |
| `hasEvery` | `T[]` | Contains all elements |
| `hasSome` | `T[]` | Contains any element |
| `isEmpty` | `boolean` | Array is empty |

### Logical Operators

Combine multiple conditions with logical operators.

```ts
// AND - all conditions must match (implicit)
{
  where: {
    status: "active",
    role: "admin",
  }
}

// AND - explicit array form
{
  where: {
    AND: [
      { status: "active" },
      { role: "admin" },
    ]
  }
}

// OR - any condition matches
{
  where: {
    OR: [
      { email: { endsWith: "@company.com" } },
      { role: "admin" },
    ]
  }
}

// NOT - negate conditions
{
  where: {
    NOT: { status: "deleted" }
  }
}

// Complex combinations
{
  where: {
    AND: [
      { status: "active" },
      {
        OR: [
          { role: "admin" },
          { email: { endsWith: "@company.com" } },
        ]
      },
      {
        NOT: { lastLogin: { lt: new Date("2023-01-01") } }
      }
    ]
  }
}
```

---

## Relation Filtering

Filter records based on their related records.

### To-One Relations (`oneToOne`, `manyToOne`)

Use `is` and `isNot` operators to filter by related record.

```ts
// Filter posts by author properties
const posts = await client.post.findMany({
  where: {
    author: {
      is: {
        role: "admin",
        verified: true,
      }
    }
  }
});

// Exclude posts by specific author
const posts = await client.post.findMany({
  where: {
    author: {
      isNot: {
        status: "banned",
      }
    }
  }
});

// Optional relation - filter for null
const orphanedProfiles = await client.profile.findMany({
  where: {
    user: {
      is: null  // Profiles without a user
    }
  }
});

// Optional relation - filter for not null
const linkedProfiles = await client.profile.findMany({
  where: {
    user: {
      isNot: null  // Profiles with a user
    }
  }
});
```

**To-One Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `is` | `WhereInput \| null` | Related record matches (or is null) |
| `isNot` | `WhereInput \| null` | Related record doesn't match (or isn't null) |

### To-Many Relations (`oneToMany`, `manyToMany`)

Use `some`, `every`, and `none` operators to filter by related records.

```ts
// Users with at least one published post
const authors = await client.user.findMany({
  where: {
    posts: {
      some: {
        published: true,
      }
    }
  }
});

// Users where ALL posts are published
const prolificAuthors = await client.user.findMany({
  where: {
    posts: {
      every: {
        published: true,
      }
    }
  }
});

// Users with NO deleted posts
const cleanAuthors = await client.user.findMany({
  where: {
    posts: {
      none: {
        status: "deleted",
      }
    }
  }
});

// Combine relation filters
const activeAuthors = await client.user.findMany({
  where: {
    posts: {
      some: {
        published: true,
        views: { gte: 100 },
      }
    },
    comments: {
      none: {
        flagged: true,
      }
    }
  }
});

// Nested relation filters
const usersWithPopularPosts = await client.user.findMany({
  where: {
    posts: {
      some: {
        comments: {
          some: {
            upvotes: { gte: 10 }
          }
        }
      }
    }
  }
});
```

**To-Many Filter Reference:**

| Operator | Type | Description |
|----------|------|-------------|
| `some` | `WhereInput` | At least one related record matches |
| `every` | `WhereInput` | All related records match |
| `none` | `WhereInput` | No related records match |

---

## Selecting Fields

Control which fields are returned using `select`. When `select` is used, only selected fields are returned.

### Basic Select

```ts
// Select specific scalar fields
const users = await client.user.findMany({
  select: {
    id: true,
    email: true,
    // name, createdAt, etc. will NOT be returned
  }
});
// Type: { id: string; email: string }[]

// Select with a relation (includes all relation fields)
const users = await client.user.findMany({
  select: {
    email: true,
    posts: true,  // Returns all post fields
  }
});
// Type: { email: string; posts: Post[] }[]
```

### Nested Select

Select specific fields from relations.

```ts
// Select specific fields from relation
const users = await client.user.findMany({
  select: {
    email: true,
    posts: {
      select: {
        title: true,
        published: true,
      }
    }
  }
});
// Type: { email: string; posts: { title: string; published: boolean }[] }[]

// Deeply nested select
const users = await client.user.findMany({
  select: {
    name: true,
    posts: {
      select: {
        title: true,
        comments: {
          select: {
            content: true,
            author: {
              select: {
                name: true,
              }
            }
          }
        }
      }
    }
  }
});

// Select with relation filtering
const users = await client.user.findMany({
  select: {
    email: true,
    posts: {
      select: { title: true },
      where: { published: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }
  }
});
```

---

## Including Relations

Use `include` to fetch related records alongside the main record. Unlike `select`, `include` adds relations to the default result (all scalar fields).

### Basic Include

```ts
// Include a single relation
const users = await client.user.findMany({
  include: {
    posts: true,  // All post fields
  }
});
// Type: { id, email, name, ..., posts: Post[] }[]

// Include multiple relations
const users = await client.user.findMany({
  include: {
    posts: true,
    profile: true,
  }
});
```

### Nested Include

```ts
// Include nested relations
const users = await client.user.findMany({
  include: {
    posts: {
      include: {
        comments: true,
      }
    }
  }
});

// Mix include and select in nested queries
const users = await client.user.findMany({
  include: {
    posts: {
      select: {
        title: true,
        comments: true,  // Include all comment fields
      }
    }
  }
});
```

### Filtering Included Relations

For to-many relations, you can filter, sort, and paginate the included records.

```ts
const users = await client.user.findMany({
  include: {
    posts: {
      where: { published: true },       // Only published posts
      orderBy: { createdAt: "desc" },   // Newest first
      take: 5,                          // Max 5 posts per user
      skip: 0,                          // Offset
    }
  }
});

// With nested filtering
const users = await client.user.findMany({
  include: {
    posts: {
      where: {
        published: true,
        comments: {
          some: { upvotes: { gte: 10 } }
        }
      },
      include: {
        comments: {
          where: { upvotes: { gte: 5 } },
          take: 10,
        }
      }
    }
  }
});

// Distinct values
const users = await client.user.findMany({
  include: {
    posts: {
      distinct: ["category"],  // One post per category
    }
  }
});
```

---

## Sorting

Use `orderBy` to sort results by one or more fields.

```ts
// Single field sort
const users = await client.user.findMany({
  orderBy: { createdAt: "desc" },
});

// Multiple fields (array)
const users = await client.user.findMany({
  orderBy: [
    { role: "asc" },
    { name: "asc" },
  ],
});

// Handle nulls (PostgreSQL)
const users = await client.user.findMany({
  orderBy: {
    lastLogin: { sort: "desc", nulls: "last" }
  },
});
```

**Sort Order Options:**

| Value | Description |
|-------|-------------|
| `"asc"` | Ascending (A-Z, 0-9, oldest first) |
| `"desc"` | Descending (Z-A, 9-0, newest first) |
| `{ sort: "asc", nulls: "first" }` | Ascending, nulls first |
| `{ sort: "desc", nulls: "last" }` | Descending, nulls last |

---

## Pagination

### Offset-Based Pagination

```ts
// Page 1: first 10 records
const page1 = await client.user.findMany({
  take: 10,
  skip: 0,
});

// Page 2: next 10 records
const page2 = await client.user.findMany({
  take: 10,
  skip: 10,
});

// With total count
const [users, total] = await Promise.all([
  client.user.findMany({ take: 10, skip: 0 }),
  client.user.count(),
]);
```

### Cursor-Based Pagination

More efficient for large datasets.

```ts
// First page
const page1 = await client.user.findMany({
  take: 10,
  orderBy: { id: "asc" },
});

// Next page (using last item's ID)
const lastId = page1[page1.length - 1].id;
const page2 = await client.user.findMany({
  take: 10,
  skip: 1,  // Skip the cursor itself
  cursor: { id: lastId },
  orderBy: { id: "asc" },
});
```

---

## Unique Identifiers

### Single-Field Unique

```ts
// By primary key
{ where: { id: "user_123" } }

// By unique field
{ where: { email: "alice@example.com" } }
```

### Compound Keys

For models with compound primary keys or unique constraints:

```ts
// Schema
const membership = s.model({
  orgId: s.string(),
  userId: s.string(),
  role: s.string(),
})
  .id(["orgId", "userId"])  // Compound PK
  .unique(["orgId", "role"], { name: "org_role" });

// Query by compound PK (auto-generated name: field1_field2)
const member = await client.membership.findUnique({
  where: {
    orgId_userId: {
      orgId: "org_1",
      userId: "user_1",
    }
  }
});

// Query by named compound unique
const adminMember = await client.membership.findUnique({
  where: {
    org_role: {
      orgId: "org_1",
      role: "admin",
    }
  }
});
```

---

## Nested Writes

Create, update, or connect related records in a single operation.

### Create with Relations

```ts
// Create user with new posts
const user = await client.user.create({
  data: {
    email: "alice@example.com",
    posts: {
      create: [
        { title: "First Post", content: "Hello!" },
        { title: "Second Post", content: "World!" },
      ]
    }
  },
  include: { posts: true },
});

// Create and connect existing records
const user = await client.user.create({
  data: {
    email: "bob@example.com",
    posts: {
      connect: [
        { id: "post_1" },
        { id: "post_2" },
      ]
    }
  }
});

// connectOrCreate - connect if exists, create if not
const user = await client.user.create({
  data: {
    email: "carol@example.com",
    profile: {
      connectOrCreate: {
        where: { userId: "carol_123" },
        create: { bio: "New user", userId: "carol_123" },
      }
    }
  }
});
```

### Update with Relations

```ts
// Update user and create new posts
const user = await client.user.update({
  where: { id: "user_1" },
  data: {
    name: "Alice Updated",
    posts: {
      create: { title: "New Post" },
    }
  }
});

// Disconnect relations
const user = await client.user.update({
  where: { id: "user_1" },
  data: {
    posts: {
      disconnect: [{ id: "post_1" }],  // To-many
    },
    profile: {
      disconnect: true,  // To-one (optional only)
    }
  }
});

// Update nested records
const user = await client.user.update({
  where: { id: "user_1" },
  data: {
    posts: {
      update: {
        where: { id: "post_1" },
        data: { published: true },
      },
      updateMany: {
        where: { published: false },
        data: { status: "draft" },
      }
    }
  }
});

// Delete nested records
const user = await client.user.update({
  where: { id: "user_1" },
  data: {
    posts: {
      delete: { id: "post_1" },
      deleteMany: { status: "archived" },
    }
  }
});

// Replace all (set)
const user = await client.user.update({
  where: { id: "user_1" },
  data: {
    posts: {
      set: [{ id: "post_2" }, { id: "post_3" }],  // Replace all connections
    }
  }
});

// Upsert nested records
const user = await client.user.update({
  where: { id: "user_1" },
  data: {
    profile: {
      upsert: {
        create: { bio: "New bio" },
        update: { bio: "Updated bio" },
      }
    }
  }
});
```

**Nested Write Operations:**

| Operation | To-One Required | To-One Optional | To-Many |
|-----------|----------------|-----------------|---------|
| `create` | ✅ | ✅ | ✅ |
| `connect` | ✅ | ✅ | ✅ |
| `connectOrCreate` | ✅ | ✅ | ✅ |
| `update` | ✅ | ✅ | ✅ |
| `upsert` | ✅ | ✅ | ✅ |
| `disconnect` | ❌ | ✅ | ✅ |
| `delete` | ❌ | ✅ | ✅ |
| `set` | ❌ | ❌ | ✅ |
| `updateMany` | ❌ | ❌ | ✅ |
| `deleteMany` | ❌ | ❌ | ✅ |

---

## Summary

The VibORM client provides:

✅ **Full type safety** — Operations, filters, and results are all type-inferred  
✅ **Prisma-like API** — Familiar patterns for Prisma users  
✅ **Powerful filtering** — Comprehensive operators for all field types  
✅ **Relation queries** — Filter by, select from, and include related records  
✅ **Nested writes** — Create/update related records in single operations  
✅ **Aggregations** — Count, sum, avg, min, max with grouping support  
✅ **Flexible pagination** — Offset-based and cursor-based options

