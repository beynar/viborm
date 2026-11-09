/**
 * `docs/architecture/query-backend-frontier.md`.
 *
 * Schema in SurrealQL, from the snapshot every driver shares. A foreign key to a
 * record's key is a `record<t> REFERENCE` field; one over several columns, another
 * unique field or a part of the row's own key is events on the table it names; a
 * generated junction is an edge table. `INFO ... STRUCTURE` reads it all back, and
 * a `COMMENT` holds what the database cannot say: the schema's names for what is
 * physically `id`, `in` and `out`, and the actions no statement states.
 */

import type { ScalarState } from "@schema/scalars/common";
import type { AnyDriver } from "../../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import { isRecord, isString } from "../../../validation/value-guards";
import { CONTROL_TABLES } from "../../control";
import {
  rawIndexMarker,
  readRawIndexMarker,
  refuseRawIndexStatement,
  renderRawIndex,
} from "../../raw-index";
import { readSurrealStatements } from "../../statement-safety";
import type {
  ColumnDef,
  DiffOperation,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import {
  type AddColumnOperation,
  type AddForeignKeyOperation,
  type AddPrimaryKeyOperation,
  type AddUniqueConstraintOperation,
  type AlterColumnOperation,
  type CreateIndexOperation,
  type CreateTableOperation,
  type DDLContext,
  type DerivedRename,
  type DropColumnOperation,
  type DropForeignKeyOperation,
  type DropIndexOperation,
  type DropPrimaryKeyOperation,
  type DropTableOperation,
  type DropUniqueConstraintOperation,
  MigrationDriver,
  type RenameColumnOperation,
  type RenameTableOperation,
} from "../base";
import type { MigrationCapabilities } from "../types";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RECORD_TARGET = /record<(.+)>/;
/** The record a command holds while it runs: no session can hold anything here. */
const LOCK_TABLE = "viborm_migration_lock";
/** The history's own tables: no schema declares them. */
const CONTROL_NAMES: ReadonlySet<string> = new Set(
  Object.values(CONTROL_TABLES)
);
const LOCK_RECORD = `${LOCK_TABLE}:command`;
/** How long a lock outlives the command that took it, if that command died. */
const LOCK_LEASE = "15m";
const LOCK_RETRY_MS = 50;
/**
 * How long a command waits for the indexes its program builds in the background,
 * and how often it looks. An index on a table no row is in yet is ready well
 * under a second: five minutes leave a slow server room, inside the lock's lease
 * unless the program itself took most of it. The pause doubles from the first to
 * the last.
 */
const INDEX_BUILD_WAIT_MS = 300_000;
const INDEX_BUILD_FIRST_PAUSE_MS = 50;
const INDEX_BUILD_LAST_PAUSE_MS = 2000;

const SCALAR_KINDS: Readonly<Record<string, string>> = {
  string: "string",
  // SQL's `integer` is 32 bits, and a plain `int` here would hold what it refuses.
  int: "i32",
  bigint: "int",
  number: "float",
  decimal: "decimal",
  boolean: "bool",
  datetime: "datetime",
  date: "string",
  time: "string",
  json: "any",
  blob: "bytes",
  vector: "array<float>",
  point: "geometry<point>",
  enum: "string",
};

/** Where a field named `id` beside a key of another name lives: `id` is the record's. */
const ID_FIELD = "id_field";

/** What an old copy of a moved record holds, for the events on it to read. */
const MOVED_FIELD = "viborm_moved";

/** Parts of a compound key that can be named, which makes it a key range. */
const KEY_PART_KINDS = new Set(["string", "int", "datetime", "bool"]);

const DELETE_ACTIONS: Readonly<Record<string, string>> = {
  cascade: "CASCADE",
  setNull: "UNSET",
};

function refuse(what: string): never {
  throw new MigrationError(
    `SurrealDB migrations do not support ${what} yet.`,
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

/** What a partial index's predicate is written with. */
const PREDICATE_TOKEN = /"[^"]+"|'(?:[^']|'')*'|<>|!=|<=|>=|[=<>(),]|[\w.-]+/g;
const PREDICATE_NAME = /^[A-Za-z_]\w*$/;
const PREDICATE_VALUE = /^(?:-?\d+(?:\.\d+)?|true|false)$/i;
const PREDICATE_OPERATOR = /^(?:=|<>|!=|<|>|<=|>=)$/;
const partialField = (index: string) => `partial_${index}`;
/** A program building an index in the background, however it is spelled. */
const CONCURRENTLY = /\bconcurrently\b/i;

/** What a table's comment says: the names and types a record's key does not hold. */
type TableFacts = {
  readonly key?: readonly { readonly name: string; readonly type: string }[];
  readonly junction?: TableDef;
};

/** What a field's comment says, for what its definition cannot. */
type FieldFacts = {
  readonly type?: string;
  readonly decimal?: ColumnDef["decimal"];
  readonly default?: string;
  /** `any` admits `NONE` whatever it asserts, so only this can say otherwise. */
  readonly required?: true;
  readonly fk?: Pick<ForeignKeyDef, "name" | "onDelete" | "onUpdate">;
};

/** What a foreign key's event says: everything, since nothing else holds it. */
type EventFacts = {
  readonly table: string;
  readonly fk: ForeignKeyDef;
};

type FieldInfo = {
  readonly name: string;
  readonly kind: string;
  readonly comment?: string;
  readonly default?: string;
  readonly reference?: { readonly on_delete?: string };
};
/** An index, with its build as `INFO FOR INDEX` tells it. */
type IndexInfo = {
  readonly name: string;
  readonly table: string;
  readonly cols: readonly string[];
  readonly index?: unknown;
  readonly comment?: string;
  readonly status: string;
  readonly error?: string;
};
/** What a partial index's comment says, since its fields are a computed one. */
type PartialFacts = {
  readonly where: string;
  readonly columns: readonly string[];
};
type EventInfo = { readonly name: string; readonly comment?: string };
type TableInfo = {
  readonly fields: readonly FieldInfo[];
  readonly indexes: readonly IndexInfo[];
  readonly events: readonly EventInfo[];
};
type DatabaseInfo = {
  readonly sequences: readonly { readonly name: string }[];
  readonly tables: readonly {
    readonly name: string;
    readonly comment?: string;
    readonly kind: { readonly kind: string };
  }[];
};

/** A comment's JSON, `{}` where there is none, `undefined` where it is not JSON. */
function commentJson(comment: string | undefined): unknown {
  if (!comment) return {};
  try {
    return JSON.parse(comment);
  } catch {
    return undefined;
  }
}

/**
 * What a comment VibORM wrote says. A table it manages keeps VibORM's facts in
 * its table and field comments, so one that is not JSON there is a hand-made
 * change no snapshot can read, refused before effects; elsewhere it says
 * nothing.
 */
function parsed<T>(
  comment: string | undefined,
  managed = false,
  owner?: string
): T {
  const facts = commentJson(comment);
  if (facts !== undefined) return facts as T;
  if (managed)
    throw new MigrationError(
      `SurrealDB ${owner} carries a comment VibORM did not write, where VibORM keeps what its definition cannot say. Synchronization refuses before effects; restore or remove the comment, or manage the table outside this synchronization scope.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { feature: "comment" } }
    );
  return {} as T;
}

/** The index kinds VibORM defines: a plain index and a unique one. */
const OWN_INDEX_KINDS: ReadonlySet<unknown> = new Set(["", "UNIQUE"]);
const OWN_INDEX_TYPES: ReadonlySet<unknown> = new Set([
  "btree",
  "hash",
  "gin",
  "gist",
  "fulltext",
  "spatial",
]);

/** Whether an index comment is one of the facts VibORM writes on its own indexes. */
function ownIndexFacts(facts: unknown): boolean {
  if (!isRecord(facts)) return false;
  const keys = Object.keys(facts).sort().join();
  if (keys === "") return true;
  if (keys === "type") return OWN_INDEX_TYPES.has(facts.type);
  return (
    keys === "columns,where" &&
    isString(facts.where) &&
    Array.isArray(facts.columns) &&
    facts.columns.every(isString)
  );
}

export class SurrealMigrationDriver extends MigrationDriver {
  readonly dialect = "surrealql";
  readonly driverName = "surrealql";
  readonly capabilities: MigrationCapabilities = {
    supportsNativeEnums: false,
    supportsAddEnumValueInTransaction: false,
    supportsIndexTypes: ["btree", "hash", "gin", "gist", "fulltext", "spatial"],
    supportsNativeArrays: true,
    // A forward reference is added once its table exists, which a field needs.
    supportsAddForeignKeyViaAlter: true,
    introspectionReadsConstraintNames: true,
  };

  /**
   * An index is built from committed rows, so it cannot share a transaction with
   * the backfill of a field on its table, or with its table's removal. Each statement then stands alone, and a
   * failure part-way leaves what the next push plans from.
   */
  override buildsApart(
    operations: readonly DiffOperation[],
    reset?: boolean
  ): boolean {
    if (reset) return true;
    // Each writes rows ahead of defining what reads them.
    if (
      operations.some(
        ({ type }) =>
          type === "renameColumn" ||
          type === "renameTable" ||
          type === "addPrimaryKey"
      )
    )
      return true;
    // Its rows are rewritten first, which an index cannot share a transaction with.
    if (
      operations.some(
        (operation) =>
          operation.type === "createIndex" &&
          operation.index.unique &&
          operation.index.where
      )
    )
      return true;
    const backfilled = new Set(
      operations.flatMap((operation) =>
        operation.type === "addColumn" &&
        operation.column.default !== undefined &&
        !operation.column.nullable
          ? [operation.tableName]
          : []
      )
    );
    return operations.some(
      (operation) =>
        (operation.type === "createIndex" ||
          operation.type === "addUniqueConstraint") &&
        backfilled.has(operation.tableName)
    );
  }

  override escapeIdentifier(name: string): string {
    return IDENTIFIER.test(name) ? name : `\`${name.replaceAll("`", "\\`")}\``;
  }

  escapeValue(value: string | null | undefined): string {
    return value == null ? "NONE" : JSON.stringify(value);
  }

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  mapScalarType(_scalar: unknown, state: ScalarState): string {
    const kind = SCALAR_KINDS[state.type];
    if (!kind) return refuse(`a field of type '${state.type}'`);
    return state.array ? `array<${kind}>` : kind;
  }

  getEnumColumnType(): string {
    return "string";
  }

  /**
   * Only what a row already stored can be given: the engine writes every default
   * on a create, so a database default only ever answers a new column's old rows.
   */
  override getDefaultExpression(
    _scalar: unknown,
    state: ScalarState
  ): string | undefined {
    if (state.autoGenerate?.kind === "now") return "time::now()";
    if (state.array || !state.hasDefault) return undefined;
    const value = this.literalDefaultValue(state);
    switch (state.type) {
      case "string":
      case "enum":
      case "date":
      case "time":
        return typeof value === "string" ? JSON.stringify(value) : undefined;
      case "int":
      case "bigint":
      case "number":
        return typeof value === "number" || typeof value === "bigint"
          ? String(value)
          : undefined;
      case "decimal":
        return typeof value === "string" || typeof value === "number"
          ? `${value}dec`
          : undefined;
      case "boolean":
        return typeof value === "boolean" ? String(value) : undefined;
      case "datetime":
        return value instanceof Date
          ? `<datetime>${JSON.stringify(value.toISOString())}`
          : typeof value === "string"
            ? `<datetime>${JSON.stringify(value)}`
            : undefined;
      default:
        return undefined;
    }
  }

  /**
   * What the id already is goes: a unique over the whole key, and an index over the
   * key in its own order. An index holding the key among other columns stays, as it
   * orders those columns. A part of a compound key can only be indexed under a name,
   * which a `decimal` part has none of.
   */
  override finalizeTable(declared: TableDef): TableDef {
    if (declared.junction || !declared.primaryKey) return declared;
    // An array id holds its parts in the order the engine writes them, its
    // fields' declaration order, whatever order the key lists them in.
    const listed = declared.primaryKey.columns;
    const key = declared.columns
      .map(({ name }) => name)
      .filter((name) => listed.includes(name));
    const table: TableDef = {
      ...declared,
      primaryKey: { ...declared.primaryKey, columns: key },
    };
    const named = namedKeyParts(table, key, () => true) !== undefined;
    const whole = (columns: readonly string[]) =>
      key.every((part) => columns.includes(part));
    const nameless = (columns: readonly string[]) =>
      key.length > 1 &&
      !named &&
      columns.some((column) => key.includes(column));
    const held = (columns: readonly string[]) =>
      whole(columns) || nameless(columns);
    return {
      ...table,
      uniqueConstraints: table.uniqueConstraints.filter((unique) => {
        if (held(unique.columns) && !whole(unique.columns))
          refuse(
            `the unique '${unique.name}' over a part of a key that cannot be named`
          );
        return !held(unique.columns);
      }),
      // A raw index is its author's text, never one the key already is.
      indexes: table.indexes.filter(
        ({ columns, unique, raw }) =>
          raw !== undefined ||
          !(
            nameless(columns) ||
            (unique && whole(columns)) ||
            columns.join() === key.join()
          )
      ),
    };
  }

  override markJunction(table: TableDef): TableDef {
    return { ...table, junction: true };
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  async introspect(
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<SchemaSnapshot> {
    const one = async <T>(statement: string) =>
      (await executeRaw<T>(`RETURN [${statement}]`)).rows[0]!;
    // Only what the schema is: an answer also holds how far the server's own
    // work on a removed field has come, which changes under any transaction.
    const database = await one<DatabaseInfo>(
      "(INFO FOR DB STRUCTURE).{ tables, sequences }"
    );
    const sequences = new Set(database.sequences.map(({ name }) => name));
    const known = database.tables.filter(
      ({ name }) => name !== LOCK_TABLE && !CONTROL_NAMES.has(name)
    );
    const managedTables = this.target?.tables;
    const managed = (name: string) =>
      managedTables === undefined || managedTables.includes(name);
    const infos = new Map<string, TableInfo>();
    for (const { name } of known) {
      const table = this.escapeIdentifier(name);
      const info = await one<TableInfo>(
        `(INFO FOR TABLE ${table} STRUCTURE).{ fields, indexes: indexes.map(|$i| $i + (INFO FOR INDEX $i.name ON ${table}).building), events }`
      );
      // A failed build leaves its table refusing every write, which its
      // definition does not show: refused before effects, as PostgreSQL
      // refuses an INVALID index.
      const failed =
        managed(name) && info.indexes.find(({ status }) => status === "error");
      if (failed) throw unbuilt(failed, `failed to build: ${failed.error}`);
      infos.set(name, info);
    }
    const tables = known.map((table) => {
      const info = infos.get(table.name)!;
      const facts = parsed<TableFacts>(
        table.comment,
        managed(table.name),
        `table "${table.name}"`
      );
      return facts.junction
        ? { ...facts.junction, junction: true as const }
        : tableFrom(table.name, info, facts, sequences, managed(table.name));
    });
    // A link names its target's whole key, which only the target's comment says.
    for (const table of tables)
      for (const fk of table.foreignKeys)
        if (fk.referencedColumns.length === 0)
          fk.referencedColumns =
            tables.find(({ name }) => name === fk.referencedTable)?.primaryKey
              ?.columns ?? [];
    // A key held by events is stated on the table it names.
    for (const info of infos.values())
      for (const event of info.events) {
        const facts = parsed<Partial<EventFacts>>(event.comment);
        if (!facts.fk) continue;
        tables
          .find(({ name }) => name === facts.table)
          ?.foreignKeys.push(facts.fk);
      }
    return { tables };
  }

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------

  /** A table as the program has it: `own`, one it creates, or the live one. */
  private tableNamed(
    table: string,
    context: DDLContext,
    own?: TableDef
  ): TableDef | undefined {
    if (own?.name === table) return own;
    for (const operation of [
      ...(context.precedingOperations ?? []),
      ...(context.followingOperations ?? []),
    ])
      if (operation.type === "createTable" && operation.table.name === table)
        return operation.table;
    return context.currentSchema?.tables.find(({ name }) => name === table);
  }

  private keyOf(
    table: string,
    context: DDLContext,
    own?: TableDef
  ): readonly string[] {
    return this.tableNamed(table, context, own)?.primaryKey?.columns ?? [];
  }

  /**
   * The table a column holds a record of, as the engine writes it: one naming a
   * single key whole, a field or a part of a compound key. A key of one column is
   * its record's id, which holds the value.
   */
  private linkedTable(
    table: TableDef,
    column: string,
    context: DDLContext
  ): string | undefined {
    const key = table.primaryKey?.columns ?? [];
    if (key.length === 1 && key[0] === column) return undefined;
    return table.foreignKeys.find(
      (fk) =>
        fk.columns.length === 1 &&
        fk.columns[0] === column &&
        this.keyOf(fk.referencedTable, context, table).join() ===
          fk.referencedColumns.join()
    )?.referencedTable;
  }

  /** A foreign key a field can hold: one column, naming a record's whole key. */
  private holdsRecord(
    fk: ForeignKeyDef,
    context: DDLContext,
    own: TableDef,
    key: readonly string[]
  ): boolean {
    return (
      fk.columns.length === 1 &&
      !key.includes(fk.columns[0]!) &&
      this.keyOf(fk.referencedTable, context, own).join() ===
        fk.referencedColumns.join()
    );
  }

  private field(
    table: string,
    column: ColumnDef,
    fk: ForeignKeyDef | undefined,
    migrate = false,
    overwrite = false
  ): string {
    const name = this.escapeIdentifier(column.name);
    const define = `DEFINE FIELD ${overwrite ? "OVERWRITE " : ""}${name} ON ${this.escapeIdentifier(table)}`;
    const comment = (facts: FieldFacts) => {
      const present = Object.fromEntries(
        Object.entries(facts).filter(([, value]) => value !== undefined)
      );
      return Object.keys(present).length > 0
        ? ` COMMENT ${JSON.stringify(JSON.stringify(present))}`
        : "";
    };
    if (fk) {
      const record = `record<${this.escapeIdentifier(fk.referencedTable)}>`;
      const type = column.nullable ? `option<${record}>` : record;
      const action = DELETE_ACTIONS[fk.onDelete ?? ""] ?? "REJECT";
      const assertion = column.nullable
        ? "$value = NONE OR $value.exists()"
        : "$value.exists()";
      return `${define} TYPE ${type} REFERENCE ON DELETE ${action}${comment({
        type: column.type,
        fk: { name: fk.name, onDelete: fk.onDelete, onUpdate: fk.onUpdate },
      })} ASSERT ${assertion};`;
    }
    const type =
      column.nullable && column.type !== "any"
        ? `option<${column.type}>`
        : column.type;
    const { decimal } = column;
    // A `decimal` holds any scale and precision: the declared domain is an assertion.
    const bound =
      column.type === "decimal" && decimal
        ? ` ASSERT $value = NONE OR math::abs($value) < 1${"0".repeat(decimal.precision - decimal.scale)}dec`
        : column.type === "any" && !column.nullable
          ? " ASSERT $value != NONE"
          : "";
    const backfill =
      migrate && column.default !== undefined && !column.nullable
        ? ` MIGRATE EXISTING ROWS AS ${this.escapeIdentifier(`add_${table}_${column.name}`)} USING ${column.default}`
        : "";
    const defaulted =
      column.default === undefined ? "" : ` DEFAULT ${column.default}`;
    return `${define} TYPE ${type}${defaulted}${comment({
      decimal,
      default: column.default,
      required: column.type === "any" && !column.nullable ? true : undefined,
    })}${bound}${backfill};`;
  }

  /**
   * `statements` with a table's schema open: a populated SCHEMAFULL table refuses a
   * field its rows do not hold yet, and these give the rows what they will hold.
   */
  private schemaOpen(table: string, statements: readonly string[]): string[] {
    const name = this.escapeIdentifier(table);
    return [
      `ALTER TABLE ${name} SCHEMALESS;`,
      ...statements,
      `ALTER TABLE ${name} SCHEMAFULL;`,
    ];
  }

  /**
   * `concurrently` builds it in the background, after its transaction commits:
   * only for a table the same program creates, which no row can be in yet
   * ({@link awaitIndexBuilds} waits for it). On rows already there a build in
   * the background would let a duplicate through, where this refuses at once.
   */
  private index(
    table: string,
    name: string,
    columns: readonly string[],
    unique: boolean,
    concurrently = false,
    comment?: unknown
  ): string {
    const facts =
      comment === undefined
        ? ""
        : ` COMMENT ${JSON.stringify(JSON.stringify(comment))}`;
    return `DEFINE INDEX ${this.escapeIdentifier(name)} ON ${this.escapeIdentifier(table)} FIELDS ${columns.map((column) => this.escapeIdentifier(column)).join(", ")}${unique ? " UNIQUE" : ""}${facts}${concurrently ? " CONCURRENTLY" : ""};`;
  }

  /**
   * An index with no native partial form. A unique one holds over a computed field,
   * which is `NONE` outside the predicate and so is not indexed. An array would be
   * indexed member by member, so several columns are one text. One that only speeds
   * reads loses nothing by covering every row.
   */
  private plainIndex(
    table: TableDef,
    index: IndexDef,
    populated = false,
    concurrently = false
  ): string[] {
    if (index.raw) return [this.rawIndex(table, index)];
    const columns = index.columns.map((column) => partName(table, column));
    // SurrealDB has one kind of index to give any of these. A reader of a point or a
    // text scans as it would without it; its comment keeps what was declared.
    if (!index.where)
      return [
        this.index(
          table.name,
          index.name,
          columns,
          index.unique,
          concurrently,
          index.type && index.type !== "btree"
            ? { type: index.type }
            : undefined
        ),
      ];
    const condition = this.partialCondition(table, index);
    const facts: PartialFacts = { where: index.where, columns: index.columns };
    if (!index.unique)
      return [
        this.index(table.name, index.name, columns, false, concurrently, facts),
      ];
    const self = this.escapeIdentifier(table.name);
    const read = columns.map((column) => this.escapeIdentifier(column));
    const value = read.length === 1 ? read[0] : `<string>[${read.join(", ")}]`;
    const field = partialField(index.name);
    return [
      `DEFINE FIELD OVERWRITE ${this.escapeIdentifier(field)} ON ${self} TYPE any VALUE IF ${condition} { ${value} } ELSE { NONE } COMMENT ${JSON.stringify(JSON.stringify({ partial: true }))};`,
      ...(populated ? [`UPDATE ${self} RETURN NONE;`] : []),
      this.index(table.name, index.name, [field], true, concurrently, facts),
    ];
  }

  /**
   * A raw index's text, its marker its comment: inline, so that no window
   * between two statements leaves the index without it.
   */
  private rawIndex(table: TableDef, index: IndexDef): string {
    const rendered = renderRawIndex(index, {
      name: this.escapeIdentifier(index.name),
      table: this.escapeIdentifier(table.name),
      column: (column) => this.escapeIdentifier(partName(table, column)),
    });
    refuseRawIndexStatement(index, rendered, readSurrealStatements, [
      "COMMENT",
      "CONCURRENTLY",
    ]);
    return `${rendered}\nCOMMENT ${JSON.stringify(rawIndexMarker(index))};`;
  }

  /** What two spellings of one predicate translate to: nothing to change between them. */
  override async canonicalizeIndexPredicates(
    tableName: string,
    predicates: readonly string[]
  ): Promise<ReadonlyArray<string | undefined>> {
    const table = {
      name: tableName,
      columns: [],
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    };
    return predicates.map((where) => {
      try {
        return outerParenthesesGone(
          this.partialCondition(table, {
            name: "canonical",
            columns: [],
            unique: false,
            where,
          })
        );
      } catch {
        return undefined;
      }
    });
  }

  /**
   * A predicate SurrealDB can hold, translated from what it is written in: columns
   * compared with values, set or unset, `IN` a list, joined by `AND`, `OR` and `NOT`.
   */
  private partialCondition(table: TableDef, index: IndexDef): string {
    const refused = () => refuse(`the partial index '${index.name}'`);
    const tokens = index.where!.match(PREDICATE_TOKEN) ?? [];
    if (tokens.join("").replace(/\s/g, "") !== index.where!.replace(/\s/g, ""))
      refused();
    let at = 0;
    const word = (text: string) => {
      if (tokens[at]?.toUpperCase() !== text) return false;
      at += 1;
      return true;
    };
    const key = table.primaryKey?.columns ?? [];
    const column = (): string => {
      const token = tokens[at++] ?? refused();
      const name = token.startsWith('"') ? token.slice(1, -1) : token;
      if (!PREDICATE_NAME.test(name)) refused();
      // A key's value is its record's id, whatever its parts are named.
      const part = key.indexOf(name);
      if (part >= 0)
        return key.length === 1 ? "record::id(id)" : `record::id(id)[${part}]`;
      return this.escapeIdentifier(partName(table, name));
    };
    const value = (): string => {
      const token = tokens[at++] ?? refused();
      if (token.startsWith("'"))
        return JSON.stringify(token.slice(1, -1).replaceAll("''", "'"));
      if (PREDICATE_VALUE.test(token)) return token.toLowerCase();
      return refused();
    };
    const term = (): string => {
      if (word("NOT")) return `!(${term()})`;
      if (word("(")) {
        const inner = disjunction();
        if (!word(")")) refused();
        return `(${inner})`;
      }
      const held = column();
      if (word("IS")) {
        const negated = word("NOT");
        if (!word("NULL")) refused();
        return `${held} ${negated ? "!=" : "="} NONE`;
      }
      if (word("NOT")) {
        if (!(word("IN") && word("("))) refused();
        return `${held} NOT IN ${list()}`;
      }
      if (word("IN")) {
        if (!word("(")) refused();
        return `${held} IN ${list()}`;
      }
      const operator = tokens[at++] ?? refused();
      if (!PREDICATE_OPERATOR.test(operator)) refused();
      return `(${held} != NONE AND ${held} ${operator === "<>" ? "!=" : operator} ${value()})`;
    };
    const list = (): string => {
      const values = [value()];
      while (word(",")) values.push(value());
      if (!word(")")) refused();
      return `[${values.join(", ")}]`;
    };
    const conjunction = (): string => {
      const terms = [term()];
      while (word("AND")) terms.push(term());
      return terms.join(" AND ");
    };
    const disjunction = (): string => {
      const terms = [conjunction()];
      while (word("OR")) terms.push(conjunction());
      return terms.join(" OR ");
    };
    const condition = disjunction();
    if (at !== tokens.length) refused();
    return condition;
  }

  /**
   * The event that checks, on the rows holding a foreign key that holds no record,
   * that what they name is there, as a `REFERENCE` field asserts `$value.exists()`.
   * A row with any of its columns unset names nothing; an update checks only a
   * changed reference, since a record's key never changes in place.
   */
  private existence(
    table: TableDef,
    fk: ForeignKeyDef,
    ownKey: readonly string[],
    theirs: readonly string[],
    context: DDLContext
  ): string {
    const position = (column: string) => ownKey.indexOf(column);
    // What a column of the row names, as a value, whether it is held as one.
    const named = (column: string) => {
      const at = position(column);
      const read =
        at < 0
          ? `$after.${this.escapeIdentifier(column)}`
          : ownKey.length === 1
            ? "record::id($after.id)"
            : `record::id($after.id)[${at}]`;
      if (this.linkedTable(table, column, context))
        return `record::id(${read})`;
      // An array id holds a part as its key kind: an `i32` column's value is an `int` there.
      const type = table.columns.find(({ name }) => name === column)?.type;
      return at >= 0 || type === undefined || keyKind(type) === type
        ? read
        : `<${keyKind(type)}>${read}`;
    };
    const target = this.tableNamed(fk.referencedTable, context, table);
    // That value as the target holds it.
    const held = (referenced: string, value: string) => {
      const linked = target && this.linkedTable(target, referenced, context);
      return linked
        ? `type::record(${JSON.stringify(linked)}, ${value})`
        : value;
    };
    const value = (referenced: string) =>
      held(
        referenced,
        named(fk.columns[fk.referencedColumns.indexOf(referenced)]!)
      );
    const whole =
      theirs.length > 0 &&
      theirs.length === fk.referencedColumns.length &&
      theirs.every((column) => fk.referencedColumns.includes(column));
    const theirsAt = (referenced: string) => {
      const at = theirs.indexOf(referenced);
      if (at < 0) return this.escapeIdentifier(referenced);
      return theirs.length === 1 ? "record::id(id)" : `record::id(id)[${at}]`;
    };
    // The record itself where the key is whole, which no scan has to find.
    const found = whole
      ? `record::exists(type::record(${JSON.stringify(fk.referencedTable)}, ${theirs.length === 1 ? value(theirs[0]!) : `[${theirs.map(value).join(", ")}]`}))`
      : `array::len(SELECT VALUE id FROM ${this.escapeIdentifier(fk.referencedTable)} WHERE ${fk.referencedColumns
          .map((referenced) => `${theirsAt(referenced)} = ${value(referenced)}`)
          .join(" AND ")} LIMIT 1) > 0`;
    const unkeyed = fk.columns
      .filter((column) => position(column) < 0)
      .map((column) => this.escapeIdentifier(column));
    const changed = unkeyed
      .map((column) => `$before.${column} != $after.${column}`)
      .join(" OR ");
    // A record moving to a new key is written with a stand-in for a unique
    // field until the copy is whole, and only the update that writes it back
    // holds the reference: a new row holding one is checked by that update.
    const stood = new Set(
      [
        ...table.uniqueConstraints,
        ...table.indexes.filter(({ unique, raw }) => unique && !raw),
      ]
        .map(({ columns }) => columns)
        .filter((columns) => !columns.some((column) => position(column) >= 0))
        .flat()
    );
    const created = !fk.columns.some((column) => stood.has(column));
    const updated = changed ? `($event = "UPDATE" AND (${changed}))` : "";
    const when = [
      created && updated
        ? `($event = "CREATE" OR ${updated})`
        : created
          ? `$event = "CREATE"`
          : updated,
      ...unkeyed.map((column) => `$after.${column} != NONE`),
    ].join(" AND ");
    // In the words the driver reads a refused reference by.
    const refusal = `Found no ${fk.referencedTable} row for ${fk.name}, but a reference must conform to: its target exists()`;
    return `DEFINE EVENT ${this.escapeIdentifier(`${fk.name}_exists`)} ON ${this.escapeIdentifier(table.name)} WHEN ${when} THEN { IF !(${found}) { THROW ${JSON.stringify(refusal)} } };`;
  }

  /**
   * The events that do what a foreign key holding no record says: on its target,
   * what a delete or an update there does to the rows holding it, and on those rows
   * that what they name is there (an edge's ends are the engine's to check).
   */
  private events(
    holding: TableDef,
    fk: ForeignKeyDef,
    ownKey: readonly string[],
    theirs: readonly string[],
    context: DDLContext,
    edge = false
  ): string[] {
    const table = holding.name;
    const target = this.escapeIdentifier(fk.referencedTable);
    const self = this.escapeIdentifier(table);
    const heldRecord =
      fk.columns.length === 1 && theirs.join() === fk.referencedColumns.join();
    const position = (column: string) => ownKey.indexOf(column);
    const held = (column: string) => {
      const at = position(column);
      if (at < 0) return this.escapeIdentifier(column);
      return ownKey.length === 1 ? "record::id(id)" : `id[${at}]`;
    };
    const read = (row: "$before" | "$after", referenced: string) => {
      if (heldRecord && position(fk.columns[0]!) >= 0)
        return ownKey.length === 1 ? `record::id(${row}.id)` : `${row}.id`;
      const at = theirs.indexOf(referenced);
      if (at < 0) return `${row}.${this.escapeIdentifier(referenced)}`;
      return theirs.length === 1
        ? `record::id(${row}.id)`
        : `record::id(${row}.id)[${at}]`;
    };
    const matching = fk.columns
      .map(
        (column, index) =>
          `${held(column)} = ${read("$before", fk.referencedColumns[index]!)}`
      )
      .join(" AND ");
    const rejected = (verb: string) =>
      `IF array::len(SELECT VALUE id FROM ${self} WHERE ${matching} LIMIT 1) > 0 { THROW ${JSON.stringify(`ON ${verb} REJECT: ${fk.name}`)} }`;
    const unset = () => {
      const columns = fk.columns.filter((column) => position(column) < 0);
      if (columns.length === 0)
        refuse(`setNull on '${fk.name}', whose columns are all the row's key`);
      return `UPDATE ${self} SET ${columns.map((column) => `${this.escapeIdentifier(column)} = NONE`).join(", ")} WHERE ${matching}`;
    };
    const facts = JSON.stringify(
      JSON.stringify({ table, fk } satisfies EventFacts)
    );
    // A value no row holds is no reference, where `NONE` would match any unset one.
    const named = fk.referencedColumns.filter(
      (column) => !theirs.includes(column)
    );
    const present = named.map(
      (column) => `$before.${this.escapeIdentifier(column)} != NONE`
    );
    const when = (event: string, ...also: readonly string[]) =>
      [`$event = "${event}"`, ...also].join(" AND ");
    const onDelete =
      fk.onDelete === "cascade"
        ? `DELETE ${self} WHERE ${matching}`
        : fk.onDelete === "setNull"
          ? unset()
          : rejected("DELETE");
    const statements = [
      // A record moving to a new key answers for what holds it, and its old copy says so.
      `DEFINE FIELD IF NOT EXISTS ${MOVED_FIELD} ON ${target} TYPE option<bool>;`,
      `DEFINE EVENT ${this.escapeIdentifier(fk.name)} ON ${target} WHEN ${when("DELETE", ...present, `$before.${MOVED_FIELD} != true`)} THEN { ${onDelete} } COMMENT ${facts};`,
      ...(edge ? [] : [this.existence(holding, fk, ownKey, theirs, context)]),
    ];
    // A record's key never changes in place: a move answers for what holds it.
    if (named.length === 0) return statements;
    const changed = named
      .map(
        (column) =>
          `$before.${this.escapeIdentifier(column)} != $after.${this.escapeIdentifier(column)}`
      )
      .join(" OR ");
    // A column in the row's own key moves with the record, which the driver does.
    const followed = fk.columns.flatMap((column, index) =>
      position(column) < 0
        ? [
            `${this.escapeIdentifier(column)} = ${read("$after", fk.referencedColumns[index]!)}`,
          ]
        : []
    );
    const onUpdate =
      fk.onUpdate === "cascade"
        ? followed.length
          ? `UPDATE ${self} SET ${followed.join(", ")} WHERE ${matching}`
          : "RETURN NONE"
        : fk.onUpdate === "setNull"
          ? unset()
          : rejected("UPDATE");
    return [
      ...statements,
      `DEFINE EVENT ${this.escapeIdentifier(`${fk.name}_update`)} ON ${target} WHEN ${when("UPDATE", ...present, `(${changed})`)} THEN { ${onUpdate} };`,
    ];
  }

  private edgeTable(table: TableDef, concurrently = false): string[] {
    const [first, second] = table.foreignKeys;
    if (!(first && second)) refuse(`the junction '${table.name}'`);
    const name = this.escapeIdentifier(table.name);
    const ends = `IN ${this.escapeIdentifier(first.referencedTable)} OUT ${this.escapeIdentifier(second.referencedTable)}`;
    const comment = JSON.stringify(
      JSON.stringify({
        junction: { ...table, junction: undefined },
      } satisfies TableFacts)
    );
    // A singular relation needs a unique end, which an index holds. Any other
    // edge is its pair alone, with nothing an edge record would add.
    const singular = table.uniqueConstraints.flatMap((unique) => {
      const end = [first, second].findIndex(
        (key) => key.columns.join() === unique.columns.join()
      );
      return end < 0
        ? []
        : [
            this.index(
              table.name,
              unique.name,
              [end === 0 ? "in" : "out"],
              true,
              concurrently
            ),
          ];
    });
    // A record's edges go with it, before anything can object, so holding one back
    // is the engine's, which reads them before it deletes or rekeys it.
    return singular.length === 0
      ? [
          `DEFINE TABLE ${name} TYPE RELATION ${ends} LIGHTWEIGHT COMMENT ${comment};`,
        ]
      : [
          `DEFINE TABLE ${name} TYPE RELATION ${ends} ENFORCED SCHEMAFULL COMMENT ${comment};`,
          this.index(
            table.name,
            `${table.name}_pair`,
            ["in", "out"],
            true,
            concurrently
          ),
          ...singular,
        ];
  }

  /** A table the program creates holds no row yet: its indexes build in the background. */
  generateCreateTable(
    { table }: CreateTableOperation,
    context: DDLContext
  ): string[] {
    return this.createTable(table, context, true);
  }

  /** `empty`: no row can be in the table when its indexes are defined. */
  private createTable(
    table: TableDef,
    context: DDLContext,
    empty: boolean
  ): string[] {
    if (table.junction) return this.edgeTable(table, empty);
    const key = table.primaryKey?.columns ?? [];
    const name = this.escapeIdentifier(table.name);
    const columnOf = (column: string) =>
      table.columns.find((candidate) => candidate.name === column)!;
    const facts: TableFacts = {
      key: key.map((column) => ({
        name: column,
        type: columnOf(column).type,
      })),
    };
    // A forward reference waits for its table, but a key's type cannot wait for it.
    const lifted = (context.followingOperations ?? []).flatMap((operation) =>
      operation.type === "addForeignKey" && operation.tableName === table.name
        ? [operation.fk]
        : []
    );
    const parts = namedKeyParts(
      { ...table, foreignKeys: [...table.foreignKeys, ...lifted] },
      key,
      (fk) =>
        this.keyOf(fk.referencedTable, context, table).join() ===
        fk.referencedColumns.join()
    );
    const keyField =
      key.length === 1
        ? `DEFINE FIELD id ON ${name} TYPE ${wholeKeyKind(columnOf(key[0]!).type)};`
        : parts
          ? `DEFINE FIELD id ON ${name} TYPE [${parts.map(({ part, kind }) => `${part}: ${kind}`).join(", ")}];`
          : undefined;
    const fields = table.columns
      .filter((column) => !key.includes(column.name))
      .map((column) => {
        const fk = table.foreignKeys.find(
          (candidate) =>
            candidate.columns[0] === column.name &&
            this.holdsRecord(candidate, context, table, key)
        );
        return this.field(
          table.name,
          { ...column, name: partName(table, column.name) },
          fk
        );
      });
    return [
      `DEFINE TABLE ${name} SCHEMAFULL COMMENT ${JSON.stringify(JSON.stringify(facts))};`,
      ...(keyField ? [keyField] : []),
      ...table.columns
        .filter((column) => column.autoIncrement)
        .map(
          (column) =>
            // Only the table's own goes with it, so another may outlive a table.
            `DEFINE SEQUENCE ${key.length === 1 && key[0] === column.name ? "" : "OVERWRITE "}${this.escapeIdentifier(sequenceOf(table.name, key.includes(column.name) ? column.name : partName(table, column.name), key))} START 1;`
        ),
      ...fields,
      ...table.uniqueConstraints.map((unique) =>
        this.index(
          table.name,
          unique.name,
          unique.columns.map((column) => partName(table, column)),
          true,
          empty
        )
      ),
      ...table.indexes.flatMap((index) =>
        this.plainIndex(table, index, false, empty)
      ),
      ...table.foreignKeys.flatMap((fk) =>
        this.holdsRecord(fk, context, table, key)
          ? []
          : this.events(
              table,
              fk,
              key,
              this.keyOf(fk.referencedTable, context, table),
              context
            )
      ),
    ];
  }

  /** Its foreign keys have gone already: the differ drops them ahead of it. */
  generateDropTable(
    { tableName }: DropTableOperation,
    context: DDLContext
  ): string[] {
    const name = this.escapeIdentifier(tableName);
    // A lightweight relation goes only once its edges have gone.
    const edges = context.currentSchema?.tables.find(
      (table) => table.name === tableName
    )?.junction;
    return [
      ...(edges ? [`DELETE ${name};`] : []),
      `REMOVE TABLE ${name};`,
      `REMOVE SEQUENCE IF EXISTS ${this.escapeIdentifier(`${tableName}_seq`)};`,
    ];
  }

  /** What {@link events} defines, on the target and on `table`, which holds the key. */
  private removeEvents(fk: ForeignKeyDef, table: string): string[] {
    const target = this.escapeIdentifier(fk.referencedTable);
    return [
      `REMOVE EVENT IF EXISTS ${this.escapeIdentifier(fk.name)} ON ${target};`,
      `REMOVE EVENT IF EXISTS ${this.escapeIdentifier(`${fk.name}_update`)} ON ${target};`,
      `REMOVE EVENT IF EXISTS ${this.escapeIdentifier(`${fk.name}_exists`)} ON ${this.escapeIdentifier(table)};`,
    ];
  }

  /**
   * SurrealDB has no rename, and a record's table is part of its id: the rows are
   * copied under the new name, what points at them is pointed anew, and the old goes.
   */
  generateRenameTable(
    { from, to }: RenameTableOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(from, context);
    if (!table) refuse(`renaming the table '${from}', which is not there`);
    const key = table!.primaryKey?.columns ?? [];
    const retarget = (fk: ForeignKeyDef): ForeignKeyDef =>
      fk.referencedTable === from ? { ...fk, referencedTable: to } : fk;
    // A raw index the program drops, before or after, is not re-created here:
    // its declaration may be gone, and with it the text to render.
    const dropped = new Set(
      [
        ...(context.precedingOperations ?? []),
        ...(context.followingOperations ?? []),
      ].flatMap((operation) =>
        operation.type === "dropIndex" &&
        (operation.tableName === from || operation.tableName === to)
          ? [operation.indexName]
          : []
      )
    );
    const renamed: TableDef = {
      ...table!,
      name: to,
      foreignKeys: table!.foreignKeys.map(retarget),
      indexes: table!.indexes.filter(
        (index) => !(index.raw && dropped.has(index.name))
      ),
    };
    // The program as it stands once the new table is there.
    const arrived: DDLContext = {
      ...context,
      currentSchema: {
        ...context.currentSchema!,
        tables: [
          ...(context.currentSchema?.tables ?? []).filter(
            ({ name }) => name !== from
          ),
          renamed,
        ],
      },
    };
    const old = this.escapeIdentifier(from);
    const self = this.escapeIdentifier(to);
    const moved = (value: string) =>
      `(IF ${value} != NONE { type::record(${JSON.stringify(to)}, record::id(${value})) } ELSE { NONE })`;
    const rows: string[] = [];
    if (table!.junction) {
      rows.push(
        `FOR $edge IN (SELECT in, out FROM ${old}) { RELATE ($edge.in)->${self}->($edge.out); };`,
        `DELETE ${old};`
      );
    } else {
      const links = table!.foreignKeys.filter(
        (fk) =>
          fk.referencedTable === from &&
          this.holdsRecord(fk, context, table!, key)
      );
      const stated = [
        "*",
        `type::record(${JSON.stringify(to)}, record::id(id)) AS id`,
        ...links.map(
          (fk) =>
            `${moved(this.escapeIdentifier(fk.columns[0]!))} AS ${this.escapeIdentifier(fk.columns[0]!)}`
        ),
      ];
      rows.push(
        `INSERT INTO ${self} (SELECT ${stated.join(", ")} FROM ${old}) RETURN NONE;`
      );
    }
    // Numbers already taken stay taken.
    for (const column of table!.columns)
      if (column.autoIncrement) {
        const read = key.includes(column.name)
          ? key.length === 1
            ? "record::id(id)"
            : `id[${key.indexOf(column.name)}]`
          : this.escapeIdentifier(column.name);
        rows.push(
          `DEFINE SEQUENCE OVERWRITE ${this.escapeIdentifier(sequenceOf(to, column.name, key))} START ((math::max((SELECT VALUE ${read} FROM ${old})) ?? 0) + 1);`
        );
      }
    const others: string[] = [];
    for (const other of context.currentSchema?.tables ?? []) {
      if (other.name === from) continue;
      const pointing = other.foreignKeys.filter(
        (fk) => fk.referencedTable === from
      );
      if (pointing.length === 0) continue;
      const otherKey = other.primaryKey?.columns ?? [];
      const name = this.escapeIdentifier(other.name);
      if (other.junction) {
        others.push(
          [
            `LET $edges = (SELECT in, out FROM ${name});`,
            `DELETE ${name};`,
            `REMOVE TABLE ${name};`,
            ...this.edgeTable({
              ...other,
              foreignKeys: other.foreignKeys.map(retarget),
            }),
            `FOR $edge IN $edges { RELATE (IF record::tb($edge.in) = ${JSON.stringify(from)} { type::record(${JSON.stringify(to)}, record::id($edge.in)) } ELSE { $edge.in })->${name}->(IF record::tb($edge.out) = ${JSON.stringify(from)} { type::record(${JSON.stringify(to)}, record::id($edge.out)) } ELSE { $edge.out }); };`,
          ].join(" ")
        );
        continue;
      }
      for (const fk of pointing) {
        const target = retarget(fk);
        // The old table's events go before its rows do, which they would act on.
        if (!this.holdsRecord(fk, context, other, otherKey)) {
          others.push(
            ...this.removeEvents(fk, other.name),
            ...this.events(other, target, otherKey, key, arrived)
          );
          continue;
        }
        const column = other.columns.find(
          (candidate) => candidate.name === fk.columns[0]
        )!;
        const held = this.escapeIdentifier(column.name);
        others.push(
          ...this.schemaOpen(other.name, [
            this.field(other.name, column, target, false, true),
            `UPDATE ${name} SET ${held} = ${moved(held)} WHERE ${held} != NONE RETURN NONE;`,
          ])
        );
      }
    }
    // Its own events are defined anew for the new table, and the old ones, on
    // their targets or on itself, would act on the rows the move deletes.
    const released = table!.junction
      ? []
      : table!.foreignKeys.flatMap((fk) =>
          this.holdsRecord(fk, context, table!, key)
            ? []
            : this.removeEvents(fk, from)
        );
    return [
      ...released,
      // Its rows are copied in next: its indexes refuse a duplicate at once.
      ...this.createTable(renamed, arrived, false),
      ...rows,
      ...others,
      ...(table!.junction ? [] : [`DELETE ${old} RETURN NONE;`]),
      ...this.generateDropTable(
        { type: "dropTable", tableName: from },
        { ...context, currentSchema: undefined }
      ),
    ];
  }

  // ---------------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------------

  private liveTable(
    tableName: string,
    context: DDLContext
  ): TableDef | undefined {
    return context.currentSchema?.tables.find(({ name }) => name === tableName);
  }

  generateAddColumn(
    { tableName, column }: AddColumnOperation,
    context: DDLContext
  ): string[] {
    // Its foreign key may come next, and a populated table would refuse a field
    // narrowed afterwards: the field is born holding it.
    const follows = (context.followingOperations ?? []).find(
      (operation): operation is AddForeignKeyOperation =>
        operation.type === "addForeignKey" &&
        operation.tableName === tableName &&
        operation.fk.columns.length === 1 &&
        operation.fk.columns[0] === column.name &&
        this.keyOf(operation.fk.referencedTable, context).join() ===
          operation.fk.referencedColumns.join()
    );
    return [this.field(tableName, column, follows?.fk, true)];
  }

  generateDropColumn(
    { tableName, columnName }: DropColumnOperation,
    context?: DDLContext
  ): string[] {
    // An old key's part is a position in the id, which the new key has rewritten.
    if (
      context &&
      this.liveTable(tableName, context)?.primaryKey?.columns.includes(
        columnName
      )
    )
      return [];
    return [
      `REMOVE FIELD ${this.escapeIdentifier(columnName)} ON ${this.escapeIdentifier(tableName)};`,
    ];
  }

  /** What a rename leaves named after what it renamed, under the name it now derives. */
  protected override renameDerivedNames(
    owner: string,
    renames: ReadonlyMap<string, DerivedRename>,
    table: TableDef,
    context: DDLContext
  ): string[] {
    const self = this.escapeIdentifier(owner);
    const key = table.primaryKey?.columns ?? [];
    return [...renames].flatMap(([from, { to }]) => {
      const index = table.indexes.find(({ name }) => name === from);
      if (index)
        return [
          ...this.generateDropIndex({
            type: "dropIndex",
            tableName: owner,
            indexName: from,
          }),
          ...this.plainIndex(table, { ...index, name: to }, true),
        ];
      const unique = table.uniqueConstraints.find(({ name }) => name === from);
      if (unique)
        return [
          `REMOVE INDEX ${this.escapeIdentifier(from)} ON ${self};`,
          this.index(
            owner,
            to,
            unique.columns.map((column) => partName(table, column)),
            true
          ),
        ];
      const fk = table.foreignKeys.find(({ name }) => name === from);
      if (!fk) return [];
      if (!this.holdsRecord(fk, context, table, key))
        return [
          ...this.removeEvents(fk, owner),
          ...this.events(
            { ...table, name: owner },
            { ...fk, name: to },
            key,
            this.keyOf(fk.referencedTable, context, table),
            context
          ),
        ];
      const column = table.columns.find(({ name }) => name === fk.columns[0])!;
      return [this.field(owner, column, { ...fk, name: to }, false, true)];
    });
  }

  /** SurrealDB has no rename: the value moves to a new field, and all naming it follows. */
  generateRenameColumn(
    { tableName, from, to }: RenameColumnOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(tableName, context);
    if (!table)
      refuse(`renaming a field of '${tableName}', which is not there`);
    const key = table!.primaryKey?.columns ?? [];
    const swap = (columns: readonly string[]) =>
      columns.map((column) => (column === from ? to : column));
    const self = this.escapeIdentifier(tableName);
    const renamed: TableDef = {
      ...table!,
      columns: table!.columns.map((column) =>
        column.name === from ? { ...column, name: to } : column
      ),
      primaryKey: table!.primaryKey && {
        ...table!.primaryKey,
        columns: swap(table!.primaryKey.columns),
      },
    };
    const statements: string[] = [];
    if (key.includes(from)) {
      // A key's part is a position in its id: only what names it changes.
      const facts: TableFacts = {
        key: renamed.primaryKey!.columns.map((column) => ({
          name: column,
          type: renamed.columns.find(({ name }) => name === column)!.type,
        })),
      };
      statements.push(
        `ALTER TABLE ${self} COMMENT ${JSON.stringify(JSON.stringify(facts))};`
      );
      const parts = namedKeyParts(renamed, renamed.primaryKey!.columns, (fk) =>
        fk.referencedTable === tableName
          ? false
          : this.keyOf(fk.referencedTable, context, table).join() ===
            fk.referencedColumns.join()
      );
      if (parts)
        statements.push(
          `DEFINE FIELD OVERWRITE id ON ${self} TYPE [${parts.map(({ part, kind }) => `${part}: ${kind}`).join(", ")}];`
        );
    } else {
      const column = table!.columns.find(({ name }) => name === from);
      if (!column) refuse(`renaming the unknown field '${tableName}.${from}'`);
      const fk = table!.foreignKeys.find(
        (candidate) =>
          candidate.columns[0] === from &&
          this.holdsRecord(candidate, context, table!, key)
      );
      statements.push(
        `ALTER TABLE ${self} SCHEMALESS;`,
        this.field(
          tableName,
          { ...column!, name: to },
          fk && { ...fk, columns: swap(fk.columns) }
        ),
        `UPDATE ${self} SET ${this.escapeIdentifier(to)} = ${this.escapeIdentifier(from)} RETURN NONE;`
      );
    }
    // A raw index naming it is re-created too, as the program has it at this
    // point, its marker naming the new column; one it drops anyway is left.
    const reindexed = [
      ...table!.indexes
        .filter((index) => !index.raw && index.columns.includes(from))
        .map((index) => ({ ...index, columns: swap(index.columns) })),
      ...this.rawIndexesRenamedBy(
        { type: "renameColumn", tableName, from, to },
        context
      ),
    ];
    for (const index of reindexed)
      statements.push(
        ...this.generateDropIndex({
          type: "dropIndex",
          tableName,
          indexName: index.name,
        }),
        ...this.plainIndex(renamed, index, true)
      );
    for (const unique of table!.uniqueConstraints)
      if (unique.columns.includes(from))
        statements.push(
          `REMOVE INDEX ${this.escapeIdentifier(unique.name)} ON ${self};`,
          this.index(
            tableName,
            unique.name,
            swap(unique.columns).map((column) => partName(renamed, column)),
            true
          )
        );
    // The table as its events read it once the field has moved.
    const projected: TableDef = {
      ...renamed,
      foreignKeys: renamed.foreignKeys.map((fk) => ({
        ...fk,
        columns: swap(fk.columns),
      })),
    };
    const renamedContext: DDLContext = {
      ...context,
      currentSchema: context.currentSchema && {
        ...context.currentSchema,
        tables: context.currentSchema.tables.map((other) =>
          other.name === tableName ? projected : other
        ),
      },
    };
    for (const fk of table!.foreignKeys)
      if (
        fk.columns.includes(from) &&
        !this.holdsRecord(fk, context, table!, key)
      )
        statements.push(
          ...this.removeEvents(fk, tableName),
          ...this.events(
            projected,
            { ...fk, columns: swap(fk.columns) },
            renamed.primaryKey?.columns ?? [],
            this.keyOf(fk.referencedTable, context, table),
            renamedContext
          )
        );
    for (const other of context.currentSchema?.tables ?? [])
      for (const fk of other.foreignKeys)
        if (
          fk.referencedTable === tableName &&
          fk.referencedColumns.includes(from) &&
          !other.junction
        )
          statements.push(
            ...this.removeEvents(fk, other.name),
            ...this.events(
              other,
              { ...fk, referencedColumns: swap(fk.referencedColumns) },
              other.primaryKey?.columns ?? [],
              renamed.primaryKey?.columns ?? [],
              renamedContext
            )
          );
    if (!key.includes(from))
      statements.push(
        ...this.generateDropColumn({
          type: "dropColumn",
          tableName,
          columnName: from,
        }),
        `UPDATE ${self} SET ${this.escapeIdentifier(from)} = NONE RETURN NONE;`,
        `ALTER TABLE ${self} SCHEMAFULL;`
      );
    return statements;
  }

  /** The server refuses what its rows might not satisfy, in its own words. */
  generateAlterColumn(
    { tableName, columnName, to }: AlterColumnOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(tableName, context);
    const fk = table?.foreignKeys.find(
      (candidate) =>
        candidate.columns[0] === columnName &&
        this.holdsRecord(
          candidate,
          context,
          table,
          table.primaryKey?.columns ?? []
        )
    );
    return [this.field(tableName, to, fk, false, true)];
  }

  // ---------------------------------------------------------------------------
  // Indexes and uniques
  // ---------------------------------------------------------------------------

  generateCreateIndex(
    { tableName, index }: CreateIndexOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(tableName, context) ?? {
      name: tableName,
      columns: [],
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    };
    return this.plainIndex(
      table,
      index,
      this.liveTable(tableName, context) !== undefined
    );
  }

  generateDropIndex(
    { tableName, indexName, raw }: DropIndexOperation,
    context?: DDLContext
  ): string[] {
    // A table rename re-creates the table without the raw indexes the program
    // drops (generateRenameTable): there is nothing left to remove.
    if (
      raw &&
      context?.precedingOperations?.some(
        (operation) =>
          operation.type === "renameTable" && operation.to === tableName
      )
    )
      return [];
    return [
      `REMOVE INDEX ${this.escapeIdentifier(indexName)} ON ${this.escapeIdentifier(tableName)};`,
      `REMOVE FIELD IF EXISTS ${this.escapeIdentifier(partialField(indexName))} ON ${this.escapeIdentifier(tableName)};`,
    ];
  }

  generateAddUniqueConstraint(
    { tableName, constraint }: AddUniqueConstraintOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(tableName, context);
    return [
      this.index(
        tableName,
        constraint.name,
        constraint.columns.map((column) =>
          table ? partName(table, column) : column
        ),
        true
      ),
    ];
  }

  generateDropUniqueConstraint({
    tableName,
    constraintName,
  }: DropUniqueConstraintOperation): string[] {
    return [
      `REMOVE INDEX ${this.escapeIdentifier(constraintName)} ON ${this.escapeIdentifier(tableName)};`,
    ];
  }

  // ---------------------------------------------------------------------------
  // Foreign keys
  // ---------------------------------------------------------------------------

  private tableAt(tableName: string, context: DDLContext): TableDef {
    for (const operation of context.precedingOperations ?? [])
      if (
        operation.type === "createTable" &&
        operation.table.name === tableName
      )
        return operation.table;
    return (
      this.liveTable(tableName, context) ??
      refuse(`a foreign key on '${tableName}', which is not there`)
    );
  }

  generateAddForeignKey(
    { tableName, fk }: AddForeignKeyOperation,
    context: DDLContext
  ): string[] {
    const table = this.tableAt(tableName, context);
    const key = table.primaryKey?.columns ?? [];
    if (table.junction)
      return this.events(
        table,
        fk,
        key,
        this.keyOf(fk.referencedTable, context, table),
        context,
        true
      ).filter((statement) => !statement.startsWith("DEFINE FIELD"));
    if (!this.holdsRecord(fk, context, table, key))
      return this.events(
        // Its columns may have come in this program.
        {
          ...table,
          columns: [
            ...table.columns,
            ...(context.precedingOperations ?? []).flatMap((operation) =>
              operation.type === "addColumn" &&
              operation.tableName === tableName
                ? [operation.column]
                : []
            ),
          ],
        },
        fk,
        key,
        this.keyOf(fk.referencedTable, context, table),
        context
      );
    const added = (context.precedingOperations ?? []).some(
      (operation) =>
        operation.type === "addColumn" &&
        operation.tableName === tableName &&
        operation.column.name === fk.columns[0]
    );
    if (added) return [];
    const column = table.columns.find(({ name }) => name === fk.columns[0]);
    if (!column) refuse(`the foreign key '${fk.name}' over an unknown field`);
    return [this.field(tableName, column, fk, false, true)];
  }

  generateDropForeignKey(
    { tableName, fkName }: DropForeignKeyOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(tableName, context);
    const fk = table?.foreignKeys.find(({ name }) => name === fkName);
    // A reset names keys it read from no schema of ours: it removes their tables,
    // and their fields and events go with those.
    if (!(table && fk)) return ["RETURN NONE"];
    const key = table.primaryKey?.columns ?? [];
    if (!this.holdsRecord(fk, context, table, key))
      return this.removeEvents(fk, tableName);
    // Going with its column, it has nothing left to say.
    const removed = (context.followingOperations ?? []).some(
      (operation) =>
        operation.type === "dropColumn" &&
        operation.tableName === tableName &&
        operation.columnName === fk.columns[0]
    );
    if (removed) return [];
    const column = table.columns.find(({ name }) => name === fk.columns[0])!;
    return [this.field(tableName, column, undefined, false, true)];
  }

  // ---------------------------------------------------------------------------
  // What has no equivalent
  // ---------------------------------------------------------------------------

  /**
   * A record's key is its id: a new one rewrites each row under it, the old key's
   * value staying as a field where the model keeps it. What holds a record by the old
   * key must have gone first, as SQL's would.
   */
  generateAddPrimaryKey(
    { tableName, primaryKey }: AddPrimaryKeyOperation,
    context: DDLContext
  ): string[] {
    const table = this.liveTable(tableName, context);
    if (!table) refuse(`a new key on '${tableName}', which is not there`);
    const old = table!.primaryKey?.columns ?? [];
    const key = primaryKey.columns;
    const keyed: TableDef = { ...table!, primaryKey };
    const dropped = new Set(
      (context.precedingOperations ?? []).flatMap((operation) =>
        operation.type === "dropForeignKey" ? [operation.fkName] : []
      )
    );
    for (const other of context.currentSchema?.tables ?? [])
      for (const fk of other.foreignKeys)
        if (fk.referencedTable === tableName && !dropped.has(fk.name))
          refuse(
            `a new key on '${tableName}', which '${other.name}' still references`
          );
    const self = this.escapeIdentifier(tableName);
    // A part of the key it had is in its id; any other, in its field.
    const part = (column: string) => {
      const at = old.indexOf(column);
      if (at < 0)
        return `$row.${this.escapeIdentifier(partName(table!, column))}`;
      return old.length === 1 ? "record::id($row.id)" : `$row.id[${at}]`;
    };
    const operations = [
      ...(context.precedingOperations ?? []),
      ...(context.followingOperations ?? []),
    ];
    const kept = table!.columns.filter(
      (column) =>
        old.includes(column.name) &&
        !key.includes(column.name) &&
        !operations.some(
          (operation) =>
            operation.type === "dropColumn" &&
            operation.tableName === tableName &&
            operation.columnName === column.name
        )
    );
    const columnOf = (name: string) =>
      table!.columns.find((column) => column.name === name) ??
      operations.flatMap((operation) =>
        operation.type === "addColumn" &&
        operation.tableName === tableName &&
        operation.column.name === name
          ? [operation.column]
          : []
      )[0];
    // An array id keeps a part's value as stored, which its named part must
    // match: an `i32` is an `int` there.
    const member = (column: string) => {
      const { type } = columnOf(column)!;
      return keyKind(type) === type
        ? part(column)
        : `<${keyKind(type)}>${part(column)}`;
    };
    const record = `type::record(${JSON.stringify(tableName)}, ${key.length === 1 ? part(key[0]!) : `[${key.map(member).join(", ")}]`})`;
    const keptValues = kept.map(
      (column) =>
        `${this.escapeIdentifier(partName(keyed, column.name))}: ${part(column.name)}`
    );
    const newFields = key
      .filter((column) => !old.includes(column))
      .map((column) => partName(table!, column));
    const without = [...newFields, ...old].map((column) =>
      JSON.stringify(column)
    );
    const facts: TableFacts = {
      key: key.map((column) => ({
        name: column,
        type: columnOf(column)!.type,
      })),
    };
    // A compound key's parts are named in its id, where an index reads them.
    const parts = namedKeyParts(
      keyed,
      key,
      (fk) =>
        this.keyOf(fk.referencedTable, context, keyed).join() ===
        fk.referencedColumns.join()
    );
    // An index or a unique naming either key reads a field that changes place,
    // and SurrealDB names no part of an id an index reads as a stored field: each
    // goes ahead of the move and comes back after it. A raw index's text cannot
    // follow a field into the id.
    const moving = (columns: readonly string[]) =>
      columns.some((column) => old.includes(column) || key.includes(column));
    const goes = (type: "dropIndex" | "dropUniqueConstraint", name: string) =>
      operations.some(
        (operation) =>
          operation.type === type &&
          operation.tableName === tableName &&
          (operation.type === "dropIndex"
            ? operation.indexName
            : operation.constraintName) === name
      );
    // A partial index's predicate may read a key's value where it now stands.
    const indexes = table!.indexes.filter(
      (index) =>
        (moving(index.columns) ||
          (index.where !== undefined &&
            this.partialCondition(table!, index) !==
              this.partialCondition(keyed, index))) &&
        !goes("dropIndex", index.name)
    );
    for (const index of indexes)
      if (index.raw && index.columns.some((column) => key.includes(column)))
        refuse(
          `a new key on '${tableName}' holding a field the raw index '${index.name}' names`
        );
    const uniques = table!.uniqueConstraints.filter(
      ({ name, columns }) =>
        moving(columns) && !goes("dropUniqueConstraint", name)
    );
    return [
      `ALTER TABLE ${self} COMMENT ${JSON.stringify(JSON.stringify(facts))};`,
      `ALTER TABLE ${self} SCHEMALESS;`,
      ...[...indexes, ...uniques].map(
        ({ name }) => `REMOVE INDEX ${this.escapeIdentifier(name)} ON ${self};`
      ),
      [
        `LET $rows = (SELECT * FROM ${self});`,
        `REMOVE FIELD IF EXISTS id ON ${self};`,
        ...newFields.map(
          (column) =>
            `REMOVE FIELD IF EXISTS ${this.escapeIdentifier(column)} ON ${self};`
        ),
        ...kept.map((column) =>
          this.field(
            tableName,
            {
              ...column,
              name: partName(keyed, column.name),
            },
            undefined
          )
        ),
        `FOR $row IN $rows { DELETE $row.id; INSERT INTO ${self} [object::extend(object::remove($row, [${without.join(", ")}]), { id: ${record}${keptValues.length ? `, ${keptValues.join(", ")}` : ""} })] RETURN NONE; };`,
      ].join(" "),
      ...(key.length === 1
        ? [
            `DEFINE FIELD id ON ${self} TYPE ${wholeKeyKind(columnOf(key[0]!)!.type)};`,
          ]
        : parts
          ? [
              `DEFINE FIELD id ON ${self} TYPE [${parts.map(({ part, kind }) => `${part}: ${kind}`).join(", ")}];`,
            ]
          : []),
      ...indexes.flatMap((index) => this.plainIndex(keyed, index, true)),
      ...uniques.map((unique) =>
        this.index(
          tableName,
          unique.name,
          unique.columns.map((column) => partName(keyed, column)),
          true
        )
      ),
      `ALTER TABLE ${self} SCHEMAFULL;`,
    ];
  }

  /** A record always has an id: this only ever stands ahead of a new key. */
  generateDropPrimaryKey(
    { tableName }: DropPrimaryKeyOperation,
    context: DDLContext
  ): string[] {
    const replaced = (context.followingOperations ?? []).some(
      (operation) =>
        operation.type === "addPrimaryKey" && operation.tableName === tableName
    );
    if (!replaced)
      refuse(`leaving '${tableName}' without a key: a record's key is its id`);
    return [];
  }

  generateCreateEnum(): string[] {
    return refuse("a native enum");
  }

  generateDropEnum(): string[] {
    return refuse("a native enum");
  }

  generateAlterEnum(): string[] {
    return refuse("a native enum");
  }

  generateAcquireLock(): string | null {
    return null;
  }

  generateReleaseLock(): string | null {
    return null;
  }

  generateInventoryTables(): { sql: string; params: unknown[] } {
    return {
      sql: `RETURN (INFO FOR DB STRUCTURE).tables.filter(|$t| $t.name != "${LOCK_TABLE}").map(|$t| { name: $t.name })`,
      params: [],
    };
  }

  generateInventoryEnums(): null {
    return null;
  }

  override async tableHoldsRows(
    producer: AnyDriver,
    table: string
  ): Promise<boolean> {
    const populated = await producer._executeRaw(
      `SELECT 1 AS present FROM ${this.escapeIdentifier(table)} LIMIT 1`
    );
    return populated.rows.length > 0;
  }

  override async undeclaredValue(
    producer: AnyDriver,
    table: string,
    columnName: string,
    declared: readonly string[]
  ): Promise<{ readonly stored: unknown } | undefined> {
    const column = this.escapeIdentifier(columnName);
    const [found] = (
      await producer._executeRaw<{ stored: unknown }>(
        `SELECT ${column} AS stored FROM ${this.escapeIdentifier(table)} WHERE ${column} NOT IN $p1 LIMIT 1`,
        [declared]
      )
    ).rows;
    return found;
  }

  override generateDropEnumSQL(): null {
    // An enum here is its field's assertion, which goes with the field.
    return null;
  }

  override generateDropTableSQL(tableName: string): string {
    return `REMOVE TABLE IF EXISTS ${this.escapeIdentifier(tableName)}; REMOVE SEQUENCE IF EXISTS ${this.escapeIdentifier(`${tableName}_seq`)}`;
  }

  // ---------------------------------------------------------------------------
  // The command's lock and identity
  // ---------------------------------------------------------------------------

  override async pushTarget(
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ) {
    const { rows } = await executeRaw<{ database: string }>(
      "RETURN [{ database: session::db() }]"
    );
    return { dialect: "surrealql" as const, database: rows[0]!.database };
  }

  /**
   * Waits, the lock still held, until every index of the managed tables is
   * `ready` once a program building one in the background has committed: until
   * then a unique one lets a duplicate in, which leaves it failed and its table
   * refusing every write. A failed build, or one still going past
   * {@link INDEX_BUILD_WAIT_MS}, is refused by name; what the program did stays
   * committed.
   */
  override async awaitIndexBuilds(
    producer: AnyDriver,
    statements: readonly string[]
  ): Promise<void> {
    // Said in a string or a comment, it only costs one read.
    if (!statements.some((sql) => CONCURRENTLY.test(sql))) return;
    const tables = this.target?.tables;
    const deadline = Date.now() + INDEX_BUILD_WAIT_MS;
    for (let pause = INDEX_BUILD_FIRST_PAUSE_MS; ; ) {
      const { rows } = await producer._executeRaw<IndexInfo>(
        `RETURN (INFO FOR DB STRUCTURE).tables${tables ? ".filter(|$t| $t.name IN $p1)" : ""}.map(|$t| (INFO FOR TABLE $t.name STRUCTURE).indexes.map(|$i| $i + (INFO FOR INDEX $i.name ON $t.name).building)).flatten().filter(|$i| $i.status != "ready")`,
        [tables]
      );
      const [first] = rows;
      if (!first) return;
      const failed = rows.find(({ status }) => status === "error");
      if (failed || Date.now() >= deadline)
        throw unbuilt(
          failed ?? first,
          `${failed ? `failed to build: ${failed.error}` : "is not ready"} (the migration committed)`
        );
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, INDEX_BUILD_LAST_PAUSE_MS);
    }
  }

  /**
   * No session holds anything here, so a record holds the lock. It carries a lease
   * because a command that dies cannot let go of it: a later one takes it over.
   */
  override async holdLock<T>(
    driver: AnyDriver,
    lockWait: number,
    run: () => Promise<T>
  ): Promise<T> {
    const token = crypto.randomUUID();
    const deadline = Date.now() + lockWait;
    for (;;) {
      if (await tryLock(driver, token)) break;
      if (Date.now() >= deadline)
        throw new MigrationError(
          `Another migration command holds the lock on this database. It expires ${LOCK_LEASE} after that command began, if it died.`,
          VibORMErrorCode.MIGRATION_LOCK_FAILED
        );
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_RETRY_MS * (0.5 + Math.random()))
      );
    }
    try {
      return await run();
    } finally {
      await driver._executeRaw(
        `DELETE ${LOCK_RECORD} WHERE token = $p1 RETURN BEFORE`,
        [token]
      );
    }
  }
}

/** V11023: an index whose build failed, or has not finished. */
function unbuilt({ table, name }: IndexInfo, reason: string): MigrationError {
  return new MigrationError(
    `SurrealDB index "${table}.${name}" ${reason}.`,
    VibORMErrorCode.MIGRATION_INVALID_INDEX,
    { meta: { table, indexName: name } }
  );
}

/** One try: a conflict at commit is another command taking it. */
async function tryLock(driver: AnyDriver, token: string): Promise<boolean> {
  try {
    const { rows } = await driver._executeRaw<{ acquired: boolean }>(
      `RETURN { DEFINE TABLE IF NOT EXISTS ${LOCK_TABLE} SCHEMALESS; LET $at = (SELECT VALUE at FROM ${LOCK_RECORD})[0]; IF $at = NONE OR $at < time::now() - ${LOCK_LEASE} { UPSERT ${LOCK_RECORD} SET at = time::now(), token = $p1 RETURN NONE; [{ acquired: true }] } ELSE { [{ acquired: false }] } }`,
      [token]
    );
    return rows[0]?.acquired === true;
  } catch (error) {
    if (
      (error as { code?: string }).code === VibORMErrorCode.TRANSACTION_FAILED
    )
      return false;
    throw error;
  }
}

/** What a key part may be declared as: an `int`, whatever its column's width. */
function keyKind(type: string): string {
  return type === "i32" ? "int" : type;
}

/** A condition without the parentheses that only wrap the whole of it. */
function outerParenthesesGone(condition: string): string {
  let text = condition;
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let closesEarly = false;
    for (let at = 0; at < text.length - 1; at++) {
      if (text[at] === "(") depth += 1;
      else if (text[at] === ")") depth -= 1;
      if (depth === 0) closesEarly = true;
    }
    if (closesEarly) break;
    text = text.slice(1, -1);
  }
  return text;
}

/** The sequence of a generated column: a record's whole key keeps the table's own. */
function sequenceOf(
  table: string,
  column: string,
  key: readonly string[]
): string {
  return key.length === 1 && key[0] === column
    ? `${table}_seq`
    : `${table}_${column}_seq`;
}

/** A record's key cannot be an instant or a decimal, so a key that is one is its text. */
function wholeKeyKind(type: string): string {
  return type === "datetime" || type === "decimal" ? "string" : keyKind(type);
}

/** The names of a compound key's parts, or undefined where one cannot be named. */
function namedKeyParts(
  table: TableDef,
  key: readonly string[],
  namesItsKey: (fk: ForeignKeyDef) => boolean
): readonly { readonly part: string; readonly kind: string }[] | undefined {
  if (key.length < 2) return undefined;
  const parts = key.map((name) => {
    const column = table.columns.find((candidate) => candidate.name === name)!;
    const held = table.foreignKeys.some(
      (fk) =>
        fk.columns.length === 1 && fk.columns[0] === name && namesItsKey(fk)
    );
    return {
      // The name is the schema's: the driver reads a part by its position.
      part: name === "id" ? "id_part" : name,
      kind: held ? "record" : keyKind(column.type),
    };
  });
  return parts.every(
    ({ kind }) => kind === "record" || KEY_PART_KINDS.has(kind)
  )
    ? parts
    : undefined;
}

/** A column as an index names it: a key part goes by its part's name. */
function partName(table: TableDef, column: string): string {
  const key = table.primaryKey?.columns ?? [];
  if (key.length === 1 && key[0] === column) return "id";
  if (column !== "id") return column;
  return key.includes(column) ? "id_part" : ID_FIELD;
}

function tableFrom(
  name: string,
  info: TableInfo,
  facts: TableFacts,
  sequences: ReadonlySet<string>,
  managed: boolean
): TableDef {
  const fieldFacts = <T>(field: FieldInfo) =>
    parsed<T>(field.comment, managed, `field "${name}.${field.name}"`);
  const key = facts.key ?? [];
  // A reserved word comes back as it must be written.
  const fields = info.fields
    .map((field) => ({ ...field, name: field.name.replaceAll("`", "") }))
    .filter(
      (field) =>
        !(
          field.name === "id" ||
          field.name === MOVED_FIELD ||
          field.name.includes(".") ||
          fieldFacts<{ partial?: boolean }>(field).partial
        )
    );
  const columns: ColumnDef[] = [
    ...key.map(({ name: column, type }) => ({
      name: column,
      type,
      nullable: false,
      autoIncrement: sequences.has(
        sequenceOf(
          name,
          column,
          key.map((part) => part.name)
        )
      )
        ? true
        : undefined,
    })),
    ...fields
      .filter((field) => !key.some((part) => part.name === field.name))
      .map((field) => {
        const facts = fieldFacts<FieldFacts>(field);
        const nullable = field.kind.startsWith("none | ");
        const kind = nullable ? field.kind.slice("none | ".length) : field.kind;
        return {
          name: field.name === ID_FIELD ? "id" : field.name,
          type: facts.type ?? kind,
          nullable: nullable || (kind === "any" && !facts.required),
          default: facts.default,
          decimal: facts.decimal,
          autoIncrement: sequences.has(
            sequenceOf(
              name,
              field.name,
              key.map((part) => part.name)
            )
          )
            ? true
            : undefined,
        };
      }),
  ];
  const foreignKeys: ForeignKeyDef[] = fields.flatMap((field) => {
    const { fk } = fieldFacts<FieldFacts>(field);
    if (!(fk && field.reference)) return [];
    const target = RECORD_TARGET.exec(field.kind)?.[1] ?? "";
    return [
      {
        ...fk,
        columns: [field.name],
        referencedTable: target.replaceAll("`", ""),
        referencedColumns: [],
      },
    ];
  });
  const primaryKey: PrimaryKeyDef | undefined =
    key.length > 0 ? { columns: key.map((part) => part.name) } : undefined;
  const partsBack = (columns: readonly string[]) =>
    columns.map((column) => {
      if (column === "id" && key.length === 1) return key[0]!.name;
      return column === "id_part" || column === ID_FIELD
        ? "id"
        : column.replaceAll("`", "");
    });
  const uniqueConstraints: UniqueConstraintDef[] = [];
  const indexes: IndexDef[] = [];
  for (const index of info.indexes) {
    // A raw index is its marker, whatever kind of index it is.
    const raw =
      index.comment === undefined
        ? undefined
        : readRawIndexMarker(index.comment, index.name);
    if (raw) {
      indexes.push(raw);
      continue;
    }
    // Any other index VibORM did not define (an HNSW, a full-text search, a
    // comment of someone else's) cannot be read back into the schema, and
    // replacing it would lose it: refused in a managed table, before effects.
    const comment = commentJson(index.comment);
    if (!(OWN_INDEX_KINDS.has(index.index) && ownIndexFacts(comment))) {
      if (!managed) continue;
      throw new MigrationError(
        `SurrealDB index "${name}.${index.name}" is not one this index declaration can represent. Synchronization refuses before effects and preserves it. Declare it with .rawIndex() (drop this hand-made copy first: only an index VibORM created carries the marker it recognizes), or manage its table outside this synchronization scope.`,
        VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        { meta: { table: name, indexName: index.name } }
      );
    }
    const partial = comment as Partial<PartialFacts> & {
      type?: IndexDef["type"];
    };
    if (partial.type) {
      indexes.push({
        name: index.name,
        columns: partsBack(index.cols),
        unique: index.index === "UNIQUE",
        type: partial.type,
      });
      continue;
    }
    if (partial.where) {
      indexes.push({
        name: index.name,
        columns: [...partial.columns!],
        unique: index.index === "UNIQUE",
        where: partial.where,
      });
      continue;
    }
    const columns = partsBack(index.cols);
    // The differ reads a unique index and a unique constraint as one.
    if (index.index === "UNIQUE")
      uniqueConstraints.push({ name: index.name, columns });
    else indexes.push({ name: index.name, columns, unique: false });
  }
  return { name, columns, primaryKey, indexes, foreignKeys, uniqueConstraints };
}

export const surrealMigrationDriver = new SurrealMigrationDriver();
