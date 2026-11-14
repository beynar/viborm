import type { OperationResult } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const facture = s.model({
  id: s.int().id(),
  statut: s.string(),
  montant: s.int(),
  date: s.dateTime(),
  jour: s.date(),
  dueAt: s.dateTime().nullable(),
  jours: s.date().array(),
});

const client = createClient({
  schema: { facture },
  driver: new PGliteDriver(),
});

type Row<Args> = OperationResult<"groupBy", typeof facture, Args>[number];

describe("groupBy by a time step: types", () => {
  test("a stepped column reads as the period's YYYY-MM-DD string", () => {
    type Mixed = Row<{
      by: ["statut", { date: "month" }];
      _sum: { montant: true };
      _count: true;
    }>;
    expectTypeOf<Mixed["statut"]>().toEqualTypeOf<string>();
    expectTypeOf<Mixed["date"]>().toEqualTypeOf<string>();
    expectTypeOf<Mixed["_sum"]["montant"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Mixed["_count"]>().toEqualTypeOf<number>();
    // Without a step, the same column is a Date.
    expectTypeOf<Row<{ by: ["date"] }>["date"]>().toEqualTypeOf<Date>();
  });

  test("a nullable column keeps its null group; a single member is a list", () => {
    expectTypeOf<
      Row<{ by: [{ dueAt: "week" }, { jour: "year" }] }>
    >().toEqualTypeOf<{ dueAt: string | null; jour: string }>();
    expectTypeOf<Row<{ by: { jour: "quarter" } }>>().toEqualTypeOf<{
      jour: string;
    }>();
  });

  test("the client call: orderBy names the stepped column; wrong spellings fail", async () => {
    const rows = await client.facture.groupBy({
      by: ["statut", { date: "month" }],
      timeZone: "America/Montreal",
      _sum: { montant: true },
      orderBy: [{ date: "asc" }, { _sum: { montant: "desc" } }],
    });
    expectTypeOf(rows[0]!.date).toEqualTypeOf<string>();

    const _ungroupedOrder = () =>
      client.facture.groupBy({
        by: [{ date: "month" }],
        // @ts-expect-error - jour is not grouped
        orderBy: { jour: "asc" },
      });
    const _notADate = () =>
      client.facture.groupBy({
        // @ts-expect-error - montant is not a date or dateTime column
        by: [{ montant: "month" }],
      });
    const _list = () =>
      client.facture.groupBy({
        // @ts-expect-error - a list of dates has no single period
        by: [{ jours: "month" }],
      });
    const _twoColumns = () =>
      client.facture.groupBy({
        // @ts-expect-error - one column per member
        by: [{ date: "month", jour: "year" }],
      });
    const _unknownStep = () =>
      client.facture.groupBy({
        // @ts-expect-error - hour is not a step
        by: [{ date: "hour" }],
      });
    expectTypeOf(_ungroupedOrder).toBeFunction();
    expectTypeOf(_notADate).toBeFunction();
    expectTypeOf(_list).toBeFunction();
    expectTypeOf(_twoColumns).toBeFunction();
    expectTypeOf(_unknownStep).toBeFunction();
  });
});
