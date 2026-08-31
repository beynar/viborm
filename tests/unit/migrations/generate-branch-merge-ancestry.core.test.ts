import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { generateV1 } from "@src/migrations/generate-v1";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

/**
 * A structural merge is refused by ANCESTRY, not by the two states it joins.
 *
 * Converging two branches means compiling one transition per parent from the
 * differ alone. That is only sound while every step behind those parents is
 * something the differ could have produced; one hand-written transition
 * anywhere in the history means the merged program cannot be derived from
 * schema shape. The parents here are both ordinary structural states — the
 * manual work is their shared grandparent.
 */

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
});
const tag = s.model({
  id: s.string().id(),
  label: s.string(),
});

describe("generate merge ancestry", () => {
  test("refuses a merge whose parents are structural but whose grandparent is manual", async () => {
    const storage = new MemoryEstateStorage();
    const root = createClient({
      schema: { user },
      driver: new PlanningDriver("sqlite"),
    });
    const manual = await generateV1(root, storage, {
      name: "manual-root",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "transactional",
            up: [sql`SELECT 1`],
            rollback: { kind: "irreversible", reason: "hand written" },
          },
        ],
      },
    });
    expect(manual.outcome).toBe("published");

    // Two structural branches off that one manual state. Each carries a real
    // schema change, so neither is the no-op generate refuses to publish.
    const left = createClient({
      schema: { user, post },
      driver: new PlanningDriver("sqlite"),
    });
    const leftState = await generateV1(left, storage, {
      name: "add-post",
      from: manual.stateId,
    });
    const right = createClient({
      schema: { user, tag },
      driver: new PlanningDriver("sqlite"),
    });
    const rightState = await generateV1(right, storage, {
      name: "add-tag",
      from: manual.stateId,
    });
    expect(leftState.outcome).toBe("published");
    expect(rightState.outcome).toBe("published");

    const merged = createClient({
      schema: { user, post, tag },
      driver: new PlanningDriver("sqlite"),
    });
    await expect(
      generateV1(merged, storage, { name: "merge" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("cannot be merged structurally"),
    });
    // The refusal is a decision, not a half-written estate.
    expect(await storage.listStates()).toHaveLength(3);

    await root.$disconnect();
    await left.$disconnect();
    await right.$disconnect();
    await merged.$disconnect();
  });
});
