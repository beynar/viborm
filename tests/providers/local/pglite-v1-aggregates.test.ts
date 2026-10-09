import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { expect, it } from "vitest";

it("uses Boolean MIN/MAX semantics for projection, all-null groups and HAVING on PostgreSQL", async () => {
  const database = openTestPGlite();
  const item = s
    .model({
      id: s.int().id(),
      group: s.string(),
      flag: s.boolean().nullable(),
    })
    .map("v1_aggregate_item");
  await database.exec(
    "CREATE TABLE v1_aggregate_item(id INTEGER PRIMARY KEY,\"group\" TEXT NOT NULL,flag BOOLEAN); INSERT INTO v1_aggregate_item VALUES(1,'a',false),(2,'a',true),(3,'a',NULL),(4,'b',NULL)"
  );
  const driver = new PGliteDriver({ client: database });
  const db = createClient({ schema: { item }, driver });
  try {
    const args = {
      by: "group",
      _min: { flag: true },
      _max: { flag: true },
    } as const;
    expect(await db.item.groupBy(args)).toEqual([
      { group: "a", _min: { flag: false }, _max: { flag: true } },
      { group: "b", _min: { flag: null }, _max: { flag: null } },
    ]);
    expect(
      await db.item.groupBy({
        ...args,
        having: { flag: { _max: { equals: true } } },
      })
    ).toEqual([{ group: "a", _min: { flag: false }, _max: { flag: true } }]);
    expect(
      await db.item.aggregate({
        where: { group: "b" },
        _min: { flag: true },
        _max: { flag: true },
      })
    ).toEqual({ _min: { flag: null }, _max: { flag: null } });
  } finally {
    await db.$disconnect();
  }
});
