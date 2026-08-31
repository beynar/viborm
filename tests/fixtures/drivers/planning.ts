import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  Driver,
  type QueryExecutionContext,
  type QueryResult,
} from "@drivers";

export type PlanningDialect = "mysql" | "postgresql" | "sqlite";

/**
 * SQL-planning driver for contracts that never dispatch provider work.
 *
 * A provider driver is the wrong fixture for construction and compilation:
 * PGlite allocates a WASM database lazily, mysql2 owns a pool boundary, and
 * neither resource is part of the invariant these contracts protect. Any
 * accidental execution fails instead of turning a structural contract into a
 * hidden integration test.
 */
export class PlanningDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;
  override readonly maxBindParametersPerStatement: number | undefined;

  constructor(
    dialect: PlanningDialect,
    options: {
      readonly driverName?: string;
      readonly supportsTransactions?: boolean;
      readonly supportsBatch?: boolean;
      readonly maxBindParametersPerStatement?: number;
    } = {}
  ) {
    super(dialect, options.driverName ?? `planning-${dialect}`);
    this.adapter =
      dialect === "postgresql"
        ? new PostgresAdapter()
        : dialect === "mysql"
          ? new MySQLAdapter()
          : new SQLiteAdapter();
    this.supportsTransactions = options.supportsTransactions ?? true;
    this.supportsBatch = options.supportsBatch ?? false;
    this.maxBindParametersPerStatement =
      options.maxBindParametersPerStatement;
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(
    _client: null,
    _sql: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    throw new Error("A planning-only contract dispatched provider work.");
  }

  protected async executeRaw<T>(
    _client: null,
    _sql: string,
    _params: unknown[] | undefined,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    throw new Error("A planning-only contract dispatched raw provider work.");
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}
