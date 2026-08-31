import type { DatabaseAdapter } from "@adapters/database-adapter";
import { type Dialect, Driver } from "@drivers";

/** A deterministic query compiler fixture that opens no provider resource. */
export class SqlOnlyDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(
    adapter: DatabaseAdapter,
    dialect: Dialect,
    driverName = `sql-only-${dialect}`
  ) {
    super(dialect, driverName);
    this.adapter = adapter;
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}
