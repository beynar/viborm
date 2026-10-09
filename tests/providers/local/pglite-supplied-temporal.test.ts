import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { expect, test } from "vitest";

const moment = s
  .model({ id: s.int().id(), at: s.dateTime().withoutTimezone() })
  .map("borrowed_moments");

test("borrowed PGlite timestamps stay UTC under a non-UTC process timezone", async () => {
  const originalTimezone = process.env.TZ;
  const provider = openTestPGlite();
  const client = createClient({
    schema: { moment },
    driver: new PGliteDriver({ client: provider }),
  });
  process.env.TZ = "America/Los_Angeles";
  try {
    await provider.exec(
      'CREATE TABLE "borrowed_moments" ("id" INTEGER PRIMARY KEY, "at" TIMESTAMP(3) NOT NULL)'
    );
    const at = new Date("2024-07-08T09:10:11.123Z");
    const created = await client.moment.create({ data: { id: 1, at } });
    expect(created.at.toISOString()).toBe(at.toISOString());
    const found = await client.moment.findUnique({ where: { id: 1 } });
    expect(found?.at.toISOString()).toBe(at.toISOString());
    expect(await client.moment.count({ where: { at } })).toBe(1);
    await client.$disconnect();
    expect(
      (await provider.query<{ alive: number }>("SELECT 1 AS alive")).rows
    ).toEqual([{ alive: 1 }]);
  } finally {
    try {
      await client.$disconnect();
    } finally {
      try {
        await closeTestPGlite(provider);
      } finally {
        if (originalTimezone === undefined)
          Reflect.deleteProperty(process.env, "TZ");
        else process.env.TZ = originalTimezone;
      }
    }
  }
});
