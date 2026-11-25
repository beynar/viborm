import { renderQualifiedIdentifier } from "../sql/identifiers";
/**
 * Driver catalog probes. These are the only checks the ORM proves read-only.
 * Manual trusted-read checks are a different arm.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { BoundMigrationDriver, MigrationDriver } from "./drivers";
import { RAW_INDEX_MARKER_PREFIX, rawIndexMarker } from "./raw-index";
import type { AutoViewObject, DiffOperation, IndexDef } from "./types";
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
  if (dialect === "surrealql")
    return {
      id: `table:${exists ? "exists" : "absent"}:${tableName}`,
      sql: "RETURN [{ present: (INFO FOR DB STRUCTURE).tables.name CONTAINS $p1 }]",
      parameters: [stringParam(tableName)],
      equals: exists,
    };
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

/**
 * Whether a view of that name exists (a table of the name is not one), of the
 * kind asked: only PostgreSQL has a materialized one.
 */
export function viewExistsProbe(
  driver: MigrationDriver,
  viewName: string,
  exists: boolean,
  lifetime: CatalogProbeLifetime = "live-command",
  materialized = false
): CatalogProbe {
  const id = `${materialized ? "materialized-view" : "view"}:${exists ? "exists" : "absent"}:${viewName}`;
  // A SurrealDB view is a table defined `AS SELECT`, which `INFO` reports.
  if (driver.dialect === "surrealql")
    return {
      id,
      sql: "RETURN [{ present: (INFO FOR DB STRUCTURE).tables.filter(|$t| $t.view != NONE).name CONTAINS $p1 }]",
      parameters: [stringParam(viewName)],
      equals: exists,
    };
  if (driver.dialect === "postgresql")
    return {
      id,
      sql: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = '${materialized ? "m" : "v"}')`,
      parameters: [
        stringParam(boundCatalogNamespace(driver)),
        stringParam(viewName),
      ],
      equals: exists,
    };
  if (driver.dialect === "mysql")
    return {
      id,
      sql: "SELECT EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = ? AND table_name = ?)",
      parameters: [
        mysqlNamespaceParam(driver, lifetime),
        stringParam(viewName),
      ],
      equals: exists,
    };
  return {
    id,
    sql: "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?)",
    parameters: [stringParam(viewName)],
    equals: exists,
  };
}

/** Whether a trigger of that name exists (on `table`, where PostgreSQL names it so). */
export function triggerExistsProbe(
  driver: MigrationDriver,
  table: string,
  triggerName: string,
  exists: boolean,
  lifetime: CatalogProbeLifetime = "live-command"
): CatalogProbe {
  const id = `trigger:${exists ? "exists" : "absent"}:${table}.${triggerName}`;
  if (driver.dialect === "postgresql")
    return {
      id,
      sql: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3)",
      parameters: [
        stringParam(boundCatalogNamespace(driver)),
        stringParam(table),
        stringParam(triggerName),
      ],
      equals: exists,
    };
  if (driver.dialect === "mysql")
    return {
      id,
      sql: "SELECT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_schema = ? AND trigger_name = ?)",
      parameters: [
        mysqlNamespaceParam(driver, lifetime),
        stringParam(triggerName),
      ],
      equals: exists,
    };
  return {
    id,
    sql: "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?)",
    parameters: [stringParam(triggerName)],
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
      // An index exists only once it is VALID: an interrupted CONCURRENTLY
      // build leaves the relation behind with indisvalid = false. Absence
      // still means no relation of that name at all.
      sql: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace${exists ? " JOIN pg_catalog.pg_index x ON x.indexrelid = c.oid AND x.indisvalid" : ""} WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'i')`,
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

/**
 * Whether a raw index carries its marker (PostgreSQL holds it as the index's
 * comment, written by a statement of its own after the index's): an index
 * that exists says nothing about it, so a stepwise run would skip the comment.
 */
function rawIndexMarkerProbe(
  driver: MigrationDriver,
  index: IndexDef,
  present: boolean
): CatalogProbe {
  return {
    id: `index-marker:${present ? "present" : "absent"}:${index.name}`,
    sql: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'i' AND pg_catalog.obj_description(c.oid, 'pg_class') IS NOT DISTINCT FROM $3)",
    parameters: [
      stringParam(boundCatalogNamespace(driver)),
      stringParam(index.name),
      stringParam(RAW_INDEX_MARKER_PREFIX + rawIndexMarker(index)),
    ],
    equals: present,
  };
}

/** The raw index whose marker a `COMMENT ON INDEX` statement writes. */
function commentedRawIndex(
  operation: DiffOperation,
  statement: string
): IndexDef | undefined {
  const indexes =
    operation.type === "createIndex"
      ? [operation.index]
      : operation.type === "createTable"
        ? operation.table.indexes
        : [];
  return indexes.find(
    (index) =>
      index.raw !== undefined &&
      statement.includes(
        (RAW_INDEX_MARKER_PREFIX + rawIndexMarker(index)).replaceAll("'", "''")
      )
  );
}

const CREATE_INDEX_HEADER =
  /^\s*CREATE\s+(?:UNIQUE\s+|SPATIAL\s+|FULLTEXT\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`(?:[^`]|``)+`|[\w$]+)\s+ON\b/i;

/** The trigger a `CREATE TRIGGER` or `DROP TRIGGER` statement names, unquoted. */
const TRIGGER_HEADER =
  /^(?:CREATE|DROP) TRIGGER (?:IF EXISTS )?(?:(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`)\.)?("(?:[^"]|"")+"|`(?:[^`]|``)+`)/;

/**
 * The probes of one statement of a view kept by triggers, created or
 * dropped: its table's, its body view's, each trigger's, and each index its
 * creation carries. Its function, its marker and its rows have none: they
 * stand with the table on a transactional dialect, and MySQL's filling is
 * written again whole by its next run.
 */
function autoViewProbes(
  driver: MigrationDriver,
  view: string,
  objects: readonly AutoViewObject[],
  indexes: readonly IndexDef[],
  statement: string,
  creating: boolean
): { pre: CatalogProbe; post: CatalogProbe } | null {
  const text = statement.trimStart();
  // A creation's drops are of what a hand left: none is proven.
  if (creating && text.startsWith("DROP ")) return null;
  const pair = (probe: (exists: boolean) => CatalogProbe) => ({
    pre: probe(!creating),
    post: probe(creating),
  });
  if (text.startsWith("CREATE TABLE ") || text.startsWith("DROP TABLE "))
    return pair((exists) =>
      tableExistsProbe(driver, view, exists, "stored-artifact")
    );
  const trigger = TRIGGER_HEADER.exec(text)?.[1];
  if (trigger !== undefined) {
    const name = trigger
      .slice(1, -1)
      .replaceAll(trigger[0]! + trigger[0], trigger[0]!);
    const object = objects.find(
      (candidate) => candidate.kind === "trigger" && candidate.name === name
    );
    return object
      ? pair((exists) =>
          triggerExistsProbe(
            driver,
            object.table!,
            name,
            exists,
            "stored-artifact"
          )
        )
      : null;
  }
  const body = objects.find((object) => object.kind === "view");
  if (
    body &&
    (text.startsWith("CREATE VIEW ") || text.startsWith("DROP VIEW "))
  )
    return pair((exists) =>
      viewExistsProbe(driver, body.name, exists, "stored-artifact")
    );
  return creating ? createdIndexProbes(driver, view, indexes, statement) : null;
}

/** A view's own creation, materialized or not, as the SQL drivers write it. */
const VIEW_CREATION = /^CREATE (?:MATERIALIZED )?VIEW /;

/** The name a `CREATE INDEX` statement gives its index, unquoted. */
function createdIndexName(statement: string): string | undefined {
  const name = CREATE_INDEX_HEADER.exec(statement)?.[1];
  if (name === undefined) return undefined;
  const quote = name[0];
  return quote === '"' || quote === "`"
    ? name.slice(1, -1).replaceAll(quote + quote, quote)
    : name;
}

/**
 * The probes of a `CREATE INDEX` statement that an operation creating a
 * relation runs after it (a table, a materialized view): the index named in
 * its header, neither one whose name it extends (`by_email_b`) nor a column
 * it indexes.
 */
function createdIndexProbes(
  driver: MigrationDriver,
  relation: string,
  indexes: readonly IndexDef[],
  statement: string
): { pre: CatalogProbe; post: CatalogProbe } | null {
  const text = statement.trim().toUpperCase();
  if (!(text.startsWith("CREATE ") && text.includes("INDEX"))) return null;
  const created = createdIndexName(statement);
  const index = indexes.find((item) => item.name === created);
  if (!index) return null;
  return {
    pre: indexExistsProbe(
      driver,
      relation,
      index.name,
      false,
      "stored-artifact"
    ),
    post: indexExistsProbe(
      driver,
      relation,
      index.name,
      true,
      "stored-artifact"
    ),
  };
}

export function probeForGeneratedStatement(
  driver: MigrationDriver,
  operation: DiffOperation,
  statement: string
): { pre: CatalogProbe; post: CatalogProbe } | null {
  // An operation here is several statements, and they run in the one transaction.
  if (driver.dialect === "surrealql") return null;
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
  if (text.startsWith("COMMENT ON INDEX")) {
    const index = commentedRawIndex(operation, statement);
    return index === undefined
      ? null
      : {
          pre: rawIndexMarkerProbe(driver, index, false),
          post: rawIndexMarkerProbe(driver, index, true),
        };
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
      return createdIndexProbes(
        driver,
        operation.table.name,
        operation.table.indexes,
        statement
      );
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
    case "addColumn": {
      const pre = columnExistsProbe(
        driver,
        operation.tableName,
        operation.column.name,
        false,
        "stored-artifact"
      );
      const required =
        !operation.column.nullable &&
        operation.column.default === undefined &&
        !operation.column.autoIncrement;
      const table = renderQualifiedIdentifier(
        (name) => driver.escapeIdentifier(name),
        driver.dialect === "postgresql" ? namespace(driver) : undefined,
        operation.tableName
      );
      return {
        pre: required
          ? {
              ...pre,
              id: `column:absent-and-empty-table:${operation.tableName}.${operation.column.name}`,
              sql: `SELECT (${pre.sql.slice("SELECT ".length)}) OR EXISTS (SELECT 1 FROM ${table} LIMIT 1)`,
            }
          : pre,
        post: columnExistsProbe(
          driver,
          operation.tableName,
          operation.column.name,
          true,
          "stored-artifact"
        ),
      };
    }
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
    case "createView":
      if (operation.view.auto)
        return autoViewProbes(
          driver,
          operation.view.name,
          operation.view.auto.objects,
          operation.view.indexes ?? [],
          statement,
          true
        );
      // A materialized view's creation is followed by its indexes.
      if (!VIEW_CREATION.test(text))
        return createdIndexProbes(
          driver,
          operation.view.name,
          operation.view.indexes ?? [],
          statement
        );
      return {
        pre: viewExistsProbe(
          driver,
          operation.view.name,
          false,
          "stored-artifact",
          operation.view.materialized
        ),
        post: viewExistsProbe(
          driver,
          operation.view.name,
          true,
          "stored-artifact",
          operation.view.materialized
        ),
      };
    case "dropView":
      if (operation.auto)
        return autoViewProbes(
          driver,
          operation.viewName,
          operation.auto.objects,
          [],
          statement,
          false
        );
      return {
        pre: viewExistsProbe(
          driver,
          operation.viewName,
          true,
          "stored-artifact",
          operation.materialized
        ),
        post: viewExistsProbe(
          driver,
          operation.viewName,
          false,
          "stored-artifact",
          operation.materialized
        ),
      };
    default:
      return null;
  }
}

/** One index an interrupted CONCURRENTLY build left INVALID. */
export interface InvalidIndex {
  readonly table: string;
  readonly index: string;
}

/**
 * The INVALID indexes on the estate's managed tables. Only PostgreSQL has the
 * state: MySQL and SQLite build an index or fail without leaving one behind.
 */
export async function readInvalidIndexes(
  producer: AnyDriver,
  driver: BoundMigrationDriver
): Promise<readonly InvalidIndex[]> {
  if (driver.dialect !== "postgresql") return [];
  const result = await producer._executeRaw<InvalidIndex>(
    `SELECT t.relname AS "table", i.relname AS "index" FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relkind = 'r' AND NOT (x.indisvalid AND x.indisready) ORDER BY t.relname, i.relname`,
    [boundCatalogNamespace(driver)]
  );
  const managed = driver.target.tables;
  return result.rows.filter(
    (row) => managed === undefined || managed.includes(row.table)
  );
}

export function boundNamespace(
  driver: BoundMigrationDriver
): string | undefined {
  return namespace(driver);
}

/**
 * One object's name as a live statement spells it: qualified with the bound
 * namespace, or bare on SQLite and on unbound MySQL.
 */
export function qualifiedName(
  driver: BoundMigrationDriver,
  name: string
): string {
  return renderQualifiedIdentifier(
    (part) => driver.escapeIdentifier(part),
    driver.target.dialect === "sqlite" || driver.target.dialect === "surrealql"
      ? undefined
      : namespace(driver),
    name
  );
}
