/**
 * `DatabaseAdapter.period`: the first day of a `groupBy` period as text.
 * PostgreSQL states the wall time it truncates — an instant in the call's
 * zone, a naive date and time as stored, a date as a timestamp — and only
 * PostgreSQL has the member: its absence is how the engine knows to refuse.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { TYPES } from "@schema";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const adapter = new PostgresAdapter();
const column = sql.raw`"t"."at"`;
const render = (...args: Parameters<PostgresAdapter["period"]["of"]>) => {
  const fragment = adapter.period.of(...args);
  return { text: fragment.toStatement("$n"), values: fragment.values };
};

describe("PostgreSQL period", () => {
  test("an instant is truncated as wall time in the bound zone", () => {
    expect(
      render(
        column,
        "month",
        { date: false, withTimezone: true, nativeType: undefined },
        "America/Montreal"
      )
    ).toEqual({
      text: `CAST(date_trunc('month', ("t"."at" AT TIME ZONE $1)) AS DATE)`,
      values: ["America/Montreal"],
    });
  });

  test("a naive date and time and a date are read as written: no zone bound", () => {
    const naive = { date: false, withTimezone: false, nativeType: undefined };
    expect(render(column, "year", naive, "Asia/Tokyo")).toEqual({
      text: `CAST(date_trunc('year', "t"."at") AS DATE)`,
      values: [],
    });
    expect(
      render(
        column,
        "week",
        { date: true, withTimezone: false, nativeType: undefined },
        "UTC"
      )
    ).toEqual({
      text: `CAST(date_trunc('week', CAST("t"."at" AS TIMESTAMP)) AS DATE)`,
      values: [],
    });
  });

  test("a PostgreSQL native type decides over the declared zone", () => {
    const zoned = render(
      column,
      "day",
      {
        date: false,
        withTimezone: false,
        nativeType: TYPES.PG.DATETIME.TIMESTAMPTZ(3),
      },
      "UTC"
    );
    expect(zoned.values).toEqual(["UTC"]);
    const naive = render(
      column,
      "day",
      {
        date: false,
        withTimezone: true,
        nativeType: { pg: TYPES.PG.DATETIME.TIMESTAMP(), mysql: undefined },
      },
      "UTC"
    );
    expect(naive.values).toEqual([]);
  });

  test("every PostgreSQL spelling of a zoned timestamp stores an instant", () => {
    for (const type of [
      "TIMESTAMPTZ",
      "timestamptz(6)",
      "timestamp with time zone",
      "TIMESTAMP(3) WITH TIME ZONE",
    ])
      expect(
        render(
          column,
          "day",
          {
            date: false,
            withTimezone: false,
            nativeType: { db: "pg", type },
          },
          "UTC"
        ).values,
        type
      ).toEqual(["UTC"]);
    for (const type of ["TIMESTAMP", "timestamp(3) without time zone"])
      expect(
        render(
          column,
          "day",
          { date: false, withTimezone: true, nativeType: { db: "pg", type } },
          "UTC"
        ).values,
        type
      ).toEqual([]);
  });

  test("the text of a period is to_char's, era included", () => {
    expect(adapter.period.text(column).toStatement("$n")).toBe(
      `to_char(CAST("t"."at" AS TIMESTAMP), 'YYYY-MM-DD BC')`
    );
  });

  test("each step is its own date_trunc field", () => {
    const instant = { date: false, withTimezone: false, nativeType: undefined };
    for (const step of ["day", "week", "month", "quarter", "year"] as const)
      expect(render(column, step, instant, "UTC").text).toContain(
        `date_trunc('${step}', `
      );
  });
});

test("MySQL and SQLite have no period: the engine refuses the step", () => {
  expect("period" in new MySQLAdapter()).toBe(false);
  expect("period" in new SQLiteAdapter()).toBe(false);
});
