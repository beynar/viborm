import { LibSQLDriver } from "@drivers/libsql";

export function createInMemoryLibSQLDriver(): LibSQLDriver {
  return new LibSQLDriver();
}
