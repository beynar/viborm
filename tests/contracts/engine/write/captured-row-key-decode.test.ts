import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const UNSAFE_LOGICAL_KEY = "90071992547409.93";
const inverseSchema = (() => {
  const slip = s
    .model({
      id: s.int().id(),
      note: s.string(),
      crate: s.toOne(() => crate),
    })
    .map("crk_slips");
  const crate = s
    .model({
      id: s.decimal({ precision: 16, scale: 2 }).id(),
      label: s.string(),
      items: s
        .toMany({ slip: () => slip }, { values: { slip: "crk.slip.v1" } })
        .through({
          slip: { table: "crk_crate_slips", source: "holder", target: "entry" },
        }),
    })
    .map("crk_crates");
  return { slip, crate };
})();

describe("captured row-key decoding on SQLite", () => {
  test("a singular junction transfer captures a decimal owner above 2^53", async () => {
    const client = createClient({
      schema: inverseSchema,
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });
    try {
      await push(client, { force: true });
      await client.crate.create({
        data: { id: UNSAFE_LOGICAL_KEY, label: "Unsafe owner" },
      });
      await client.crate.create({ data: { id: "2", label: "Next owner" } });
      await client.slip.create({ data: { id: 1, note: "transfer me" } });
      await client.crate.update({
        where: { id: UNSAFE_LOGICAL_KEY },
        data: {
          items: { connect: [{ type: "slip", where: { id: 1 } }] },
        },
      });

      await client.slip.update({
        where: { id: 1 },
        data: { crate: { connect: { id: "2" } } },
      });

      const rows = await client.$queryRawUnsafe<
        { holder: string; entry: number }[]
      >(
        'SELECT CAST("holder" AS TEXT) AS "holder", "entry" FROM "crk_crate_slips"'
      );
      expect(rows).toEqual([{ holder: "200", entry: 1 }]);
    } finally {
      await client.$disconnect();
    }
  });
});
