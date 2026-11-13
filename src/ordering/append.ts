import type { SqlQueries } from "../query-engine/raptor3/shared/sql-queries";
// viborm/ordering appends: the key of a row created without one, after the
// last key of its group.
//
// On PostgreSQL and SQLite (D1, libSQL, PGlite) the INSERT computes it from
// `MAX(key)` of the group, in the same statement: no read first, so a create
// costs what it cost. Two concurrent appends read the same maximum and get
// the same integer: their random fractions keep them apart, both after every
// key the group held.
//
// On MySQL that statement deadlocks under concurrent appends (the INSERT's
// read of the group takes shared next-key locks under REPEATABLE READ: 321
// of 600 appends failed with 1213 on four writers, measured), so the maximum
// is read first by a plain consistent read, which locks nothing, and the
// keys are computed here. Every MySQL driver runs array transactions
// interactively, so this read always happens there; the MySQL expression
// below serves a driver that could not read first.

import { type Sql, sql } from "@sql";
import {
  InsertValue,
  type InsertValueContext,
} from "../query-engine/raptor3/shared/insert-value";
import type { Input } from "../query-engine/raptor3/shared/schema";
import { spellings } from "./between";
import { keysAfter } from "./keys";

/** One group: the indexes of its rows, and its fields' values. */
interface Group {
  readonly values: readonly unknown[];
  readonly at: number[];
}

/** The rows of one INSERT asking for a key, by group, in row order. */
function groupsOf(
  within: readonly string[],
  rows: readonly Input[],
  indexes: readonly number[]
): Group[] {
  const groups = new Map<string, Group>();
  const identities = new Map<unknown, number>();
  // A value the engine produces as SQL is its own group: its rows share the
  // object, never its text.
  const identity = (value: unknown) => {
    if (value === null || typeof value !== "object") return value;
    if (!identities.has(value)) identities.set(value, identities.size);
    return `#${identities.get(value)}`;
  };
  for (const index of indexes) {
    const values = within.map((field) => rows[index]![field] ?? null);
    const key = JSON.stringify(
      values.map((value) =>
        typeof value === "bigint" ? `${value}n` : identity(value)
      )
    );
    const group = groups.get(key) ?? { values, at: [] };
    group.at.push(index);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The key of a row created without one: last of its group. */
export class AppendKey extends InsertValue {
  readonly within: readonly string[];
  constructor(within: readonly string[]) {
    super();
    this.within = Object.freeze([...within]);
  }

  /**
   * `SELECT MAX(key) FROM table WHERE group`, null-safe, over the values
   * that are digit strings of two digits or more: a value that is no key (a
   * backfilled constant) is never the list's last, so an append is placed
   * after the list's keys on every dialect and never casts a non-digit.
   */
  #last(context: InsertValueContext, values: readonly unknown[]): Sql {
    const { model, field } = context;
    const q = context.queries as SqlQueries;
    const key = q.column(model, field);
    const where = this.within.map((name, position) => {
      const value = values[position];
      return value === null
        ? sql`${q.column(model, name)} IS NULL`
        : sql`${q.column(model, name)} = ${q.fieldValue(model, name, value)}`;
    });
    where.push(spellings[context.dialect].digits(key));
    return sql`SELECT MAX(${key}) AS k FROM ${q.table(model)} WHERE ${sql.join(where, " AND ")}`;
  }

  /**
   * The INSERT's own expression for the `step`-th appended row of a group
   * (1-based): integer max(last, -1) + step with a random fraction, as
   * `keysBetween(last, null, …)` computes it.
   */
  #expression(context: InsertValueContext, last: Sql, step: number): Sql {
    return spellings[context.dialect].appended(
      last,
      sql.raw(String(step - 1)),
      sql.raw(String(step))
    );
  }

  async compute(
    context: InsertValueContext,
    indexes: readonly number[]
  ): Promise<readonly unknown[]> {
    const groups = groupsOf(this.within, context.rows, indexes);
    const keys = new Map<number, unknown>();
    if (context.lastKey) {
      for (const group of groups) {
        const list = Object.fromEntries(
          this.within.map((field, position) => [field, group.values[position]])
        ) as Input;
        const made = keysAfter(
          await context.lastKey(list, context.field),
          group.at.length
        );
        for (const [step, index] of group.at.entries())
          keys.set(index, made[step]);
      }
      return indexes.map((index) => keys.get(index));
    }
    if (context.dialect === "mysql" && context.read !== undefined) {
      const reads = groups.map(
        (group, position) =>
          sql`(${this.#last(context, group.values)}) AS ${sql.raw(`g${position}`)}`
      );
      const [answer] = await context.read(sql`SELECT ${sql.join(reads, ", ")}`);
      for (const [position, group] of groups.entries()) {
        const last = (answer?.[`g${position}`] ?? null) as string | null;
        const made = keysAfter(last, group.at.length);
        for (const [step, index] of group.at.entries())
          keys.set(index, made[step]);
      }
    } else {
      for (const group of groups) {
        const last = this.#last(context, group.values);
        for (const [step, index] of group.at.entries())
          keys.set(index, this.#expression(context, last, step + 1));
      }
    }
    return indexes.map((index) => keys.get(index));
  }
}
