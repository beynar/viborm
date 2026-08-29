import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const entry = s.model({
  id: s.string().id(),
  amount: s.decimal({ precision: 10, scale: 2 }),
  amounts: s.decimal({ precision: 10, scale: 2 }).array(),
});

const receipt = s.model({
  id: s.string().id(),
  entryId: s.string(),
  entry: s
    .toOne(() => entry)
    .fields("entryId")
    .references("id"),
});

const client = createClient({
  schema: { entry, receipt },
  driver: new PGliteDriver(),
});

describe("public decimal-list ordering", () => {
  const _scalarOrder = () =>
    client.entry.findMany({ orderBy: { amount: "asc" } });

  const _listOrder = () =>
    client.entry.findMany({
      // @ts-expect-error - a decimal list has no numeric ordering
      orderBy: {
        amount: "asc",
        amounts: "asc",
      },
    });

  const _groupByListOrder = () =>
    client.entry.groupBy({
      by: ["amounts"],
      // @ts-expect-error - grouping does not make a list numerically orderable
      orderBy: {
        amount: "asc",
        amounts: "asc",
      },
    });

  const _relationListOrder = () =>
    client.receipt.findMany({
      // @ts-expect-error - the nested order schema carries the same refusal
      orderBy: { entry: { amount: "asc", amounts: "asc" } },
    });

  test("the probes enter through the public client", () => {
    expectTypeOf(_scalarOrder).toBeFunction();
    expectTypeOf(_listOrder).toBeFunction();
    expectTypeOf(_groupByListOrder).toBeFunction();
    expectTypeOf(_relationListOrder).toBeFunction();
  });
});
