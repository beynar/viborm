import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";

import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { sql } from "@sql";
import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import type {
  OperationFragment,
  PlanningFragment,
} from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


/**
 * E6.4 unit 0 — the hand-built prototype the plan's rule demands before any code in
 * the compound-identity family moves.
 *
 * The recorded impossibility said the fragment vocabulary "has no tuple form". It
 * conflated one-column-per-OUTPUT with one-output-per-STEP: {@link StatementOutputSource}
 * is declared per OUTPUT NAME, a step's `outputs` is a map, the validator builds its
 * output set from `Object.keys`, and the executor merges every entry. So a locate can
 * declare N `firstRowField` outputs and a later step can address a row by all N.
 *
 * This file proves that end to end, through the real {@link OperationExecutor}, on BOTH
 * substrates, with two one-member decoys live: the write lands on the row BOTH members
 * name, neither decoy moves, and corrupting ONE member makes the write MISS entirely.
 * Nothing here is engine wiring — it is the premise the rest of E6.4 stands on, pinned
 * so a future change to the executor's output merging fails HERE with a small diagnosis
 * instead of somewhere far downstream.
 *
 * What the prototype does NOT prove, and what the family's remaining refusals now name:
 * the ENGINE threads a child's identity as a single value (`childPrimaryKey: string` and
 * the `capturedPk` it addresses writes with, in `RelationWritePart`, `RelationSetPart`,
 * `RelationLinkPart`, `RelationUpsertPart`, `nested-target-parts` and `UpdateOperation`).
 * Widening THAT is the family's remaining work; the vocabulary was never the obstacle.
 */

const schema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      label: s.string(),
      memberships: s.toMany(() => membership),
    })
    .map("e64p_accounts");

  const membership = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      role: s.string(),
      accountId: s.string().nullable(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .id(["tenantId", "slot"])
    .map("e64p_memberships");

  return { account, membership };
})();

/**
 * The hand-built prototype E6.4's rule demands: a locate PLANNING READ that
 * declares TWO `firstRowField` outputs, and a final-fragment UPDATE addressed by
 * BOTH members, resolved per member out of the planning row at compile.
 */
function compoundLocateOperation(
  mode: "transaction" | "batch",
  corrupt?: (row: Record<string, unknown>) => Record<string, unknown>
): ExecutableOperation {
  const locateId = "membership.locate";
  const locateStep = {
    id: locateId,
    kind: "read",
    statement: sql`SELECT "tenantId", "slot" FROM "e64p_memberships" WHERE "role" = ${"target"}`,
    outputs: {
      rows: { kind: "rows" },
      tenantId: { kind: "firstRowField", field: "tenantId" },
      slot: { kind: "firstRowField", field: "slot" },
    },
  } as const;
  return {
    mode,
    planning(): PlanningFragment {
      return {
        steps: [locateStep],
      };
    },
    compile(known): OperationFragment {
      // THE CLAIM: both members arrive, each under its OWN planning key, from the
      // ONE read that declared two `firstRowField` outputs.
      const raw = {
        tenantId: known[planningKey(locateId, "tenantId")],
        slot: known[planningKey(locateId, "slot")],
      };
      const row = corrupt ? corrupt(raw) : raw;
      return {
        steps: [
          {
            id: "membership.update",
            kind: "write",
            statement: sql`UPDATE "e64p_memberships" SET "role" = ${"admin"} WHERE "tenantId" = ${row.tenantId} AND "slot" = ${row.slot}`,
            outputs: { count: { kind: "rowCount" } },
          },
        ],
        outputs: {},
      };
    },
    parse<T>(): T {
      return undefined as T;
    },
  };
}

async function seed(client: any) {
  await syncLiveSchema(client);
  await client.account.create({ data: { id: "a1", label: "L" } });
  // The target row.
  await client.membership.create({
    data: { tenantId: "T", slot: "S", role: "target", accountId: "a1" },
  });
  // Per-member decoys: each agrees with the target on EXACTLY ONE member.
  await client.membership.create({
    data: {
      tenantId: "T",
      slot: "OTHER",
      role: "decoy-tenant",
      accountId: "a1",
    },
  });
  await client.membership.create({
    data: { tenantId: "OTHER", slot: "S", role: "decoy-slot", accountId: "a1" },
  });
}

const substrates = [
  {
    name: "transaction" as const,
    mode: "transaction" as const,
    make: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch" as const,
    mode: "batch" as const,
    make: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
];

for (const substrate of substrates) {
  describe(`E6.4 prototype (${substrate.name})`, () => {
    test("a two-member locate addresses the compound row and misses on a corrupt member", async () => {
      const db = openBorrowedPGlite();
      const client: any = createClient({
        schema,
        driver: new PGliteDriver({ client: db }),
      });
      await seed(client);

      const driver = substrate.make(db);
      const schemas = createSchemaRegistry(schema);
      const engine = new QueryEngine(
        driver,
        createModelRegistry(schema, schemas)
      );

      await new OperationExecutor(engine).execute(
        compoundLocateOperation(substrate.mode),
        createOperationExecutionContext(
          "membership",
          "update",
          engine.instrumentation
        )
      );
      const after = await client.membership.findMany({
        orderBy: [{ tenantId: "asc" }, { slot: "asc" }],
      });
      expect(
        after.find((r: any) => r.tenantId === "T" && r.slot === "S")?.role
      ).toBe("admin");
      // Neither one-member decoy moved.
      expect(
        after.find((r: any) => r.tenantId === "T" && r.slot === "OTHER")?.role
      ).toBe("decoy-tenant");
      expect(
        after.find((r: any) => r.tenantId === "OTHER" && r.slot === "S")?.role
      ).toBe("decoy-slot");
      await client.$disconnect();
    }, 30_000);

    test("corrupting ONE member makes the write miss", async () => {
      const db = openBorrowedPGlite();
      const client: any = createClient({
        schema,
        driver: new PGliteDriver({ client: db }),
      });
      await seed(client);
      const driver = substrate.make(db);
      const schemas = createSchemaRegistry(schema);
      const engine = new QueryEngine(
        driver,
        createModelRegistry(schema, schemas)
      );
      await new OperationExecutor(engine).execute(
        compoundLocateOperation(substrate.mode, (row) => ({
          ...row,
          slot: "NOPE",
        })),
        createOperationExecutionContext(
          "membership",
          "update",
          engine.instrumentation
        )
      );
      const after = await client.membership.findMany();
      // NOTHING moved: the corrupted tuple names no row.
      expect(after.every((r: any) => r.role !== "admin")).toBe(true);
      await client.$disconnect();
    }, 30_000);
  });
}
