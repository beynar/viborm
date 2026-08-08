import { LibSQLDriver } from "@drivers/libsql";
import type { ProviderFixture } from "@tests/contracts/contract";

export function createInMemoryLibSQLDriver(): LibSQLDriver {
  return new LibSQLDriver();
}

export const libsqlProviderFixture: ProviderFixture<LibSQLDriver> = {
  id: "libsql",
  dialect: "sqlite",
  runtime: "node",
  capabilities: new Set(["sql-execution", "transactions", "returning", "ddl"]),
  availability: () => ({ available: true }),
  createDriver: createInMemoryLibSQLDriver,
  dispose: (driver) => driver.disconnect(),
};
