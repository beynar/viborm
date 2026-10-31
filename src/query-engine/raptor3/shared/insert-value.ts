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
  readonly dialect: "postgresql" | "mysql" | "sqlite";
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
 * Each engine's renderer, by its schema then its driver's adapter: an
 * official extension that writes a statement of its own (ordering's
 * respacing) names tables and columns and binds values as the engine's
 * queries do, without importing the engine into its entry.
 */
export const renderers = new WeakMap<object, WeakMap<object, Queries>>();
