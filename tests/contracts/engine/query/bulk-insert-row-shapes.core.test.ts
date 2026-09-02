import { createClient } from "@client/client";
import { s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

const batchRow = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique(),
    label: s.string(),
  })
  .map("bulk_shape_batch_rows");

const schema = { batchRow };

describe("bulk insert row-shape planning", () => {
  test("empty createMany rejects during batch preparation", async () => {
    const driver = new PlanningDriver("postgresql", {
      supportsTransactions: false,
      supportsBatch: true,
    });
    const client = createClient({ schema, driver });

    await expect(
      client.$transaction([client.batchRow.createMany({ data: [] })])
    ).rejects.toThrow("No data to insert");
  });

  test("mixed row shapes require an atomic substrate", async () => {
    const driver = new PlanningDriver("postgresql", {
      supportsTransactions: false,
      supportsBatch: false,
    });
    const client = createClient({ schema, driver });

    await expect(
      client.batchRow.createMany({
        data: [
          { code: "generated", label: "first" },
          { id: 50, code: "explicit", label: "second" },
        ],
      })
    ).rejects.toThrow("neither transactions nor atomic batch execution");
  });
});
