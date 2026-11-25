/**
 * Views kept by triggers on `viborm/durable-object`, in one object: a push
 * creates them, every write moves them (`exerciseAutoViews`), and a second
 * push plans nothing.
 */
import { createClient } from "@src/drivers/durable-object";
import { createMigrationClient } from "@src/migrations/client";
import {
  autoViewsSchema,
  exerciseAutoViews,
} from "@tests/contracts/public-client/schema-auto-views-behavior";
import { describe, expect, test } from "vitest";
import { inObject } from "./objects";

describe("Durable Object driver: views kept by triggers", () => {
  test("a push creates them, every write moves them, and a second push plans nothing", async () => {
    await inObject(async (state) => {
      const client = createClient({
        storage: state.storage,
        schema: autoViewsSchema(),
      });
      const migrations = createMigrationClient(client);
      const preview = await migrations.push({ dryRun: true });
      expect(
        (await migrations.push({ consent: preview.consent })).outcome
      ).toBe("applied");
      await exerciseAutoViews(client as never, (name) => `"${name}"`);
      expect((await migrations.push({ dryRun: true })).operations).toEqual([]);
    });
  });
});
