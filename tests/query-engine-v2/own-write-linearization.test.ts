import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe, expect, test } from "vitest";
import { RELATION_MUTATION_KEYS } from "../../src/query-engine/builders/relation-mutation-parser";
import { planRelationMutationSteps } from "../../src/query-engine/RelationMutationPlan";
import {
  linearizationSchema,
  runOwnWriteLinearizationBehavior,
} from "./own-write-linearization-behavior";

/**
 * N6-U3 on PGlite, on BOTH substrates, plus the structural claims the behaviour
 * suite cannot see: that there is exactly ONE order and that the legality
 * derivation walks it.
 */
class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

describe("N6-U3 — own-write linearization (PGlite)", () => {
  runOwnWriteLinearizationBehavior({
    name: "PGlite transaction",
    createDriver: () => new PGliteDriver({ client: new PGlite() }),
  });
  runOwnWriteLinearizationBehavior({
    name: "PGlite atomic batch",
    createDriver: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  });
});

describe("N6-U3 — one order, one derivation (ATOM §4.1)", () => {
  test("the linearization order is the documented sequence", () => {
    // The order is doctrine (ATOM §4.1), so it is pinned rather than merely used.
    // Changing it is a doctrine change and must fail here first.
    expect([...RELATION_MUTATION_KEYS]).toEqual([
      "disconnect",
      "delete",
      "update",
      "upsert",
      "connectOrCreate",
      "set",
      "updateMany",
      "deleteMany",
      "connect",
      "create",
      "createMany",
    ]);
  });

  test("the legality derivation walks the SAME order the parts are emitted in", () => {
    // The tripwire for the fork this unit deleted. `planRelationMutationSteps` used to
    // carry its own if-chain order, which disagreed with `RELATION_MUTATION_KEYS` on
    // `deleteMany` vs `upsert`; a shape's soundness was therefore derived against a
    // sequence the engine never executed. Reintroducing any second order fails here.
    const relationInfo = {
      name: "notes",
      targetModel: linearizationSchema.note,
      isToOne: false,
      isToMany: true,
      type: "oneToMany",
    };
    const steps = planRelationMutationSteps(
      "notes",
      {
        // biome-ignore lint/suspicious/noExplicitAny: the plan reads relation METADATA only
        relationInfo: relationInfo as any,
        payload: {},
        disconnect: [{ id: 1 }],
        delete: [{ id: 2 }],
        update: [{ where: { id: 3 }, data: { body: "u" } }],
        upsert: [{ where: { id: 4 }, create: { id: 4 }, update: {} }],
        connectOrCreate: [{ where: { id: 5 }, create: { id: 5 } }],
        set: [{ id: 6 }],
        updateMany: [{ where: { id: 7 }, data: { body: "m" } }],
        deleteMany: [{ id: 8 }],
        connect: [{ id: 9 }],
        create: [{ id: 10, body: "c" }],
        createMany: { data: [{ id: 11, body: "cm" }] },
      },
      "after"
    );
    expect(steps.map((step) => step.kind)).toEqual([
      ...RELATION_MUTATION_KEYS,
    ]);
  });
});
