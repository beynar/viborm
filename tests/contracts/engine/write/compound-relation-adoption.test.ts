import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";

import {
  type CorrelatedForeignKeyMember,
  type ForeignKeyMember,
  literalParentId,
  pairForeignKeyMembers,
} from "@src/query-engine/write-engine/relation-membership";
import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "@tests/contracts/engine/write/compound-relation-adoption-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

async function setup(driver: PGliteDriver) {
  const client = createClient({ schema: compoundAdoptSchema, driver }) as any;
  await syncLiveSchema(client);
  return client;
}

const substrates = [
  {
    name: "transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

for (const substrate of substrates) {
  // One client per leg: the schema is migrated once and each test resets by DELETE.
  let shared: any;
  registerCompoundAdoptBehavior(
    substrate.name,
    async () => {
      shared ??= await setup(substrate.make());
      return shared;
    },
    describe
  );
}

describe("E4-U2 membership source typing", () => {
  test("a write-only member cannot be used as a correlated member (type-level)", () => {
    const writeMembers: readonly ForeignKeyMember[] = pairForeignKeyMembers(
      [{ foreignField: "regionId", referencedField: "region" }],
      [literalParentId("eu")]
    );
    // @ts-expect-error a correlated member must name its independent planning source.
    const correlatedMembers: readonly CorrelatedForeignKeyMember[] =
      writeMembers;
    expect(writeMembers[0]?.referencedField).toBe("region");
    expect(correlatedMembers).toHaveLength(1);
  });
});
