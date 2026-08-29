import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const MONEY = { precision: 10, scale: 2 } as const;

const account = s.model({
  id: s.string().id(),
  entries: s.toMany(() => entry),
});

const entry = s.model({
  id: s.string().id(),
  amount: s.decimal(MONEY),
  amounts: s.decimal(MONEY).array(),
  receipts: s.toMany(() => receipt),
  accountId: s.string(),
  account: s
    .toOne(() => account)
    .fields("accountId")
    .references("id"),
});

const receipt = s.model({
  id: s.string().id(),
  entryId: s.string(),
  entry: s
    .toOne(() => entry)
    .fields("entryId")
    .references("id"),
});

const registry = createSchemaRegistry({ account, entry, receipt });

describe("decimal-list ordering", () => {
  test("a direct orderBy refuses the list while the scalar remains orderable", () => {
    expect(
      parse(registry.proxy.entry.args.findMany, {
        orderBy: { amount: "asc" },
      }).issues
    ).toBeUndefined();

    expect(
      parse(registry.proxy.entry.args.findMany, {
        orderBy: { amount: "asc", amounts: "asc" },
      }).issues
    ).toBeDefined();
  });

  test("the same refusal applies through a nested relation read", () => {
    expect(
      parse(registry.proxy.account.args.findMany, {
        include: {
          entries: {
            orderBy: { amount: "asc", amounts: "asc" },
          },
        },
      }).issues
    ).toBeDefined();
  });

  test("ordering through a to-one relation cannot reach the list", () => {
    expect(
      parse(registry.proxy.receipt.args.findMany, {
        orderBy: { entry: { amount: "asc" } },
      }).issues
    ).toBeUndefined();

    expect(
      parse(registry.proxy.receipt.args.findMany, {
        orderBy: {
          entry: { amount: "asc", amounts: "asc" },
        },
      }).issues
    ).toBeDefined();
  });

  test("groupBy orderBy refuses the list while scalar grouping stays orderable", () => {
    expect(
      parse(registry.proxy.entry.args.groupBy, {
        by: ["amount"],
        orderBy: { amount: "asc" },
      }).issues
    ).toBeUndefined();

    expect(
      parse(registry.proxy.entry.args.groupBy, {
        by: ["amounts"],
        orderBy: { amounts: "asc" },
      }).issues
    ).toBeDefined();
  });
});
