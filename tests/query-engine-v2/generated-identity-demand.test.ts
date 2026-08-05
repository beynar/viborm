import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "../../src/query-engine/write-engine/CreateOperation";
import type { WriteStep } from "../../src/query-engine/write-engine/OperationFragment";
import { StepScope } from "../../src/query-engine/write-engine/StepScope";
import { producedIdentitySchema } from "./produced-identity-depth-behavior";

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

function createEngine(driver: AnyDriver): QueryEngine {
  const schemas = createSchemaRegistry(producedIdentitySchema);
  return new QueryEngine(
    driver,
    createModelRegistry(producedIdentitySchema, schemas)
  );
}

function createNestedSquad(
  driver: AnyDriver,
  data: Record<string, unknown>
): CreateOperation {
  return new CreateOperation(
    createEngine(driver),
    producedIdentitySchema.squad,
    {},
    {
      scope: new StepScope(),
      skipOwnWrite: true,
      nestedFresh: {
        data,
        rootFkInject: () => ({}),
      },
    }
  );
}

function rootWrite(operation: CreateOperation): WriteStep {
  const step = operation
    .compile({})
    .steps.find((candidate) => candidate.id === "squad.create");
  if (step?.kind !== "write") {
    throw new Error("Expected the nested squad root write.");
  }
  return step;
}

describe("generated identity capture follows real consumers", () => {
  for (const substrate of [
    { name: "transaction", createDriver: () => new PGliteDriver() },
    { name: "atomic batch", createDriver: () => new BatchOnlyPGliteDriver() },
  ]) {
    test(`an unused nested identity emits a plain INSERT (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = createNestedSquad(driver, {
        code: "unused",
        title: "unused",
        orgId: 1,
      });
      const write = rootWrite(operation);

      expect(write.outputs).toEqual({});
      expect(driver._prepare(write.statement).sql).not.toContain("RETURNING");
    });

    test(`an external edge keeps identity capture (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = createNestedSquad(driver, {
        code: "external",
        title: "external",
        orgId: 1,
      });

      expect(operation.freshRootReferenced("id")).toBeDefined();
      expect(rootWrite(operation).outputs.id).toBeDefined();
    });

    test(`a descendant keeps identity capture (${substrate.name})`, () => {
      const operation = createNestedSquad(substrate.createDriver(), {
        code: "descendant",
        title: "descendant",
        orgId: 1,
        drills: { create: { text: "child" } },
      });

      expect(rootWrite(operation).outputs.id).toBeDefined();
    });
  }
});
