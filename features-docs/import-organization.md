# VibORM Import Organization Proposal

## Goals

1. **Tree-shaking**: Users only bundle what they import
2. **Separation of concerns**: Clear boundaries between modules
3. **No unused driver imports**: Importing `pg` shouldn't pull in `mysql2` types
4. **Intuitive paths**: Predictable import locations

---

## Proposed Import Structure

### 1. Schema Definition (`viborm/schema`)

**Purpose**: Define models, fields, relations

```typescript
import { s, PG, MYSQL, SQLITE } from "viborm/schema";
```

**Exports:**
- `s` - Schema builder (model, fields, relations)
- `PG` / `MYSQL` / `SQLITE` - Native database types

**File:** `src/schema/exports.ts` → `viborm/schema`

---

### 2. Client & Config (`viborm`)

**Purpose**: Main entry point for creating clients

```typescript
import { createClient } from "viborm";
import type { VibORMClient, VibORMConfig } from "viborm";
```

**Exports:**
- `createClient` - Client factory
- `VibORMConfig` - Config type
- `VibORMClient` - Client type
- `PendingOperation` - For transaction batching
- Error classes

**File:** `src/index.ts` → `viborm`

---

### 3. Drivers (Top-Level Subpaths)

**Purpose**: Database drivers - each is a separate top-level entry point

```typescript
// PostgreSQL
import { PgDriver } from "viborm/pg";
import { PostgresDriver } from "viborm/postgres";
import { PGliteDriver } from "viborm/pglite";
import { NeonHTTPDriver } from "viborm/neon-http";
import { BunSQLDriver } from "viborm/bun-sql";

// MySQL
import { MySQL2Driver } from "viborm/mysql2";
import { PlanetScaleDriver } from "viborm/planetscale";

// SQLite
import { SQLite3Driver } from "viborm/sqlite3";
import { LibSQLDriver } from "viborm/libsql";
import { D1Driver } from "viborm/d1";
import { D1HTTPDriver } from "viborm/d1-http";
import { BunSQLiteDriver } from "viborm/bun-sqlite";
```

**No aggregate `viborm/drivers` export** - forces explicit imports, ensures tree-shaking.

**Shared types** (for custom driver implementations):
```typescript
import { Driver, TransactionBoundDriver } from "viborm/driver";
import type { AnyDriver, Dialect, QueryResult } from "viborm/driver";
```

---

### 4. Cache (`viborm/cache`)

**Purpose**: Cache types and utilities

```typescript
// Types and utilities only
import { CacheDriver, generateCacheKey } from "viborm/cache";
import type { CacheEntry, WithCacheOptions } from "viborm/cache";

// Specific cache drivers
import { MemoryCache } from "viborm/cache/memory";
import { CloudflareKVCache } from "viborm/cache/cloudflare-kv";
```

---

### 5. Migrations (`viborm/migrations`)

**Purpose**: Schema migrations

```typescript
import { createMigrationClient, push, generate, apply } from "viborm/migrations";
import type { MigrationClient, DiffResult } from "viborm/migrations";
```

---

### 6. Client Types (`viborm/client`)

**Purpose**: Advanced client types for library authors

```typescript
import type {
  Client,
  CachedClient,
  Schema,
  Operations,
  OperationPayload,
  OperationResult,
} from "viborm/client";
```

---

### 7. Validation (`viborm/validation`)

**Purpose**: Schema validation library (for advanced users)

```typescript
import { v } from "viborm/validation";
import type { VibSchema, InferInput, InferOutput } from "viborm/validation";
```

---

### 8. Instrumentation (`viborm/instrumentation`)

**Purpose**: OpenTelemetry integration

```typescript
import type { 
  InstrumentationConfig, 
  TracingConfig, 
  LoggingConfig 
} from "viborm/instrumentation";
```

---

## Complete Import Map

| Import Path | Purpose | Key Exports |
|-------------|---------|-------------|
| `viborm` | Main entry | `createClient`, errors, `PendingOperation` |
| `viborm/schema` | Schema definition | `s`, `PG`, `MYSQL`, `SQLITE` |
| `viborm/pg` | node-postgres | `PgDriver` |
| `viborm/postgres` | postgres.js | `PostgresDriver` |
| `viborm/pglite` | PGlite | `PGliteDriver` |
| `viborm/neon-http` | Neon serverless | `NeonHTTPDriver` |
| `viborm/bun-sql` | Bun SQL (PG) | `BunSQLDriver` |
| `viborm/mysql2` | MySQL2 | `MySQL2Driver` |
| `viborm/planetscale` | PlanetScale | `PlanetScaleDriver` |
| `viborm/sqlite3` | better-sqlite3 | `SQLite3Driver` |
| `viborm/libsql` | LibSQL/Turso | `LibSQLDriver` |
| `viborm/d1` | Cloudflare D1 | `D1Driver` |
| `viborm/d1-http` | D1 HTTP API | `D1HTTPDriver` |
| `viborm/bun-sqlite` | Bun SQLite | `BunSQLiteDriver` |
| `viborm/driver` | Driver base | `Driver`, types |
| `viborm/cache` | Cache types | `CacheDriver`, `generateCacheKey` |
| `viborm/cache/memory` | Memory cache | `MemoryCache` |
| `viborm/cache/cloudflare-kv` | KV cache | `CloudflareKVCache` |
| `viborm/migrations` | Migrations | `createMigrationClient`, `push`, etc. |
| `viborm/client` | Client types | `Client`, `Schema`, etc. |
| `viborm/validation` | Validation lib | `v`, schema types |
| `viborm/instrumentation` | Telemetry | Config types |

---

## Implementation Changes

### 1. Update `tsdown.config.ts`

```typescript
export default defineConfig({
  entry: {
    // Main entry
    index: "./src/index.ts",
    cli: "./src/cli/index.ts",
    
    // Schema
    schema: "./src/schema/exports.ts",
    
    // Drivers (top-level paths)
    driver: "./src/drivers/base.ts",
    pg: "./src/drivers/pg/index.ts",
    postgres: "./src/drivers/postgres/index.ts",
    pglite: "./src/drivers/pglite/index.ts",
    "neon-http": "./src/drivers/neon-http/index.ts",
    "bun-sql": "./src/drivers/bun-sql/index.ts",
    mysql2: "./src/drivers/mysql2/index.ts",
    planetscale: "./src/drivers/planetscale/index.ts",
    sqlite3: "./src/drivers/sqlite3/index.ts",
    libsql: "./src/drivers/libsql/index.ts",
    d1: "./src/drivers/d1/index.ts",
    "d1-http": "./src/drivers/d1-http/index.ts",
    "bun-sqlite": "./src/drivers/bun-sqlite/index.ts",
    
    // Cache
    cache: "./src/cache/exports.ts",
    "cache/memory": "./src/cache/drivers/memory.ts",
    "cache/cloudflare-kv": "./src/cache/drivers/cloudflare-kv.ts",
    
    // Migrations
    migrations: "./src/migrations/index.ts",
    
    // Client types
    client: "./src/client/exports.ts",
    
    // Validation
    validation: "./src/validation/index.ts",
    
    // Instrumentation
    instrumentation: "./src/instrumentation/exports.ts",
  },
  // ... rest of config
});
```

### 2. Update `package.json` exports

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs"
    },
    "./schema": {
      "types": "./dist/schema.d.ts",
      "import": "./dist/schema.mjs"
    },
    "./driver": {
      "types": "./dist/driver.d.ts",
      "import": "./dist/driver.mjs"
    },
    "./pg": {
      "types": "./dist/pg.d.ts",
      "import": "./dist/pg.mjs"
    },
    "./postgres": {
      "types": "./dist/postgres.d.ts",
      "import": "./dist/postgres.mjs"
    },
    "./pglite": {
      "types": "./dist/pglite.d.ts",
      "import": "./dist/pglite.mjs"
    },
    "./neon-http": {
      "types": "./dist/neon-http.d.ts",
      "import": "./dist/neon-http.mjs"
    },
    "./bun-sql": {
      "types": "./dist/bun-sql.d.ts",
      "import": "./dist/bun-sql.mjs"
    },
    "./mysql2": {
      "types": "./dist/mysql2.d.ts",
      "import": "./dist/mysql2.mjs"
    },
    "./planetscale": {
      "types": "./dist/planetscale.d.ts",
      "import": "./dist/planetscale.mjs"
    },
    "./sqlite3": {
      "types": "./dist/sqlite3.d.ts",
      "import": "./dist/sqlite3.mjs"
    },
    "./libsql": {
      "types": "./dist/libsql.d.ts",
      "import": "./dist/libsql.mjs"
    },
    "./d1": {
      "types": "./dist/d1.d.ts",
      "import": "./dist/d1.mjs"
    },
    "./d1-http": {
      "types": "./dist/d1-http.d.ts",
      "import": "./dist/d1-http.mjs"
    },
    "./bun-sqlite": {
      "types": "./dist/bun-sqlite.d.ts",
      "import": "./dist/bun-sqlite.mjs"
    },
    "./cache": {
      "types": "./dist/cache.d.ts",
      "import": "./dist/cache.mjs"
    },
    "./cache/memory": {
      "types": "./dist/cache/memory.d.ts",
      "import": "./dist/cache/memory.mjs"
    },
    "./cache/cloudflare-kv": {
      "types": "./dist/cache/cloudflare-kv.d.ts",
      "import": "./dist/cache/cloudflare-kv.mjs"
    },
    "./migrations": {
      "types": "./dist/migrations.d.ts",
      "import": "./dist/migrations.mjs"
    },
    "./client": {
      "types": "./dist/client.d.ts",
      "import": "./dist/client.mjs"
    },
    "./validation": {
      "types": "./dist/validation.d.ts",
      "import": "./dist/validation.mjs"
    },
    "./instrumentation": {
      "types": "./dist/instrumentation.d.ts",
      "import": "./dist/instrumentation.mjs"
    }
  }
}
```

### 3. Create Export Files

#### `src/schema/exports.ts`

```typescript
// Schema Builder API
export { s } from "./index";

// Native types (directly exported, no separate subpath)
export { PG, MYSQL, SQLITE, type NativeType } from "./fields/native-types";

// Model and field types for advanced usage
export type { Model, ModelState, AnyModel } from "./model";
export type { Field, NumberField } from "./fields";
export type { AnyRelation, Getter, ReferentialAction, RelationType } from "./relation";

// Hydration utilities (for library authors)
export {
  hydrateSchemaNames,
  isSchemaHydrated,
  getModelSqlName,
  getFieldSqlName,
} from "./hydration";
```

#### `src/drivers/exports.ts` (exported as `viborm/driver`)

```typescript
// Base driver for custom implementations
export { Driver, TransactionBoundDriver } from "./driver";

// Types
export type {
  AnyDriver,
  DriverResultParser,
  QueryExecutionContext,
} from "./driver";

export type {
  Dialect,
  IsolationLevel,
  LogFunction,
  QueryResult,
  TransactionOptions,
} from "./types";

// Errors (commonly needed with drivers)
export {
  ConnectionError,
  FeatureNotSupportedError,
  ForeignKeyError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  isRetryableError,
} from "@errors";
```

#### `src/cache/exports.ts`

```typescript
// Cache driver base
export {
  CacheDriver,
  type AnyCacheDriver,
  type CacheEntry,
  type CacheExecutionOptions,
  type CacheSetOptions,
} from "./driver";

// Cache utilities
export { CACHE_PREFIX, generateCacheKey, generateCachePrefix } from "./key";
export { parseTTL } from "./ttl";

// Cache schemas
export type {
  CacheInvalidationOptions,
  CacheInvalidationSchema,
  WithCacheOptions,
  WithCacheSchema,
} from "./schema";
export { cacheInvalidationSchema, DEFAULT_CACHE_TTL, withCacheSchema } from "./schema";
```

#### `src/client/exports.ts`

```typescript
// Client types
export type {
  Client,
  CachedClient,
  Schema,
  Operations,
  CacheableOperations,
  MutationOperations,
  OperationPayload,
  OperationResult,
  WaitUntilFn,
} from "./types";

// Result types
export type {
  InferSelectInclude,
  BatchPayload,
  CountResultType,
  AggregateResultType,
  GroupByResultType,
} from "./result-types";

// Pending operation
export {
  PendingOperation,
  isPendingOperation,
  type UnwrapPendingOperation,
  type UnwrapPendingOperations,
} from "./pending-operation";
```

#### `src/instrumentation/exports.ts`

```typescript
// Configuration types
export type {
  InstrumentationConfig,
  InstrumentationContext,
  TracingConfig,
  LoggingConfig,
  LogCallback,
  LogEvent,
  LogLevel,
} from "./index";

// Span names and attributes (for custom instrumentation)
export {
  SPAN_OPERATION,
  SPAN_VALIDATE,
  SPAN_BUILD,
  SPAN_EXECUTE,
  SPAN_PARSE,
  SPAN_TRANSACTION,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_CACHE_GET,
  SPAN_CACHE_SET,
  SPAN_CACHE_DELETE,
  SPAN_CACHE_CLEAR,
  SPAN_CACHE_INVALIDATE,
  // Attributes
  ATTR_DB_SYSTEM,
  ATTR_DB_NAMESPACE,
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_BATCH_SIZE,
  ATTR_DB_ROWS_RETURNED,
  ATTR_DB_DRIVER,
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_KEY,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
} from "./spans";
```

---

## Migration Guide

### Before (current)

```typescript
import { createClient, s, PgDriver, MemoryCache } from "viborm";
// or
import { PgDriver } from "viborm/drivers";
import { MemoryCache } from "viborm";
```

### After (proposed)

```typescript
import { createClient } from "viborm";
import { s } from "viborm/schema";
import { PgDriver } from "viborm/pg";
import { MemoryCache } from "viborm/cache/memory";
```

---

## Bundle Size Impact

With this structure:

| Import | Bundle includes |
|--------|-----------------|
| `viborm` | Client, errors, pending ops (~15KB) |
| `viborm/schema` | Schema builder only (~20KB) |
| `viborm/pg` | Only pg driver (~5KB) |
| `viborm/mysql2` | Only mysql2 driver (~5KB) |
| `viborm/cache/memory` | Only memory cache (~2KB) |

**Without this structure** (current `viborm/drivers`):
- Imports ALL driver types even if only using pg
- Type pollution and larger bundle

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/schema/exports.ts` | CREATE | Clean schema exports |
| `src/drivers/exports.ts` | CREATE | Driver base exports (`viborm/driver`) |
| `src/cache/exports.ts` | CREATE | Clean cache exports |
| `src/client/exports.ts` | CREATE | Client type exports |
| `src/instrumentation/exports.ts` | CREATE | Instrumentation exports |
| `src/index.ts` | MODIFY | Slim down main entry |
| `tsdown.config.ts` | MODIFY | Add all entry points |
| `package.json` | MODIFY | Add all export paths |

---

## Success Criteria

- [ ] Each driver is a separate entry point
- [ ] `import { s } from "viborm/schema"` works
- [ ] `import { PgDriver } from "viborm/pg"` works
- [ ] `import { MemoryCache } from "viborm/cache/memory"` works
- [ ] Tree-shaking removes unused drivers
- [ ] TypeScript types resolve correctly for all paths
- [ ] No circular dependency issues
- [ ] Bundle size reduced for typical use cases
