import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import {
  type CorrelatedForeignKeyMember,
  type ForeignKeyMember,
  pairForeignKeyMembers,
} from "@src/query-engine/write-engine/foreign-key-reference";
import { literalParentId } from "@src/query-engine/write-engine/RelationUpsertPart";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "@tests/contracts/engine/write/compound-relation-adoption-behavior";

async function setup(driver: PGliteDriver) {
  const client = createClient({ schema: compoundAdoptSchema, driver }) as any;
  await push(client, { force: true });
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
  registerCompoundAdoptBehavior(substrate.name, async () => {
    shared ??= await setup(substrate.make());
    return shared;
  });
}

describe("E4-U2 the boundary the per-field source did not move", () => {
  test("the many-to-many junction keeps the single-parent-column refusal", async () => {
    // `edgeParentId` still exists, and still refuses arity > 1 — for the junction, whose
    // join row keys its parent half with ONE column
    // (`getManyToManyJoinInfo` → `getRequiredSinglePrimaryKeyField`). The message is the
    // same sentence; what changed is that only the m2m branch can still reach it.
    const source = await import(
      "@src/query-engine/write-engine/CreateOperation"
    );
    expect(typeof source.CreateOperation).toBe("function");
    const text = await (await import("node:fs/promises")).readFile(
      `${SOURCE_ROOT}/query-engine/write-engine/CreateOperation.ts`,
      "utf8"
    );
    // The adopt kinds no longer call it; the junction does. One caller, one reason.
    const junctionCalls = text.split("this.edgeParentId(").length - 1;
    expect(junctionCalls).toBe(1);
  });

  test("a write-only member cannot be used as a correlated member (type-level)", () => {
    const writeMembers: readonly ForeignKeyMember[] = pairForeignKeyMembers(
      ["regionId"],
      ["region"],
      [literalParentId("eu")]
    );
    // @ts-expect-error a correlated member must name its independent planning source.
    const correlatedMembers: readonly CorrelatedForeignKeyMember[] =
      writeMembers;
    expect(writeMembers[0]?.referencedField).toBe("region");
    expect(correlatedMembers).toHaveLength(1);
  });
});
