/**
 * The SurrealDB test estate. A driver opens its own database, and a client's
 * schema is defined from the migration serializer's neutral description, so the
 * shared driver contracts run here unchanged. This is not a migration: it creates
 * every table once, on an empty database, and plans nothing.
 */

import { PGliteDriver } from "@drivers/pglite";
import { SurrealDriver } from "@drivers/surrealdb";
import { getMigrationDriver } from "@migrations/drivers";
import { serializeModels } from "@migrations/serializer";
import type { ColumnDef, TableDef } from "@migrations/types";
import type { AnyModel } from "@schema/model";
import { sql } from "@sql";
import { RecordId, Surreal } from "surrealdb";

export const surrealUrl = process.env.SURREAL_TEST_URL;

let databases = 0;
let latest: string | undefined;
const nextDatabase = () => `t${process.pid}_${Date.now()}_${++databases}`;

class SurrealTestDriver extends SurrealDriver {
  #connected: Promise<Surreal> | undefined;
  #database: string | undefined;

  readonly #surreal = new Surreal();

  constructor() {
    super(new Surreal());
    // Connected on first use, as a URL-configured driver would be.
    this.client = null;
    // The shared contracts spell their own seeds and checks with these, and a
    // name reads the same in both languages. Nothing in the engine reads them.
    (this as { adapter: unknown }).adapter = new Proxy(this.adapter, {
      get(facts, member, receiver) {
        if (member === "identifiers")
          return {
            escape: (identifier: string) => sql.raw(identifier),
            table: (identifier: string) => sql.raw(identifier),
          };
        return Reflect.get(facts, member, receiver);
      },
    });
  }

  // The shared contracts spell a few raw statements in SQL's words.
  protected override execute<T>(
    client: never,
    statement: string,
    params: unknown[]
  ) {
    return super.execute<T>(
      client,
      statement
        .replace(DROP_TABLE, "REMOVE TABLE IF EXISTS")
        .replace(CREATE_EXTENSION, "RETURN 1")
        .replace(RAW_NAME, "DELETE FROM $1")
        .replace(RAW_KEY, (found, position) =>
          params[Number(position) - 1] instanceof RecordId
            ? found
            : `WHERE record::id(id) = $p${position}`
        ),
      params
    );
  }

  async #connect(): Promise<Surreal> {
    const surreal = this.#surreal;
    // A driver opened after a schema reads that schema's database, as a second
    // connection to one server does.
    this.#database ??= latest ?? nextDatabase();
    const database = this.#database;
    await surreal.connect(surrealUrl!, {
      authentication: { username: "root", password: "root" },
    });
    await surreal.query(
      `DEFINE NAMESPACE IF NOT EXISTS viborm; USE NS viborm; DEFINE DATABASE IF NOT EXISTS ${database};`
    );
    await surreal.use({ namespace: "viborm", database });
    return surreal;
  }

  protected override initClient(): Promise<Surreal> {
    this.#connected ??= this.#connect();
    return this.#connected;
  }

  protected override async closeClient(): Promise<void> {
    await this.#surreal.close();
    this.#connected = undefined;
  }

  async define(statements: readonly string[]): Promise<void> {
    // The first definition on a driver is a fresh database, as an in-memory one is.
    if (!this.#connected) {
      this.#database = nextDatabase();
      latest = this.#database;
    }
    const surreal = await this.initClient();
    await surreal.query(statements.join("\n"));
  }
}

export function createSurrealTestDriver(): SurrealDriver {
  return new SurrealTestDriver();
}

const ARRAY = /\[\]$/;
const DROP_TABLE = /^DROP TABLE IF EXISTS/;
const CREATE_EXTENSION = /^CREATE EXTENSION .*/;
const RAW_NAME = /^DELETE FROM "([a-z_]+)"/;
const RAW_KEY = /WHERE id = \$p(\d+)/;

function scalarType(column: ColumnDef): string {
  const type = column.type.toLowerCase();
  if (ARRAY.test(type))
    return `array<${scalarType({ ...column, type: type.replace(ARRAY, "") })}>`;
  if (type.startsWith("vector")) return "array<float>";
  if (type.includes("geometry") || type.includes("geography"))
    return "geometry<point>";
  if (type === "boolean" || type === "bool") return "bool";
  if (type.startsWith("timestamp")) return "datetime";
  if (type === "date" || type.startsWith("time")) return "string";
  if (type === "jsonb" || type === "json") return "any";
  if (type === "bytea") return "bytes";
  if (type.startsWith("numeric") || type.startsWith("decimal"))
    return "decimal";
  if (type.includes("double") || type === "real" || type.startsWith("float"))
    return "float";
  if (type.includes("int") || type.includes("serial")) return "int";
  return "string";
}

const DELETE_ACTION: Readonly<Record<string, string>> = {
  cascade: "CASCADE",
  setNull: "UNSET",
};

function fieldStatement(
  table: TableDef,
  column: ColumnDef,
  keysOf: ReadonlyMap<string, readonly string[]>
): string {
  const reference = table.foreignKeys.find(
    (key) =>
      key.columns.length === 1 &&
      key.columns[0] === column.name &&
      keysOf.get(key.referencedTable)?.join() === key.referencedColumns.join()
  );
  if (!reference) {
    const type = scalarType(column);
    // A `decimal` holds any scale and precision: the declared domain is an assertion.
    const decimal = type === "decimal" ? column.decimal : undefined;
    const bound = decimal
      ? ` ASSERT $value = NONE OR math::abs($value) < 1${"0".repeat(decimal.precision - decimal.scale)}dec`
      : "";
    return `DEFINE FIELD OVERWRITE ${column.name} ON ${table.name} TYPE ${column.nullable && type !== "any" ? `option<${type}>` : type}${bound};`;
  }
  const record = `record<${reference.referencedTable}>`;
  const action = DELETE_ACTION[reference.onDelete ?? ""] ?? "REJECT";
  const type = column.nullable ? `option<${record}>` : record;
  const assertion = column.nullable
    ? "$value = NONE OR $value.exists()"
    : "$value.exists()";
  return `DEFINE FIELD OVERWRITE ${column.name} ON ${table.name} TYPE ${type} REFERENCE ON DELETE ${action} ASSERT ${assertion};`;
}

function tableStatements(
  table: TableDef,
  modelTables: Set<string>,
  keysOf: ReadonlyMap<string, readonly string[]>
): string[] {
  if (!modelTables.has(table.name)) {
    const [first, second] = table.foreignKeys;
    return [
      `DEFINE TABLE OVERWRITE ${table.name} TYPE RELATION IN ${first!.referencedTable} OUT ${second!.referencedTable} ENFORCED SCHEMAFULL;`,
      `DEFINE INDEX OVERWRITE ${table.name}_pair ON ${table.name} FIELDS in, out UNIQUE;`,
      // A singular relation holds one edge per record on that side.
      ...table.uniqueConstraints.flatMap((unique) => {
        const end = [first, second].findIndex(
          (key) => key!.columns.join() === unique.columns.join()
        );
        return end < 0
          ? []
          : [
              `DEFINE INDEX OVERWRITE ${unique.name} ON ${table.name} FIELDS ${end === 0 ? "in" : "out"} UNIQUE;`,
            ];
      }),
    ];
  }
  const key = table.primaryKey?.columns ?? [];
  return [
    `DEFINE TABLE OVERWRITE ${table.name} SCHEMAFULL;`,
    ...(table.columns.some((column) => column.autoIncrement)
      ? [`DEFINE SEQUENCE OVERWRITE ${table.name}_seq START 1;`]
      : []),
    ...table.columns
      .filter((column) => !key.includes(column.name))
      .map((column) => fieldStatement(table, column, keysOf)),
    // An index naming the key is held by the id itself: a unique one over the
    // whole key is implied, and the id is no field an index can name.
    ...table.uniqueConstraints
      .filter(
        (unique) => !unique.columns.some((column) => key.includes(column))
      )
      .map(
        (unique) =>
          `DEFINE INDEX OVERWRITE ${unique.name} ON ${table.name} FIELDS ${unique.columns.join(", ")} UNIQUE;`
      ),
    ...table.indexes
      .filter((index) => !index.columns.some((column) => key.includes(column)))
      .map(
        (index) =>
          `DEFINE INDEX OVERWRITE ${index.name} ON ${table.name} FIELDS ${index.columns.join(", ")}${index.unique ? " UNIQUE" : ""};`
      ),
  ];
}

/**
 * A foreign key over several columns holds no record, so its action is an event
 * on the table it names, as a server would apply it.
 */
function compoundKeyEvents(
  table: TableDef,
  keysOf: ReadonlyMap<string, readonly string[]>
): string[] {
  const own = keysOf.get(table.name) ?? [];
  const held = (column: string) => {
    const position = own.indexOf(column);
    if (position < 0) return column;
    return own.length === 1 ? "id" : `id[${position}]`;
  };
  return table.foreignKeys
    .filter((key) => key.columns.length > 1)
    .map((key) => {
      const pairs = key.columns.map((column, index) => {
        const referenced = key.referencedColumns[index]!;
        const theirs = keysOf.get(key.referencedTable) ?? [];
        const position = theirs.indexOf(referenced);
        const value =
          position < 0
            ? `$before.${referenced}`
            : theirs.length === 1
              ? "record::id($before.id)"
              : `record::id($before.id)[${position}]`;
        return `${held(column)} = ${value}`;
      });
      const matching = pairs.join(" AND ");
      const action =
        key.onDelete === "cascade"
          ? `DELETE ${table.name} WHERE ${matching}`
          : key.onDelete === "setNull"
            ? `UPDATE ${table.name} SET ${key.columns
                .filter((column) => !own.includes(column))
                .map((column) => `${column} = NONE`)
                .join(", ")} WHERE ${matching}`
            : `IF array::len(SELECT VALUE id FROM ${table.name} WHERE ${matching} LIMIT 1) > 0 { THROW 'ON DELETE REJECT: ${key.name}' }`;
      return `DEFINE EVENT OVERWRITE ${key.name} ON ${key.referencedTable} WHEN $event = "DELETE" THEN { ${action} };`;
    });
}

export async function defineSurrealSchema(client: {
  $driver: unknown;
  $schema: Record<string, AnyModel>;
}): Promise<void> {
  const snapshot = serializeModels(client.$schema, {
    migrationDriver: getMigrationDriver(new PGliteDriver()),
  });
  const modelTables = new Set(
    Object.values(client.$schema).map((model) => model["~"].names.sql!)
  );
  const keysOf = new Map(
    snapshot.tables.map((table) => [
      table.name,
      table.primaryKey?.columns ?? [],
    ])
  );
  await (client.$driver as SurrealTestDriver).define(
    snapshot.tables.flatMap((table) => [
      ...tableStatements(table, modelTables, keysOf),
      ...compoundKeyEvents(table, keysOf),
    ])
  );
}
