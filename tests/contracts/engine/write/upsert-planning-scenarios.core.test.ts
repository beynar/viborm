import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import type { OperationStep } from "@src/query-engine/write-engine/OperationFragment";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const account = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      score: s.int(),
      notes: s.toMany(() => note),
    })
    .map("upsert_planning_accounts");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      accountId: s.int(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("upsert_planning_notes");
  return { account, note };
})();

hydrateSchemaNames(schema);
validateClientSchemaOrThrow(schema);

function engine(
  mode: "transaction" | "batch",
  dialect: "mysql" | "postgresql" = "postgresql"
): QueryEngine {
  const driver = new PlanningDriver(dialect, {
    supportsTransactions: mode === "transaction",
    supportsBatch: true,
  });
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

function published(
  operation: ExecutableOperation,
  rowsByStep: Readonly<Record<string, readonly Record<string, unknown>[]>>
): Record<string, unknown> {
  return Object.fromEntries(
    operation.planning().steps.flatMap((step) => {
      const rows = rowsByStep[step.id] ?? [];
      return Object.keys(step.outputs).map((output) => [
        `${step.id}.${output}`,
        output === "rows" ? rows : rows[0]?.[output],
      ]);
    })
  );
}

function stepKinds(steps: readonly OperationStep[]): string[] {
  return steps.map((step) => `${step.kind}:${step.id}`);
}

function scalarOperation(mode: "transaction" | "batch", extra = {}) {
  return new UpsertOperation(engine(mode), schema.account, {
    where: { email: "one@example.test" },
    create: { email: "one@example.test", score: 1 },
    update: { score: { increment: 1 } },
    select: { id: true, email: true, score: true },
    ...extra,
  });
}

describe("provider-free top-level upsert planning", () => {
  test("a transaction create arm captures its generated key for the terminal read", () => {
    const operation = scalarOperation("transaction");

    expect(stepKinds(operation.planning().steps)).toEqual([
      "read:account.locate",
    ]);
    const compiled = operation.compile(
      published(operation, { "account.locate": [] })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "write:account.create",
      "read:account.select",
    ]);
    const create = compiled.steps[0];
    expect(create).toMatchObject({
      kind: "write",
      outputs: { id: { kind: "firstRowField", field: "id" } },
      racePin: {
        fields: ["email"],
        table: "upsert_planning_accounts",
      },
    });
    if (!create || create.kind !== "write") {
      throw new Error("expected the generated-key create step");
    }
    expect(create.progressiveContinuation?.kind).toBe("guard");
  });

  test("an atomic returning batch publishes a generated-key create result directly", () => {
    const operation = scalarOperation("batch");
    const compiled = operation.compile(
      published(operation, { "account.locate": [] })
    );

    expect(stepKinds(compiled.steps)).toEqual(["write:account.create"]);
    expect(compiled.steps[0]).toMatchObject({
      outputs: { result: { kind: "rows" } },
      racePin: {
        fields: ["email"],
        table: "upsert_planning_accounts",
      },
    });
  });

  test("a matching conditional pins the located identity before the batch update", () => {
    const operation = scalarOperation("batch", {
      targetWhere: { score: { gt: 0 } },
    });
    const known = published(operation, {
      "account.locate": [{ id: 7 }],
      "account.targetWhere": [{ id: 7 }],
    });
    const compiled = operation.compile(known);

    expect(stepKinds(operation.planning().steps)).toEqual([
      "read:account.locate",
      "read:account.targetWhere",
    ]);
    expect(stepKinds(compiled.steps)).toEqual([
      "guard:account.guard.targetWhere",
      "write:account.update",
    ]);
    expect(compiled.steps[0]).toMatchObject({
      kind: "guard",
      premise: { kind: "exists" },
      failure: { raceable: false },
    });
  });

  test("a failed conditional preserves the captured row and pins the no-match premise", () => {
    const operation = scalarOperation("batch", {
      targetWhere: { score: { gt: 100 } },
    });
    const compiled = operation.compile(
      published(operation, {
        "account.locate": [{ id: 7 }],
        "account.targetWhere": [],
      })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "guard:account.guard.exists",
      "guard:account.guard.targetWhere",
      "read:account.select",
    ]);
    expect(compiled.steps.slice(0, 2)).toMatchObject([
      { premise: { kind: "exists" }, failure: { raceable: false } },
      { premise: { kind: "notExists" }, failure: { raceable: true } },
    ]);
  });
});

describe("relation-bearing top-level upsert arms", () => {
  test("the missing arm delegates the complete fresh relation subtree", () => {
    const operation = new UpsertOperation(
      engine("transaction", "mysql"),
      schema.account,
      {
        where: { email: "fresh@example.test" },
        create: {
          email: "fresh@example.test",
          score: 1,
          notes: { create: { id: 11, body: "fresh note" } },
        },
        update: { score: 2 },
        select: { id: true },
      }
    );
    const compiled = operation.compile(
      published(operation, { "account.locate": [] })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "write:account.create",
      "write:note.create",
      "read:account.select",
    ]);
    expect(compiled.steps[0]).toMatchObject({
      outputs: { id: { kind: "insertId" } },
      racePin: {
        fields: ["email"],
        table: "upsert_planning_accounts",
      },
    });
  });

  test("the found arm validates and compiles a selected relation subtree", () => {
    const operation = new UpsertOperation(engine("batch"), schema.account, {
      where: { email: "found@example.test" },
      create: { email: "found@example.test", score: 0 },
      update: {
        score: 2,
        notes: { create: { id: 12, body: "found note" } },
      },
      select: { id: true, score: true },
    });
    const compiled = operation.compile(
      published(operation, { "account.locate": [{ id: 8, score: 1 }] })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "guard:account.guard.exists",
      "write:account.update",
      "write:note.create",
      "read:account.select",
    ]);
    expect(compiled.steps[0]).toMatchObject({
      premise: { kind: "exists" },
      failure: { raceable: false },
    });
  });
});

describe("coverage low value", () => {
  test("planning publications fail closed when their row carriers are absent", () => {
    const locate = scalarOperation("transaction");
    expect(() => locate.compile({})).toThrow(
      "upsert planning did not expose the locate rows"
    );

    const conditional = scalarOperation("batch", {
      targetWhere: { score: { gt: 0 } },
    });
    const known = published(conditional, {
      "account.locate": [{ id: 7 }],
      "account.targetWhere": [{ id: 7 }],
    });
    known["account.targetWhere.rows"] = undefined;
    expect(() => conditional.compile(known)).toThrow(
      "upsert targetWhere probe did not expose rows"
    );
  });
});
