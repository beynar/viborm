// Concrete-provider admission; intentionally outside the core lane.
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { describe, expect, test, vi } from "vitest";

class AdapterDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect = "postgresql") {
    super(dialect, "geopoint-adapter-proof");
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    return undefined;
  }

  protected async execute<T>() {
    return { rows: [] as T[], rowCount: 0 };
  }

  protected async executeRaw<T>() {
    return { rows: [] as T[], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    run: (client: null) => Promise<T>
  ): Promise<T> {
    return run(null);
  }
}

const pointSchema = {
  place: s.model({ id: s.string().id(), location: s.point() }),
};
const scalarSchema = {
  place: s.model({ id: s.string().id(), name: s.string() }),
};

function captureDefinitionRefusal(driver: Driver<unknown, unknown>) {
  const connect = vi.spyOn(driver, "_connect");
  const execute = vi.spyOn(driver, "_execute");
  let cause: unknown;
  try {
    createClient({ schema: pointSchema, driver });
  } catch (error) {
    cause = error;
  }
  return { cause, connect, execute };
}

describe("GeoPoint provider admission", () => {
  test("refuses stock PostgreSQL drivers without the PostGIS protocol before I/O", () => {
    for (const driver of [
      new PgDriver({
        databaseUrl: "postgresql://viborm:viborm@127.0.0.1:1/unreachable",
      }),
      new PGliteDriver(),
    ]) {
      const refusal = captureDefinitionRefusal(driver);
      expect(refusal.cause).toBeInstanceOf(ClientInitializationError);
      expect(refusal.connect).toHaveBeenCalledTimes(0);
      expect(refusal.execute).toHaveBeenCalledTimes(0);
    }
  });

  test("uses the concrete adapter protocol for custom drivers", () => {
    const refusal = captureDefinitionRefusal(
      new AdapterDriver(new PostgresAdapter("public", false))
    );
    expect(refusal.cause).toBeInstanceOf(ClientInitializationError);
    expect(refusal.connect).toHaveBeenCalledTimes(0);
    expect(refusal.execute).toHaveBeenCalledTimes(0);
    expect(() =>
      createClient({
        schema: pointSchema,
        driver: new AdapterDriver(new PostgresAdapter("public", true)),
      })
    ).not.toThrow();
  });

  test("leaves schemas without GeoPoint valid on an adapter without PostGIS", () => {
    expect(() =>
      createClient({
        schema: scalarSchema,
        driver: new AdapterDriver(new PostgresAdapter("public", false)),
      })
    ).not.toThrow();
  });
});
