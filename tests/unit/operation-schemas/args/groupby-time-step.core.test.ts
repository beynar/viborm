/**
 * `groupBy` time steps at admission: `by` takes a column or `{ column: step }`
 * for a `date`/`dateTime` column, `timeZone` takes an IANA name, and every
 * wrong spelling is refused at the key that is wrong — through the per-model
 * schema and through the public `validateOperationPayload` alike.
 */

import { validateOperationPayload } from "@client/schema-introspection";
import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const facture = s.model({
  id: s.int().id(),
  statut: s.string(),
  montant: s.int(),
  date: s.dateTime(),
  jour: s.date(),
  wall: s.dateTime().withoutTimezone(),
  dueAt: s.dateTime().nullable(),
  jours: s.date().array(),
});
const schema = { facture };
const groupBy =
  createSchemaRegistry(schema).getModelSchemas(facture).args.groupBy;

const issue = (args: Record<string, unknown>) => parse(groupBy, args).issues;

const STEPS = ["day", "week", "month", "quarter", "year"] as const;

describe("groupBy time step admission", () => {
  test("admits each step on date, dateTime, naive and nullable columns, mixed with plain columns", () => {
    for (const step of STEPS)
      for (const column of ["date", "jour", "wall", "dueAt"]) {
        const args = {
          by: ["statut", { [column]: step }],
          _count: true,
          orderBy: { [column]: "asc" },
          timeZone: "America/Montreal",
        };
        expect(parse(groupBy, args), `${column} ${step}`).toEqual({
          value: args,
        });
      }
    expect(
      parse(groupBy, { by: [{ date: "month" }, { jour: "week" }] }).issues
    ).toBeUndefined();
  });

  test("normalises a single step member to a list", () => {
    expect(parse(groupBy, { by: { date: "year" } })).toEqual({
      value: { by: [{ date: "year" }] },
    });
  });

  test("refuses an unknown step at its column", () => {
    const issues = issue({ by: ["statut", { date: "hour" }] });
    expect(issues?.[0]?.path).toEqual(["by", 1, "date"]);
  });

  test("refuses a column that is not a single date or dateTime", () => {
    for (const column of ["montant", "statut", "jours"]) {
      expect(issue({ by: [{ [column]: "month" }] })).toEqual([
        {
          message: `'${column}' is not a date or dateTime column.`,
          path: ["by", 0, column],
        },
      ]);
    }
    expect(issue({ by: [{ nope: "month" }] })?.[0]?.path).toEqual([
      "by",
      0,
      "nope",
    ]);
  });

  test("refuses an object naming several columns, or none", () => {
    expect(issue({ by: [{ date: "month", jour: "year" }] })).toEqual([
      {
        message: 'A time step names one column: { date: "month" }.',
        path: ["by", 0, "jour"],
      },
    ]);
    expect(issue({ by: [{}] })?.[0]?.message).toContain(
      'A time step names one column: { date: "month" }.'
    );
  });

  test("refuses a column named twice, in any spelling", () => {
    const duplicate = [
      { message: "GroupBy operation does not allow duplicate fields in 'by'" },
    ];
    expect(issue({ by: ["date", { date: "month" }] })).toEqual(duplicate);
    expect(issue({ by: [{ date: "month" }, { date: "year" }] })).toEqual(
      duplicate
    );
  });

  test("refuses a time zone that is not an IANA name", () => {
    for (const timeZone of [
      "UTC+5",
      "+05:00",
      "-0500",
      "EST",
      "CET",
      "Etc/GMT+5",
      "Etc/GMT-14",
      "Mars/Olympus",
      "america/montreal",
      "",
      5,
    ])
      expect(
        issue({ by: [{ date: "month" }], timeZone }),
        String(timeZone)
      ).toEqual([
        {
          message:
            "'timeZone' takes an IANA name such as 'America/Montreal', not an offset or an abbreviation.",
          path: ["timeZone"],
        },
      ]);
    for (const timeZone of [
      "UTC",
      "Etc/UTC",
      "America/Montreal",
      "Asia/Kolkata",
    ])
      expect(issue({ by: [{ date: "day" }], timeZone })).toBeUndefined();
    // Without a step a zone changes nothing, and is still checked.
    expect(issue({ by: ["statut"], timeZone: "UTC" })).toBeUndefined();
    expect(issue({ by: ["statut"], timeZone: "EST" })).toBeDefined();
  });

  test("refuses 'having' on a column grouped by a time step; aggregates over it stay", () => {
    const stepped = (path: PropertyKey[]) => [
      {
        message:
          "'having' cannot compare 'date', grouped by a time step; filter it in 'where'.",
        path: ["having", ...path],
      },
    ];
    expect(
      issue({
        by: [{ date: "month" }],
        having: { date: { gt: "2026-01-01T00:00:00Z" } },
      })
    ).toEqual(stepped(["date"]));
    expect(
      issue({
        by: ["statut", { date: "month" }],
        having: {
          OR: [{ statut: "payee" }, { date: { lt: "2026-01-01T00:00:00Z" } }],
        },
      })
    ).toEqual(stepped(["OR", 1, "date"]));
    expect(
      issue({
        by: [{ date: "month" }],
        having: { date: { _count: { gt: 1 } }, montant: { _sum: { gt: 5 } } },
      })
    ).toBeUndefined();
  });

  test("orders by a stepped column or an aggregate, not by another column", () => {
    expect(
      issue({
        by: [{ date: "month" }],
        orderBy: [{ date: "desc" }, { _sum: { montant: "asc" } }],
      })
    ).toBeUndefined();
    expect(
      issue({ by: [{ date: "month" }], orderBy: { jour: "asc" } })?.[0]?.path
    ).toEqual(["orderBy", "jour"]);
  });

  test("validateOperationPayload admits the form and refuses at the same place", () => {
    expect(
      validateOperationPayload(schema, "facture", "groupBy", {
        by: ["statut", { date: "month" }],
        timeZone: "America/Montreal",
        _sum: { montant: true },
      })
    ).toEqual({
      by: ["statut", { date: "month" }],
      timeZone: "America/Montreal",
      _sum: { montant: true },
    });
    for (const payload of [
      { by: [{ date: "hour" }] },
      { by: [{ montant: "month" }] },
      { by: ["date", { date: "month" }] },
      { by: [{ date: "month", jour: "day" }] },
      { by: [{ date: "month" }], timeZone: "UTC+5" },
      {
        by: [{ date: "month" }],
        having: { date: { gt: "2026-01-01T00:00:00Z" } },
      },
    ])
      expect(
        () => validateOperationPayload(schema, "facture", "groupBy", payload),
        JSON.stringify(payload)
      ).toThrow();
  });
});
