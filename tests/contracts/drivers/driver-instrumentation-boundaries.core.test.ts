import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import type { QueryResult } from "@drivers/types";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_CORRELATION_ID,
} from "@instrumentation/spans";
import { describe, expect, test } from "vitest";

class AttributeDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: "mysql" | "sqlite") {
    super(dialect, `attribute-${dialect}`);
    this.adapter = adapter;
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return callback(client);
  }
}

describe("driver instrumentation attributes", () => {
  test("publishes the adapter namespace and driver identity", () => {
    const driver = new AttributeDriver(new MySQLAdapter("tenant"), "mysql");

    expect(driver.getBaseAttributes()).toEqual({
      [ATTR_DB_SYSTEM]: "mysql",
      "db.system.driver": "attribute-mysql",
      [ATTR_DB_NAMESPACE]: "tenant",
    });
  });

  test("omits an absent namespace and appends only supplied context facts", () => {
    const driver = new AttributeDriver(new SQLiteAdapter(), "sqlite");

    expect(driver.getContextAttributes({})).toEqual({
      [ATTR_DB_SYSTEM]: "sqlite",
      "db.system.driver": "attribute-sqlite",
    });
    expect(
      driver.getContextAttributes({
        correlationId: "correlation",
        model: "entry",
        operation: "create",
      })
    ).toEqual({
      [ATTR_DB_SYSTEM]: "sqlite",
      "db.system.driver": "attribute-sqlite",
      [ATTR_DB_COLLECTION]: "entry",
      [ATTR_DB_OPERATION_NAME]: "create",
      [ATTR_VIBORM_CORRELATION_ID]: "correlation",
    });
  });
});
