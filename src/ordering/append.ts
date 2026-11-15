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

import { computed } from "../extensions/values";
import type { ComputedContext, ModelSql } from "../index";
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
  q: ModelSql,
  s: Spelling,
  field: string,
  values: readonly unknown[]
): Sql {
  const key = q.column(field);
  const where = within.map((name, position) => {
    const value = values[position];
    return value === null
      ? sql`${q.column(name)} IS NULL`
      : sql`${q.column(name)} = ${q.value(name, value)}`;
  });
  where.push(s.digits(key));
  return sql`SELECT MAX(${key}) AS k FROM ${q.table()} WHERE ${sql.join(where, " AND ")}`;
}

/**
 * The INSERT's own expression for the `step`-th appended row of a group
 * (1-based): integer max(last, -1) + step with a random fraction, as
 * `keysBetween(last, null, …)` computes it.
 */
function expression(dialect: string, last: Sql, step: number): Sql {
  const first = sql.raw(String(step - 1));
  const next = sql.raw(String(step));
  switch (dialect) {
    case "postgresql":
      return sql`(SELECT CASE WHEN n > 999999999 THEN NULL ELSE length(n::text)::text || n::text || rtrim(lpad(floor(random() * 1000000)::bigint::text, 6, '0'), '0') END FROM (SELECT CASE WHEN k IS NULL OR left(k, 1) = '0' THEN ${first} ELSE substr(k, 2, substr(k, 1, 1)::int)::bigint + ${next} END AS n FROM (${last}) AS m) AS x)`;
    case "mysql":
      return sql`(SELECT CASE WHEN n > 999999999 THEN NULL ELSE CONCAT(CHAR_LENGTH(n), n, TRIM(TRAILING '0' FROM LPAD(FLOOR(RAND() * 1000000), 6, '0'))) END FROM (SELECT CASE WHEN k IS NULL OR LEFT(k, 1) = '0' THEN ${first} ELSE CAST(SUBSTRING(k, 2, CAST(LEFT(k, 1) AS UNSIGNED)) AS UNSIGNED) + ${next} END AS n FROM (${last}) AS m) AS x)`;
    default:
      return sql`(SELECT CASE WHEN n > 999999999 THEN NULL ELSE length(n) || n || rtrim(printf('%06d', abs(random()) % 1000000), '0') END FROM (SELECT CASE WHEN k IS NULL OR substr(k, 1, 1) = '0' THEN ${first} ELSE CAST(substr(k, 2, CAST(substr(k, 1, 1) AS INTEGER)) AS INTEGER) + ${next} END AS n FROM (${last}) AS m) AS x)`;
  }
}

async function appended(
  within: readonly string[],
  { rows, field, sql: q, dialect, read }: ComputedContext,
  indexes: readonly number[]
): Promise<readonly unknown[]> {
  const groups = groupsOf(within, rows, indexes);
  const key = q.column(field);
  const keys = new Map<number, unknown>();
  const assign = (group: Group, keyOf: (step: number) => unknown) => {
    for (const [step, index] of group.at.entries())
      keys.set(index, keyOf(step));
  };
  // SurrealDB computes no key in the statement: the last key is read, in
  // the call's unit, and the keys are computed here. Its driver sends every
  // call in a transaction, where each answer is heard: `read` is there.
  if (dialect === "surrealql")
    for (const group of groups) {
      const held = within.map((name, position) => {
        const value = group.values[position];
        return value === null
          ? sql`${q.column(name)} = NONE`
          : sql`${q.column(name)} = ${q.value(name, value)}`;
      });
      held.push(sql`string::matches(${key}, ${"^[0-9]{2,}$"})`);
      const [last] = await read!(
        sql`SELECT ${key} AS key, id FROM ${q.table()} WHERE ${sql.join(held, " AND ")} ORDER BY key DESC LIMIT 1`
      );
      const made = keysAfter(
        (last?.key as string | undefined) ?? null,
        group.at.length
      );
      assign(group, (step) => made[step]);
    }
  else if (dialect === "mysql" && read !== undefined) {
    const reads = groups.map(
      (group, position) =>
        sql`(${lastOf(within, q, spellings.mysql, field, group.values)}) AS ${sql.raw(`g${position}`)}`
    );
    const [answer] = await read(sql`SELECT ${sql.join(reads, ", ")}`);
    for (const [position, group] of groups.entries()) {
      const made = keysAfter(
        (answer?.[`g${position}`] ?? null) as string | null,
        group.at.length
      );
      assign(group, (step) => made[step]);
    }
  } else
    for (const group of groups) {
      const last = lastOf(within, q, spellings[dialect], field, group.values);
      assign(group, (step) => expression(dialect, last, step + 1));
    }
  return indexes.map((index) => keys.get(index));
}
