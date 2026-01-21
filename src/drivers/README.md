# Database Drivers

Simple interface for database drivers. Each driver implements `Driver` and is passed to `createClient`.

## Interface

```ts
abstract class Driver<TClient, TTransaction> {
  readonly dialect: "postgresql" | "mysql" | "sqlite";
  readonly driverName: string;
  readonly supportsTransactions: boolean;
  readonly supportsBatch: boolean;
  
  // Public API (called by query engine)
  _execute<T>(query: Sql): Promise<QueryResult<T>>;
  _executeRaw<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  _transaction<T>(fn: (tx: TTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
  _executeBatch<T>(queries: BatchQuery[]): Promise<Array<QueryResult<T>>>;
  
  // Lifecycle
  connect?(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Abstract methods (implemented by concrete drivers)
  protected abstract initClient(): Promise<TClient>;
  protected abstract closeClient(client: TClient): Promise<void>;
  protected abstract execute<T>(client: TClient | TTransaction, sql: string, params: unknown[]): Promise<QueryResult<T>>;
  protected abstract executeRaw<T>(client: TClient | TTransaction, sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  protected abstract transaction<T>(client: TClient | TTransaction, fn: (tx: TTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
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
const driver = new PgDriver({ options: { connectionString: "postgresql://..." } });

// Pass to client
const client = createClient({ driver, schema: { user, post } });

// Use client (internally uses query-engine → driver)
const users = await client.user.findMany({ where: { name: "Alice" } });

// Direct driver access
await client.$driver._execute(sql`SELECT 1`);

// Transactions via client
await client.$transaction(async (tx) => {
  await tx.user.create({ data: { name: "Bob" } });
  await tx.post.create({ data: { title: "Hello", authorId: "..." } });
});
```

## Transaction Architecture

### TransactionBoundDriver

The `TransactionBoundDriver` is a key abstraction that enables clean transaction handling without threading `tx` through every layer of the stack.

**The Problem:**
When executing operations inside a transaction, we need all queries to use the transaction connection. The naive approach threads `tx` through every function call:

```ts
// ❌ Old approach - threading tx everywhere
async function createUser(tx, data) {
  return await queryEngine.execute(tx, createQuery);
}
```

**The Solution:**
`TransactionBoundDriver` wraps a base driver and binds all operations to a specific transaction. The `getClient()` method returns the transaction instead of the base client, so existing code paths automatically use the transaction.

```ts
// ✅ New approach - TransactionBoundDriver
driver._transaction((tx) => {
  const txDriver = new TransactionBoundDriver(driver, tx);
  // All operations on txDriver automatically use the transaction
  await txDriver._execute(query); // Uses tx internally
});
```

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        $transaction(fn)                         │
├─────────────────────────────────────────────────────────────────┤
│  1. driver._transaction((tx) => { ... })                        │
│     └── Base driver starts transaction (BEGIN)                  │
│                                                                 │
│  2. TransactionBoundDriver wraps base driver + tx               │
│     └── getClient() returns tx instead of base client           │
│                                                                 │
│  3. New VibORM instance created with txDriver                   │
│     └── All operations use txDriver                             │
│                                                                 │
│  4. User callback executes with tx-bound client                 │
│     └── tx.user.create() → QueryEngine → txDriver._execute()    │
│                                                                 │
│  5. Transaction completes (COMMIT) or fails (ROLLBACK)          │
└─────────────────────────────────────────────────────────────────┘
```

### TransactionBoundDriver Implementation

```ts
export class TransactionBoundDriver<TClient, TTransaction> 
  extends Driver<TClient, TTransaction> {
  
  private readonly baseDriver: Driver<TClient, TTransaction>;
  private readonly tx: TTransaction;
  override readonly inTransaction = true;

  constructor(baseDriver: Driver<TClient, TTransaction>, tx: TTransaction) {
    super(baseDriver.dialect, baseDriver.driverName);
    this.baseDriver = baseDriver;
    this.tx = tx;
    this.adapter = baseDriver.adapter;
    this.instrumentation = baseDriver.instrumentation;
  }

  // Key: Always return the bound transaction
  protected override async getClient(): Promise<TClient | TTransaction> {
    return this.tx;
  }

  // Delegate execution to base driver
  protected override execute<T>(client, sql, params): Promise<QueryResult<T>> {
    return this.baseDriver.execute(client, sql, params);
  }

  // ... other methods delegate to baseDriver
}
```

### Rollback Handling

Rollback is handled by the concrete driver's `transaction()` method, not by `TransactionBoundDriver`:

```ts
// In concrete driver (e.g., PgDriver)
protected async transaction<T>(client, fn, options): Promise<T> {
  const poolClient = await client.connect();
  try {
    await poolClient.query("BEGIN");
    const result = await fn(poolClient);
    await poolClient.query("COMMIT");
    return result;
  } catch (error) {
    await poolClient.query("ROLLBACK");  // ← Automatic rollback on error
    throw error;
  } finally {
    poolClient.release();
  }
}
```

### Nested Transactions (Savepoints)

Drivers that support savepoints handle nested transactions automatically:

```ts
// In SQLite drivers
protected async transaction<T>(client, fn, options): Promise<T> {
  if (this.inTransaction) {
    // Nested transaction - use savepoint
    const savepointName = `sp_${++this.savepointCounter}`;
    client.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = await fn(client);
      client.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      client.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw error;
    }
  }
  // ... regular transaction handling
}
```

## Implementing a Driver

```ts
import { Driver, type QueryResult, type TransactionOptions } from "viborm/drivers";

export class MyDriver extends Driver<MyClient, MyTransaction> {
  readonly adapter = new MyAdapter();

  constructor(options: MyDriverOptions) {
    super("postgresql", "my-driver");
    // ... setup
  }

  protected async initClient(): Promise<MyClient> {
    return new MyClient(this.options);
  }

  protected async closeClient(client: MyClient): Promise<void> {
    await client.close();
  }

  protected async execute<T>(
    client: MyClient | MyTransaction,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  protected async executeRaw<T>(
    client: MyClient | MyTransaction,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await client.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  protected async transaction<T>(
    client: MyClient | MyTransaction,
    fn: (tx: MyTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    await client.query("BEGIN");
    try {
      const result = await fn(client as MyTransaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}
```

## Available Drivers

| Driver | Package | Database | Transactions | Batch |
|--------|---------|----------|--------------|-------|
| `PgDriver` | `viborm/drivers/pg` | PostgreSQL (node-postgres) | ✅ | ❌ |
| `PostgresDriver` | `viborm/drivers/postgres` | PostgreSQL (postgres.js) | ✅ | ❌ |
| `PGliteDriver` | `viborm/drivers/pglite` | PostgreSQL (PGlite/WASM) | ✅ | ❌ |
| `MySQL2Driver` | `viborm/drivers/mysql2` | MySQL (mysql2) | ✅ | ❌ |
| `BunSQLiteDriver` | `viborm/drivers/bun-sqlite` | SQLite (bun:sqlite) | ✅ | ❌ |
| `SQLite3Driver` | `viborm/drivers/sqlite3` | SQLite (better-sqlite3) | ✅ | ❌ |
| `LibSQLDriver` | `viborm/drivers/libsql` | Turso / LibSQL | ✅ | ✅ |
| `D1Driver` | `viborm/drivers/d1` | Cloudflare D1 | ❌ | ✅ |
| `D1HttpDriver` | `viborm/drivers/d1-http` | Cloudflare D1 (HTTP) | ❌ | ✅ |
| `NeonHttpDriver` | `viborm/drivers/neon-http` | Neon (HTTP) | ❌ | ✅ |
| `PlanetScaleDriver` | `viborm/drivers/planetscale` | PlanetScale | ❌ | ❌ |

## Batch vs Transaction

- **Transaction**: Multiple operations with ACID guarantees, operations can depend on each other
- **Batch**: Multiple independent operations executed atomically (where supported)

```ts
// Transaction (callback) - operations can depend on each other
await client.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { name: "Alice" } });
  await tx.post.create({ data: { authorId: user.id, title: "Hello" } });
});

// Batch (array) - independent operations, atomic execution
const [users, posts] = await client.$transaction([
  client.user.findMany(),
  client.post.findMany(),
]);
```

For drivers without transaction support (D1, Neon-HTTP), batch mode provides atomicity for independent operations.
