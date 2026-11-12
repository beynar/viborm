import type { Dialect } from "@drivers/types";
import type { Sql } from "@sql";
import type { Queries } from "./query";
import type { Input } from "./schema";

/**
 * One model's names and values as its client's statements spell them: what a
 * fragment written by hand (a computed value, a filter's expression, a joined
 * source) names tables and columns and binds values with, so it reads what a
 * query of the client would.
 */
export interface ModelSql {
  readonly dialect: Dialect;
  /** The model's table, in its namespace, under `alias` where given. */
  table(alias?: string): Sql;
  /** A field's column, qualified by `alias` where given. */
  column(field: string, alias?: string): Sql;
  /** `value` bound as a value of `field` is written and compared. */
  value(field: string, value: unknown): Sql;
  /** An identifier quoted for the dialect: `name("r", "k")` is `"r"."k"`. */
  name(...path: string[]): Sql;
  /**
   * A condition over the model's rows read under `alias`: those the call
   * holding the fragment may see; with `update`, those it may update by
   * writing these fields; with `where`, of those the ones it matches. Only a
   * fragment handed to a model operation holds one: that operation settles
   * it.
   */
  visible(
    alias: string,
    options?: { readonly update?: readonly string[]; readonly where?: object }
  ): Sql;
}

/** What a computed value is given to compute its values with. */
export interface InsertValueContext {
  /** The model written, by its name in the schema. */
  readonly model: string;
  /** The INSERT's rows, every value final but the computed ones. */
  readonly rows: readonly Input[];
  /** The field the value is written to. */
  readonly field: string;
  readonly sql: ModelSql;
  readonly dialect: ModelSql["dialect"];
  /**
   * Run one read in the operation (its transaction, if any) and return its
   * raw rows; absent where the operation cannot read before writing (an
   * array transaction's batch), so the value must be an SQL expression.
   */
  readonly read?: (statement: Sql) => Promise<readonly Input[]>;
}

/**
 * A create value its extension computes once the rows of one INSERT are
 * final, after every incoming foreign key is assigned: a stamp of the `data`
 * capability that is an instance of this class is written where the caller
 * left the field out, not admitted as data. `compute` answers one value per
 * row it is asked about (the indexes of `rows` whose field holds this
 * instance), each a plain value or an SQL expression the INSERT evaluates.
 * An `update`'s data may hold one too: set aside from admission, its
 * expression is the SET's.
 */
export abstract class InsertValue {
  abstract compute(
    context: InsertValueContext,
    indexes: readonly number[]
  ): readonly unknown[] | Promise<readonly unknown[]>;
}

/**
 * An update value keeping the field as stored: set aside at admission as any
 * `InsertValue`, so no generated update value (`updatedAt()`) fills it,
 * then dropped from the data (an update left with nothing to write is one
 * that writes nothing), and not judged as a field the write writes. A write
 * that places a row without changing it keeps the row's instant so.
 */
export class Stored extends InsertValue {
  compute(): never {
    throw new Error("Stored is no value: the update leaves its field out");
  }
}

/**
 * An `updateMany` value read from a derived table the UPDATE joins: `join`
 * answers that table, aliased, and the condition matching it to the row written, over the
 * target's columns qualified by `target`; `compute` answers the SET
 * expression over the table's columns. The engine joins it (`UPDATE … FROM`,
 * MySQL's `UPDATE … JOIN`), so one statement writes each row its own value
 * and the source is read once, before any row changes.
 */
export abstract class JoinedValue extends InsertValue {
  abstract join(
    sql: ModelSql,
    target: string
  ): { readonly source: Sql; readonly on: Sql };
  /**
   * The same values as a list, for a database that joins no derived table:
   * each entry names one row by the values its fields hold and gives the
   * value it takes. The row is written only while it holds them. `read` asks
   * the database in the call's unit.
   */
  abstract rows(
    sql: ModelSql,
    read: (statement: Sql) => Promise<readonly Input[]>
  ): Promise<readonly JoinedEntry[]>;
}

/** One row a joined value is written to, as a list names it. */
export interface JoinedEntry {
  readonly where: Input;
  readonly value: unknown;
}

/**
 * Each engine's renderer, by its schema then its driver's adapter: what
 * spells a model for a fragment written by hand (`$sql`) names tables and
 * columns and binds values as the engine's queries do.
 */
export const renderers = new WeakMap<object, WeakMap<object, Queries>>();
