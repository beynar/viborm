import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import type { QueryResult } from "@drivers/types";

export interface FakeRow {
  id: number;
}

export class FakeDriver extends Driver<{ tag: "client" }, { tag: "tx" }> {
  readonly adapter = {} as DatabaseAdapter;
  initFailWith: Error | undefined;
  closeFailWith: Error | undefined;
  closeStarted: (() => void) | undefined;
  closeBarrier: Promise<void> | undefined;
  failWith: Error | undefined;
  transactionFailWith: Error | undefined;
  mutateParams: ((params: unknown[]) => void) | undefined;
  lastSql: string | undefined;
  lastParams: unknown[] | undefined;
  executionCount = 0;
  closeCount = 0;

  constructor() {
    super("sqlite", "fake");
  }

  protected initClient(): Promise<{ tag: "client" }> {
    if (this.initFailWith) return Promise.reject(this.initFailWith);
    return Promise.resolve({ tag: "client" });
  }

  protected async closeClient(): Promise<void> {
    this.closeCount += 1;
    this.closeStarted?.();
    if (this.closeBarrier) await this.closeBarrier;
    if (this.closeFailWith) throw this.closeFailWith;
  }

  protected execute<T>(
    _client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.run<T>(sql, params);
  }

  protected executeRaw<T>(
    _client: unknown,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.run<T>(sql, params ?? []);
  }

  protected transaction<T>(
    _client: unknown,
    fn: (tx: { tag: "tx" }) => Promise<T>
  ): Promise<T> {
    if (this.transactionFailWith) {
      return Promise.reject(this.transactionFailWith);
    }
    return fn({ tag: "tx" });
  }

  private run<T>(sql: string, params: unknown[]): Promise<QueryResult<T>> {
    this.executionCount += 1;
    this.lastSql = sql;
    this.lastParams = params;
    this.mutateParams?.(params);
    if (this.failWith) return Promise.reject(this.failWith);
    const rows = [{ id: 1 }] as unknown as T[];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
}

/**
 * `official-statement-instrumentation.core` `StatementDriver`: the golden
 * transcript's statement fixture, shared with the platform-tracer suites.
 */
export class StatementDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  providerCalls = 0;
  failAtProviderCall: number | undefined;

  constructor() {
    super("sqlite", "official-statement-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.providerCalls += 1;
    if (this.providerCalls === this.failAtProviderCall) {
      throw new Error("fallback provider failed");
    }
    return { rows: [{ id: "record-1", name: "Ada" }] as T[], rowCount: 1 };
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return await callback(client);
  }
}
