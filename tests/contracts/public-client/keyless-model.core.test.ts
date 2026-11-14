/**
 * A model without a row key (a unique field and nothing else) is written by
 * every verb: its rows are named by what the caller's `where` says. A
 * migration refuses such a model (M001); a client over a table that exists,
 * as Studio opens one, does not.
 */

import { createClient, s } from "@src/index";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test("every write verb works on a model that has no key", async () => {
  const reading = s.model({
    value: s.int().unique(),
    note: s.string().nullable(),
  });
  const db = createClient({
    schema: { reading },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(db, { skipValidation: true });

  expect(await db.reading.create({ data: { value: 1 } })).toEqual({
    value: 1,
    note: null,
  });
  expect(
    await db.reading.createMany({ data: [{ value: 2 }, { value: 3 }] })
  ).toEqual({ count: 2 });
  expect(
    await db.reading.update({ where: { value: 1 }, data: { note: "a" } })
  ).toEqual({ value: 1, note: "a" });
  expect(
    await db.reading.updateMany({
      where: { value: { gt: 1 } },
      data: { note: "b" },
    })
  ).toEqual({ count: 2 });
  expect(
    await db.reading.upsert({
      where: { value: 9 },
      create: { value: 9 },
      update: { note: "c" },
    })
  ).toEqual({ value: 9, note: null });
  expect(await db.reading.delete({ where: { value: 1 } })).toEqual({
    value: 1,
    note: "a",
  });
  expect(await db.reading.deleteMany({ where: { value: { gt: 1 } } })).toEqual({
    count: 3,
  });
  expect(await db.reading.findMany()).toEqual([]);
  await db.$disconnect();
});
