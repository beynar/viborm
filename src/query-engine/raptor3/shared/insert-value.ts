import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import type { Queries } from "./query";
import type { Input } from "./schema";

/** What an {@link InsertValue} is given to compute its values with. */
export interface InsertValueContext {
  readonly model: AnyModel;
  /** The INSERT's rows, every value final but the computed ones. */
  readonly rows: readonly Input[];
  /** The field the value is written to. */
  readonly field: string;
  readonly queries: Queries;
  readonly dialect: "postgresql" | "mysql" | "sqlite" | "mssql";
  /**
   * Run one read in the operation (its transaction, if any) and return its
   * raw rows; absent where the operation cannot read before writing (an
   * array transaction's batch), so the value must be an SQL expression.
   */
  readonly read?: (statement: Sql) => Promise<readonly Input[]>;
  /**
   * The largest key among the rows holding `list`, where a backend reads it for
   * the value rather than the value spelling the read.
   */
  readonly lastKey?: (list: Input, key: string) => Promise<string | null>;
}

/**
 * A create value its extension computes once the rows of one INSERT are
 * final, after every incoming foreign key is assigned: a stamp of the `data`
 * capability that is an instance of this class is written where the caller
 * left the field out, not admitted as data. `compute` answers one value per
 * row it is asked about (the indexes of `rows` whose field holds this
 * instance), each a plain value or an SQL expression the INSERT evaluates.
 * An `update`'s data may hold one too (an official extension's call, never a
 * caller's payload): set aside from admission, its expression is the SET's.
 * The official ordering extension's appended and moved keys are the ones.
 */
export abstract class InsertValue {
  abstract compute(
    context: InsertValueContext,
    indexes: readonly number[]
  ): readonly unknown[] | Promise<readonly unknown[]>;
}

/**
 * An update value keeping the field as stored (an official extension's
 * call, never a caller's payload): set aside at admission as any
 * `InsertValue`, so no generated update value (`updatedAt()`) fills it,
 * then dropped from the data (an update left with nothing to write is one
 * that writes nothing), and not judged as a field the write writes.
 * Ordering's own writes place a row; they do not change it.
 */
export class Stored extends InsertValue {
  compute(): never {
    throw new Error("Stored is no value: the update leaves its field out");
  }
}

/**
 * An `updateMany` value read from a derived table the UPDATE joins (an
 * official extension's call, never a caller's payload): `join` answers that
 * table, aliased, and the condition matching it to the row written, over the
 * target's columns qualified by `target`; `compute` answers the SET
 * expression over the table's columns. The engine joins it (`UPDATE … FROM`,
 * MySQL's `UPDATE … JOIN`), so one statement writes each row its own value
 * and the source is read once, before any row changes. Respacing's keys.
 */
export abstract class JoinedValue extends InsertValue {
  abstract join(
    queries: Queries,
    target: string
  ): { readonly source: Sql; readonly on: Sql };
  /** The same values for a backend that reads the rows and writes them itself. */
  abstract plan(): JoinedPlan;
}

export interface JoinedPlan {
  readonly key: string;
  readonly within: readonly string[];
  readonly identity: readonly string[];
  readonly order: readonly (readonly [string, "asc" | "desc"])[];
  readonly where: unknown;
}

/**
 * Each engine's renderer, by its schema then its driver's adapter: an
 * official extension that writes a statement of its own (ordering's
 * respacing) names tables and columns and binds values as the engine's
 * queries do, without importing the engine into its entry.
 */
export const renderers = new WeakMap<object, WeakMap<object, Queries>>();
