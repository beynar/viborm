import { s } from "@schema";
import { describe, expectTypeOf, test } from "vitest";

const ledger = s.model({
  id: s.string().id(),
  region: s.string(),
  amount: s.decimal({ precision: 10, scale: 2 }),
  amounts: s.decimal({ precision: 10, scale: 2 }).array(),
});

describe("public decimal-list key positions", () => {
  const _scalarKeys = () =>
    ledger.index(["amount"]).id(["region", "amount"]).unique(["amount"]);

  const _listIndex = () =>
    ledger.index([
      "amount",
      // @ts-expect-error - a fixed-decimal list cannot be an index member
      "amounts",
    ]);

  const _listCompoundId = () =>
    ledger.id([
      "region",
      // @ts-expect-error - a fixed-decimal list cannot be a compound ID member
      "amounts",
    ]);

  const _listCompoundUnique = () =>
    ledger.unique([
      "region",
      // @ts-expect-error - a fixed-decimal list cannot be a compound unique member
      "amounts",
    ]);

  test("the probes enter through the public model builder", () => {
    expectTypeOf(_scalarKeys).toBeFunction();
    expectTypeOf(_listIndex).toBeFunction();
    expectTypeOf(_listCompoundId).toBeFunction();
    expectTypeOf(_listCompoundUnique).toBeFunction();
  });
});
