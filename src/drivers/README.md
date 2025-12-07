# Database Drivers

Simple interface for database drivers. Each driver implements `Driver` and is passed to `createClient`.

## Interface

```ts
interface Driver {
  dialect: "postgresql" | "mysql" | "sqlite";
  
  execute<T>(query: Sql): Promise<QueryResult<T>>;
  executeRaw<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: Driver) => Promise<T>, options?: TransactionOptions): Promise<T>;
  
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}
```

## Usage

```ts
import { PgDriver } from "viborm/drivers/pg";
import { createClient } from "viborm";
import { user, post } from "./schema";

// Create driver
const driver = new PgDriver({ connectionString: "postgresql://..." });

// Pass to client
const client = createClient(driver, { user, post });

// Use client (internally uses query-engine → driver)
const users = await client.user.findMany({ where: { name: "Alice" } });

// Direct driver access
await client.$driver.execute(sql`SELECT 1`);

// Transactions via client
await client.$transaction(async (tx) => {
  await tx.user.create({ data: { name: "Bob" } });
  await tx.post.create({ data: { title: "Hello", authorId: "..." } });
});
```

## Implementing a Driver

```ts
import type { Driver, QueryResult, Sql } from "viborm/drivers";

export class PgDriver implements Driver {
  readonly dialect = "postgresql" as const;
  private pool: Pool;

  constructor(private options: { connectionString: string }) {}

  async connect() {
    this.pool = new Pool({ connectionString: this.options.connectionString });
  }

  async disconnect() {
    await this.pool.end();
  }

  async execute<T>(query: Sql): Promise<QueryResult<T>> {
    const { text, values } = query.compile();
    const result = await this.pool.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async executeRaw<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txDriver = this.createTxDriver(client);
      const result = await fn(txDriver);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private createTxDriver(client: PoolClient): Driver {
    return {
      dialect: this.dialect,
      execute: async (query) => {
        const { text, values } = query.compile();
        const result = await client.query(text, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      executeRaw: async (sql, params) => {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      transaction: () => {
        throw new Error("Nested transactions not supported");
      },
    };
  }
}
```

## Available Drivers

| Driver | Package | Database |
|--------|---------|----------|
| `PgDriver` | `viborm/drivers/pg` | PostgreSQL (node-postgres) |
| `Postgres` | `viborm/drivers/postgres` | PostgreSQL (postgres.js) |
| `MySqlDriver` | `viborm/drivers/mysql2` | MySQL (mysql2) |
| `BetterSqliteDriver` | `viborm/drivers/better-sqlite3` | SQLite (better-sqlite3) |
| `D1Driver` | `viborm/drivers/d1` | Cloudflare D1 |
| `LibSqlDriver` | `viborm/drivers/libsql` | Turso / LibSQL |

## Errors

```ts
import { 
  DriverError,
  ConnectionError,
  QueryError,
  UniqueConstraintError,
  ForeignKeyError,
  TransactionError,
  isUniqueConstraintError,
  isRetryableError,
} from "viborm/drivers";

try {
  await client.user.create({ data: { email: "existing@example.com" } });
} catch (error) {
  if (isUniqueConstraintError(error)) {
    console.log("Duplicate:", error.columns);
  }
}
```
