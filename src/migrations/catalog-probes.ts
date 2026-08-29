/**
 * Driver catalog probes. These are the only checks the ORM proves read-only.
 * Manual trusted-read checks are a different arm.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { BoundMigrationDriver, MigrationDriver } from "./drivers";
import type { DiffOperation } from "./types";
import type { MigrationParameterV1 } from "./v1-types";

export interface CatalogProbe {
  readonly id: string;
  readonly sql: string;
  readonly parameters: readonly MigrationParameterV1[];
  readonly equals: boolean;
}

type CatalogProbeLifetime = "live-command" | "stored-artifact";

function namespace(driver: MigrationDriver): string | undefined {
  return (
    driver.namespace ??
    (driver.target?.dialect === "postgresql"
      ? driver.target.namespace
      : undefined)
  );
}

function boundCatalogNamespace(driver: MigrationDriver): string {
  const value = namespace(driver);
  if (value) return value;
  throw new MigrationError(
    "A catalog probe needs the bound migration namespace and this driver has none",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    { meta: { driver: driver.dialect } }
  );
}

function stringParam(value: string): MigrationParameterV1 {
  return { kind: "string", value };
}

function mysqlNamespaceParam(
  driver: MigrationDriver,
  lifetime: CatalogProbeLifetime
): MigrationParameterV1 {
  return lifetime === "stored-artifact"
    ? { kind: "target-namespace" }
    : stringParam(boundCatalogNamespace(driver));
}

export function tableExistsProbe(
  driver: MigrationDriver,
  tableName: string,
  exists: boolean,
  lifetime: CatalogProbeLifetime = "live-command"
): CatalogProbe {
  const dialect = driver.dialect;
  if (dialect === "postgresql") {
    const schema = boundCatalogNamespace(driver);
    return {
      id: `table:${exists ? "exists" : "absent"}:${tableName}`,
      sql: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p'))`,
      parameters: [stringParam(schema), stringParam(tableName)],
      equals: exists,
    };
  }
  if (dialect === "mysql") {
    return {
      id: `table:${exists ? "exists" : "absent"}:${tableName}`,
      sql: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?)",
      parameters: [
        mysqlNamespaceParam(driver, lifetime),
        stringParam(tableName),
      ],
      equals: exists,
    };
  }
  return {
    id: `table:${exists ? "exists" : "absent"}:${tableName}`,
    sql: `SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)`,
    parameters: [stringParam(tableName)],
    equals: exists,
  };
}

export function columnExistsProbe(
  driver: MigrationDriver,
  tableName: string,
  columnName: string,
  exists: boolean,
  lifetime: CatalogProbeLifetime = "live-command"
): CatalogProbe {
  const dialect = driver.dialect;
  if (dialect === "postgresql") {
    const schema = boundCatalogNamespace(driver);
    return {
      id: `column:${exists ? "exists" : "absent"}:${tableName}.${columnName}`,
      sql: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND a.attnum > 0 AND NOT a.attisdropped)",
      parameters: [
        stringParam(schema),
        stringParam(tableName),
        stringParam(columnName),
      ],
      equals: exists,
    };
  }
  if (dialect === "mysql") {
    return {
      id: `column:${exists ? "exists" : "absent"}:${tableName}.${columnName}`,
      sql: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?)",
      parameters: [
        mysqlNamespaceParam(driver, lifetime),
        stringParam(tableName),
        stringParam(columnName),
      ],
      equals: exists,
    };
  }
  return {
    id: `column:${exists ? "exists" : "absent"}:${tableName}.${columnName}`,
    sql: "SELECT EXISTS (SELECT 1 FROM pragma_table_info(?) WHERE name = ?)",
    parameters: [stringParam(tableName), stringParam(columnName)],
    equals: exists,
  };
}

export function indexExistsProbe(
  driver: MigrationDriver,
  tableName: string,
  indexName: string,
  exists: boolean,
  lifetime: CatalogProbeLifetime = "live-command"
): CatalogProbe {
  const dialect = driver.dialect;
  if (dialect === "postgresql") {
    const schema = boundCatalogNamespace(driver);
    return {
      id: `index:${exists ? "exists" : "absent"}:${indexName}`,
      sql: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'i')`,
      parameters: [stringParam(schema), stringParam(indexName)],
      equals: exists,
    };
  }
  if (dialect === "mysql") {
    return {
      id: `index:${exists ? "exists" : "absent"}:${indexName}`,
      sql: "SELECT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?)",
      parameters: [
        mysqlNamespaceParam(driver, lifetime),
        stringParam(tableName),
        stringParam(indexName),
      ],
      equals: exists,
    };
  }
  return {
    id: `index:${exists ? "exists" : "absent"}:${indexName}`,
    sql: `SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)`,
    parameters: [stringParam(indexName)],
    equals: exists,
  };
}

export function probeForGeneratedStatement(
  driver: MigrationDriver,
  operation: DiffOperation,
  statement: string
): { pre: CatalogProbe; post: CatalogProbe } | null {
  if (
    (driver.dialect === "postgresql" || driver.dialect === "mysql") &&
    namespace(driver) === undefined
  ) {
    return null;
  }
  const text = statement.trim().toUpperCase();
  if (
    text.startsWith("PRAGMA") ||
    text.startsWith("INSERT ") ||
    text.startsWith("--")
  ) {
    return null;
  }
  switch (operation.type) {
    case "createTable":
      if (text.startsWith("CREATE TABLE")) {
        return {
          pre: tableExistsProbe(
            driver,
            operation.table.name,
            false,
            "stored-artifact"
          ),
          post: tableExistsProbe(
            driver,
            operation.table.name,
            true,
            "stored-artifact"
          ),
        };
      }
      if (text.startsWith("CREATE ") && text.includes("INDEX")) {
        const index = operation.table.indexes.find((item) =>
          statement.includes(item.name)
        );
        if (!index) return null;
        return {
          pre: indexExistsProbe(
            driver,
            operation.table.name,
            index.name,
            false,
            "stored-artifact"
          ),
          post: indexExistsProbe(
            driver,
            operation.table.name,
            index.name,
            true,
            "stored-artifact"
          ),
        };
      }
      return null;
    case "dropTable":
      return {
        pre: tableExistsProbe(
          driver,
          operation.tableName,
          true,
          "stored-artifact"
        ),
        post: tableExistsProbe(
          driver,
          operation.tableName,
          false,
          "stored-artifact"
        ),
      };
    case "addColumn":
      return {
        pre: columnExistsProbe(
          driver,
          operation.tableName,
          operation.column.name,
          false,
          "stored-artifact"
        ),
        post: columnExistsProbe(
          driver,
          operation.tableName,
          operation.column.name,
          true,
          "stored-artifact"
        ),
      };
    case "dropColumn":
      return {
        pre: columnExistsProbe(
          driver,
          operation.tableName,
          operation.columnName,
          true,
          "stored-artifact"
        ),
        post: columnExistsProbe(
          driver,
          operation.tableName,
          operation.columnName,
          false,
          "stored-artifact"
        ),
      };
    case "createIndex":
      return {
        pre: indexExistsProbe(
          driver,
          operation.tableName,
          operation.index.name,
          false,
          "stored-artifact"
        ),
        post: indexExistsProbe(
          driver,
          operation.tableName,
          operation.index.name,
          true,
          "stored-artifact"
        ),
      };
    case "dropIndex":
      return {
        pre: indexExistsProbe(
          driver,
          operation.tableName,
          operation.indexName,
          true,
          "stored-artifact"
        ),
        post: indexExistsProbe(
          driver,
          operation.tableName,
          operation.indexName,
          false,
          "stored-artifact"
        ),
      };
    default:
      return null;
  }
}

export function boundNamespace(
  driver: BoundMigrationDriver
): string | undefined {
  return namespace(driver);
}
