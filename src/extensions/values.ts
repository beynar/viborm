/**
 * The values a write computes, as a caller or an extension builds them. The
 * engine holds what such a value is (`InsertValue`, `Stored`, `JoinedValue`);
 * these build one.
 */
import {
  InsertValue,
  type InsertValueContext,
  JoinedValue,
  type ModelSql,
  Stored,
} from "@query-engine/raptor3/shared/insert-value";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { Sql } from "@sql";

/** {@link computed}'s value. */
class Computed extends InsertValue {
  readonly compute: InsertValue["compute"];
  constructor(compute: InsertValue["compute"]) {
    super();
    this.compute = compute;
  }
}

/**
 * A written value the write computes: `compute` answers, for the rows of one
 * statement that hold it (`indexes` into `context.rows`), one value each, a
 * plain value or an SQL expression the statement evaluates. Typed as the
 * field it is written to.
 */
export const computed = <T = never>(compute: InsertValue["compute"]): T =>
  new Computed(compute) as T;

/** An update value that keeps its field as stored: no generated value (`updatedAt()`) fills it. */
export const stored = <T = never>(): T => new Stored() as T;

/** {@link joined}'s value. */
class Joined extends JoinedValue {
  readonly #from: JoinedSource;
  constructor(from: JoinedSource) {
    super();
    this.#from = from;
  }
  compute({ sql }: InsertValueContext): readonly unknown[] {
    return [this.#from.value(sql)];
  }
  join(sql: ModelSql, target: string) {
    return this.#from.join(sql, target);
  }
  rows(sql: ModelSql, read: (statement: Sql) => Promise<readonly Input[]>) {
    return this.#from.rows(sql, read);
  }
}

/** What {@link joined} reads each row's value from. */
export interface JoinedSource {
  /** The derived table, aliased, and the condition matching it to the row written, whose columns `target` qualifies. */
  join(
    sql: ModelSql,
    target: string
  ): { readonly source: Sql; readonly on: Sql };
  /** The SET expression, over the derived table's columns. */
  value(sql: ModelSql): Sql;
  /** The same values as a list, where the database joins no derived table: see {@link JoinedEntry}. */
  rows: JoinedValue["rows"];
}

/**
 * An `updateMany` value each row reads from a derived table the UPDATE joins:
 * one statement writes each row its own value, the source read once before
 * any row changes. Typed as the field it is written to.
 */
export const joined = <T = never>(from: JoinedSource): T =>
  new Joined(from) as T;
