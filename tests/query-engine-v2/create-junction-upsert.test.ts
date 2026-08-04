import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "../../src/query-engine/write-engine/CreateOperation";
import type {
  OperationStep,
  StatementStep,
} from "../../src/query-engine/write-engine/OperationFragment";
import {
  createJunctionUpsertSchema,
  registerCreateJunctionUpsertBehavior,
} from "./create-junction-upsert-behavior";

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
  let shared: any;
  registerCreateJunctionUpsertBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: createJunctionUpsertSchema,
        driver: substrate.make(),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

function writeSteps(steps: readonly OperationStep[]): readonly StatementStep[] {
  return steps.filter((step): step is StatementStep => step.kind === "write");
}

function sqlOf(step: { statement: { strings: readonly string[] } }): string {
  return step.statement.strings.join("?");
}

function operationFor(data: Record<string, unknown>): CreateOperation {
  const schemas = createSchemaRegistry(createJunctionUpsertSchema);
  const engine = new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(createJunctionUpsertSchema, schemas)
  );
  return new CreateOperation(engine, createJunctionUpsertSchema.article, {
    data,
  });
}

const ADOPT_UPSERT = {
  topics: {
    upsert: {
      where: { name: "t" },
      create: { name: "t", weight: 1 },
      update: { weight: 2 },
    },
  },
};

const TARGET_SELECT = /FROM "e5u1_topics"/;
const JUNCTION_TABLE = /article_topic/i;
const ANY_INSERT = /INSERT\s+INTO/;
const TARGET_UPDATE = /UPDATE "e5u1_topics"/;
const TARGET_INSERT = /INSERT INTO "e5u1_topics"/;

describe("E5-U1 the fresh-parent upsert plans and compiles as an adopt", () => {
  test("planning reads the GLOBAL probe only — no membership read", () => {
    const planning = operationFor({ title: "x", ...ADOPT_UPSERT }).planning();
    const reads = planning.steps.filter((step) => step.kind === "read");
    // One read, and it is the uncorrelated lookup by the arm's own unique. A membership
    // read would name the junction table and correlate on a parent that does not exist.
    expect(reads).toHaveLength(1);
    const statement = sqlOf(reads[0] as StatementStep);
    expect(statement).toMatch(TARGET_SELECT);
    expect(statement).not.toMatch(JUNCTION_TABLE);
  });

  test("FOUND emits the join row even when the update payload is empty", () => {
    const operation = operationFor({
      title: "x",
      topics: {
        upsert: {
          where: { name: "t" },
          create: { name: "t", weight: 1 },
          update: {},
        },
      },
    });
    const compiled = operation.compile({ "topic.find.rows": [{ id: 11 }] });
    const writes = writeSteps(compiled.steps);
    // The parent INSERT and the join row — and nothing else: no target UPDATE, no
    // target INSERT.
    expect(
      writes.map(sqlOf).filter((sql) => ANY_INSERT.test(sql))
    ).toHaveLength(2);
    expect(writes.some((step) => TARGET_UPDATE.test(sqlOf(step)))).toBe(false);
    expect(writes.some((step) => step.id.includes("junction.insert"))).toBe(
      true
    );
  });

  test("FOUND emits the target UPDATE and then the join row", () => {
    const operation = operationFor({ title: "x", ...ADOPT_UPSERT });
    const compiled = operation.compile({ "topic.find.rows": [{ id: 11 }] });
    const writes = writeSteps(compiled.steps);
    const updateAt = writes.findIndex((step) =>
      TARGET_UPDATE.test(sqlOf(step))
    );
    const joinAt = writes.findIndex((step) =>
      step.id.includes("junction.insert")
    );
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(joinAt).toBeGreaterThan(updateAt);
  });

  test("ABSENT pins the missing premise on the target INSERT, and only there", () => {
    const operation = operationFor({ title: "x", ...ADOPT_UPSERT });
    const compiled = operation.compile({ "topic.find.rows": [] });
    const pinned = writeSteps(compiled.steps).filter(
      (step) => step.racePin !== undefined
    );
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.racePin).toMatchObject({
      table: "e5u1_topics",
      fields: ["name"],
    });
    expect(sqlOf(pinned[0] as StatementStep)).toMatch(TARGET_INSERT);
  });

  test("the join row references the INSERT that made the target, not a re-derived key", () => {
    // WRONG-ROW PROVENANCE at compile: the target's key is DB-generated, so the join
    // row must address the producing step's output. A literal here would be a value
    // nothing produced.
    const operation = operationFor({ title: "x", ...ADOPT_UPSERT });
    const compiled = operation.compile({ "topic.find.rows": [] });
    const writes = writeSteps(compiled.steps);
    const producing = writes.find((step) => TARGET_INSERT.test(sqlOf(step)));
    const join = writes.find((step) => step.id.includes("junction.insert"));
    expect(producing).toBeDefined();
    const referenced = JSON.stringify(join?.statement.values ?? [], (_k, v) =>
      typeof v === "bigint" ? String(v) : v
    );
    expect(referenced).toContain(producing?.id);
  });
});
