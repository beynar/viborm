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

import { UnsupportedOperationError } from "../errors";
import { type ComputedContext, computed } from "../index";
import { type Sql, sql } from "../sql/sql";
import { type Spelling, spellings } from "./between";
import { keysAfter } from "./keys";

type Input = Readonly<Record<string, unknown>>;

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
export const appendKey = (within: readonly string[]): string =>
  computed<string>((context, indexes) => appended(within, context, indexes));

/**
 * `SELECT MAX(key) FROM table WHERE group`, null-safe, over the values
 * that are digit strings of two digits or more: a value that is no key (a
 * backfilled constant) is never the list's last, so an append is placed
 * after the list's keys on every dialect and never casts a non-digit.
 */
function lastOf(
  within: readonly string[],
  context: ComputedContext,
  spelling: Spelling,
  values: readonly unknown[]
): Sql {
  {
    const q = context.sql;
    const key = q.column(context.field);
    const where = within.map((name, position) => {
      const value = values[position];
      return value === null
        ? sql`${q.column(name)} IS NULL`
        : sql`${q.column(name)} = ${q.value(name, value)}`;
    });
    where.push(spelling.digits(key));
    return sql`SELECT MAX(${key}) AS k FROM ${q.table()} WHERE ${sql.join(where, " AND ")}`;
  }
}

/**
 * The INSERT's own expression for the `step`-th appended row of a group
 * (1-based): integer max(last, -1) + step with a random fraction, as
 * `keysBetween(last, null, …)` computes it.
 */
function expression(spelling: Spelling, last: Sql, step: number): Sql {
  return spelling.appended(
    last,
    sql.raw(String(step - 1)),
    sql.raw(String(step))
  );
}

async function appended(
  within: readonly string[],
  context: ComputedContext,
  indexes: readonly number[]
): Promise<readonly unknown[]> {
  {
    const groups = groupsOf(within, context.rows, indexes);
    const keys = new Map<number, unknown>();
    // SurrealDB computes no key in the statement: the last key is read, in
    // the call's unit, and the keys are computed here.
    if (context.dialect === "surrealql") {
      const { read } = context;
      if (!read)
        throw new UnsupportedOperationError(
          "viborm/ordering on SurrealDB reads a list's last key before it appends: not in a batch."
        );
      const q = context.sql;
      const key = q.column(context.field);
      for (const group of groups) {
        const held = within.map((name, position) => {
          const value = group.values[position];
          return value === null
            ? sql`${q.column(name)} = NONE`
            : sql`${q.column(name)} = ${q.value(name, value)}`;
        });
        held.push(sql`string::matches(${key}, ${"^[0-9]{2,}$"})`);
        const [last] = await read(
          sql`SELECT ${key} AS key, id FROM ${q.table()} WHERE ${sql.join(held, " AND ")} ORDER BY key DESC LIMIT 1`
        );
        const made = keysAfter(
          (last?.key as string | undefined) ?? null,
          group.at.length
        );
        for (const [step, index] of group.at.entries())
          keys.set(index, made[step]);
      }
      return indexes.map((index) => keys.get(index));
    }
    const spelling = spellings[context.dialect];
    if (context.dialect === "mysql" && context.read !== undefined) {
      const reads = groups.map(
        (group, position) =>
          sql`(${lastOf(within, context, spelling, group.values)}) AS ${sql.raw(`g${position}`)}`
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
        const last = lastOf(within, context, spelling, group.values);
        for (const [step, index] of group.at.entries())
          keys.set(index, expression(spelling, last, step + 1));
      }
    }
    return indexes.map((index) => keys.get(index));
  }
}
