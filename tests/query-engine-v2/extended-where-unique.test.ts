import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import type { StatementStep } from "../../src/query-engine-v2/OperationFragment";
import { UpsertOperation } from "../../src/query-engine-v2/UpsertOperation";
import {
  extendedWhereUniqueSchema,
  runExtendedWhereUniqueBehavior,
} from "./extended-where-unique-behavior";

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

// The whole extended-whereUnique surface on PGlite, both substrates. The driver
// matrix legs run the same module from tests/drivers/*.test.ts.
runExtendedWhereUniqueBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runExtendedWhereUniqueBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// STRUCTURAL: the create arm's racePin, and its deliberate absence.
//
// The behavior suite proves the V3001 surfaces. This proves WHY it is not
// retried: with an extended `where` the locate never established the "unique key
// K is free" premise a `racePin` claims, so the pin is withheld and the
// violation is classified as the genuine conflict it is. The plain-`where` arm
// is the falsification — it must still carry the pin, or the assertion above
// would pass for the wrong reason (a pin nobody ever attaches).
// ---------------------------------------------------------------------------

function buildUpsertSteps(where: Record<string, unknown>): StatementStep[] {
  const schemas = createSchemaRegistry(extendedWhereUniqueSchema);
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(extendedWhereUniqueSchema, schemas)
  );
  const operation = new UpsertOperation(
    engine,
    extendedWhereUniqueSchema.account,
    {
      where,
      create: { id: 9, email: "gone@x", status: "active", score: 0 },
      update: { score: { increment: 1 } },
      select: { id: true },
    }
  );
  // An empty locate result is the create arm — the exact branch under test.
  const fragment = operation.compile({
    [`${operation.planning().steps[0]!.id}.rows`]: [],
  });
  return fragment.steps.filter(
    (step): step is StatementStep => step.kind === "write"
  );
}

test("a PLAIN unique where pins the create arm as raceable", () => {
  const writes = buildUpsertSteps({ email: "gone@x" });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.racePin).toBeDefined();
  expect(writes[0]?.racePin?.fields).toEqual(["email"]);
});

test("an EXTENDED unique where withholds the create-arm racePin", () => {
  const writes = buildUpsertSteps({ email: "gone@x", status: "active" });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.racePin).toBeUndefined();
});

test("the withheld pin is about the FILTER, not the discriminator's shape", () => {
  // Same discriminator, filter smuggled through AND: still withheld.
  const writes = buildUpsertSteps({
    email: "gone@x",
    AND: [{ status: "active" }],
  });
  expect(writes[0]?.racePin).toBeUndefined();
});
