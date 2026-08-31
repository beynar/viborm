import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";

import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const item = s
  .model({
    id: s.string().id(),
    label: s.string(),
    qty: s.int(),
  })
  .map("raw_array_provider_items");

const schema = { item };

export interface RawArrayTransactionBehaviorOptions {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

/**
 * Live-provider proof for the client-level lazy raw-operation protocol.
 *
 * Both contracts enter through `$transaction([...])`: the first proves declared
 * raw/model/raw order and public results, and the second proves that a later raw
 * failure rolls an earlier model write and raw write back together.
 */
export function runRawArrayTransactionBehavior({
  name,
  createDriver,
}: RawArrayTransactionBehaviorOptions): void {
  describe(`raw/model array transactions (${name})`, () => {
    test("execute in declared order and return each public result", async () => {
      const client = createClient({ schema, driver: createDriver() });
      try {
        await syncLiveSchema(client);
        await client.item.create({
          data: { id: "ordered", label: "before", qty: 1 },
        });

        const [affected, modelRows, rawRows] = await client.$transaction([
          client.$executeRaw`
            UPDATE raw_array_provider_items
            SET label = ${"after"}
            WHERE id = ${"ordered"}
          `,
          client.item.findMany({
            where: { label: "after" },
            select: { id: true, label: true },
          }),
          client.$queryRaw<{ id: string; label: string }>`
            SELECT id, label
            FROM raw_array_provider_items
            WHERE label = ${"after"}
          `,
        ]);

        expect(affected).toBe(1);
        expect(modelRows).toEqual([{ id: "ordered", label: "after" }]);
        expect(rawRows).toEqual([{ id: "ordered", label: "after" }]);
      } finally {
        await client.$disconnect();
      }
    });

    test("a later raw failure rolls model and raw writes back", async () => {
      const client = createClient({ schema, driver: createDriver() });
      try {
        await syncLiveSchema(client);
        await client.item.createMany({
          data: [
            { id: "model-write", label: "model", qty: 1 },
            { id: "raw-write", label: "raw", qty: 2 },
          ],
        });

        await expect(
          client.$transaction([
            client.item.update({
              where: { id: "model-write" },
              data: { qty: 101 },
            }),
            client.$executeRaw`
              UPDATE raw_array_provider_items
              SET qty = ${202}
              WHERE id = ${"raw-write"}
            `,
            client.$queryRawUnsafe(
              "SELECT * FROM raw_array_provider_table_that_does_not_exist"
            ),
          ])
        ).rejects.toThrow();

        await expect(
          client.item.findMany({
            orderBy: { id: "asc" },
            select: { id: true, qty: true },
          })
        ).resolves.toEqual([
          { id: "model-write", qty: 1 },
          { id: "raw-write", qty: 2 },
        ]);
      } finally {
        await client.$disconnect();
      }
    });
  });
}

export const rawArrayTransactionContract = defineContract({
  id: "drivers.raw-array-transaction",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "transactions"],
  register: runRawArrayTransactionBehavior,
});
