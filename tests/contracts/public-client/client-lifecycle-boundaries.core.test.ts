import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClientFromDriverConfig } from "@client/client";
import { Driver, type QueryExecutionContext, type QueryResult } from "@drivers";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

class LifecycleDriver extends Driver<object, object> {
  readonly adapter = new SQLiteAdapter();
  connectCalls = 0;
  closeCalls = 0;

  constructor() {
    super("sqlite", "lifecycle-recording");
  }

  protected async initClient(): Promise<object> {
    this.connectCalls += 1;
    return {};
  }

  protected async closeClient(): Promise<void> {
    this.closeCalls += 1;
  }

  protected async execute<T>(
    _client: object,
    _sql: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    _client: object,
    _sql: string,
    _params?: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    client: object,
    run: (client: object) => Promise<T>
  ): Promise<T> {
    return run(client);
  }
}

describe("client lifecycle public boundaries", () => {
  test("the driver-config wrapper preserves identity and owns one lifecycle", async () => {
    const schema = {
      record: s.model({ id: s.string().id(), label: s.string() }),
    };
    const config = { schema };
    const driver = new LifecycleDriver();
    const client = createClientFromDriverConfig(config, driver);

    expect(client.$schema).toBe(schema);
    expect(client.$driver).toBe(driver);
    expect(config).toEqual({ schema });

    await client.$connect();
    await client.$connect();
    expect(driver.connectCalls).toBe(1);

    const asyncDispose = Reflect.get(Symbol, "asyncDispose");
    if (typeof asyncDispose === "symbol") {
      const dispose = Reflect.get(client, asyncDispose);
      if (typeof dispose !== "function") {
        throw new Error("The client did not expose asynchronous disposal");
      }
      await Reflect.apply(dispose, client, []);
    } else {
      await client.$disconnect();
    }
    expect(driver.closeCalls).toBe(1);

    await client.$disconnect();
    expect(driver.closeCalls).toBe(1);
  });
});
