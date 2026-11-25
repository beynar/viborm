/**
 * A view declared `.materialized({ refresh: "auto" })` on SurrealDB, against
 * a server: the database keeps every view current itself
 * (`DEFINE TABLE … AS`), so it is the ordinary view, of the same hash (a push
 * after a change of kind plans nothing), each write reaches it, and
 * `$refresh` sends nothing. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations/dialects/surrealql";
import { s } from "@schema";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, it } from "vitest";

const describeIf = surrealUrl ? describe : describe.skip;

function schema(auto: boolean) {
  const sale = s
    .model({
      id: s.string().id(),
      shopId: s.string(),
      status: s.string(),
      amount: s.int(),
    })
    .map("au_sales");
  const view = s.view(() => sale, {
    where: { status: "paid" },
    by: ["shopId"],
    _count: true,
    _sum: { amount: true },
  });
  return {
    sale,
    byShop: (auto
      ? view.materialized({ refresh: "auto" })
      : view.materialized()
    ).map("au_by_shop"),
  };
}

describeIf("SurrealDB: a view kept by triggers elsewhere", () => {
  it("is the ordinary view the database keeps current, and $refresh sends nothing", async () => {
    const driver = createSurrealTestDriver();
    await (driver as unknown as { fresh(): Promise<void> }).fresh();
    const ordinary = createClient({ driver, schema: schema(false) });
    expect(await createMigrationClient(ordinary).push()).toMatchObject({
      outcome: "applied",
    });
    const auto = createClient({ driver, schema: schema(true) });
    expect(await createMigrationClient(auto).push()).toMatchObject({
      outcome: "noop",
    });
    await auto.sale.createMany({
      data: [
        { id: "1", shopId: "a", status: "paid", amount: 5 },
        { id: "2", shopId: "a", status: "paid", amount: 3 },
        { id: "3", shopId: "b", status: "open", amount: 7 },
      ],
    });
    await auto.sale.update({ where: { id: "3" }, data: { status: "paid" } });
    expect(await auto.byShop.findMany({ orderBy: { shopId: "asc" } })).toEqual([
      { shopId: "a", count: 2, sumAmount: 8 },
      { shopId: "b", count: 1, sumAmount: 7 },
    ]);
    await expect(auto.byShop.$refresh()).resolves.toBeUndefined();
    await auto.$disconnect();
    await ordinary.$disconnect();
  });
});
