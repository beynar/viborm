import { createClient } from "@client/client";
import { UnsupportedOperationError } from "@errors";
import { buildCreateManyPlan } from "@query-engine/operations/create";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { createQueryScope } from "@src/query-engine/context/query-scope";
import { CreateManyOperation } from "@src/query-engine/write-engine/CreateManyOperation";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test, vi } from "vitest";

const entry = s
  .model({
    tenantId: s.string(),
    slot: s.string(),
    label: s.string(),
  })
  .id(["tenantId", "slot"])
  .map("create_many_bind_entries");
const tag = s.model({ id: s.string().id() }).map("create_many_bind_tags");
const schema = { entry, tag };

const compoundSchema = (() => {
  const parent = s
    .model({
      region: s.string(),
      code: s.string(),
      children: s.toMany(() => child),
    })
    .id(["region", "code"])
    .map("create_many_bind_parents");
  const child = s
    .model({
      id: s.string().id(),
      parentRegion: s.string(),
      parentCode: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentRegion", "parentCode")
        .references("region", "code"),
    })
    .map("create_many_bind_children");
  return { parent, child };
})();

hydrateSchemaNames(schema);
hydrateSchemaNames(compoundSchema);

function driver(
  dialect: "postgresql" | "sqlite",
  capacity: number | undefined,
  batchOnly = false
): PlanningDriver {
  return new PlanningDriver(dialect, {
    ...(capacity === undefined
      ? {}
      : { maxBindParametersPerStatement: capacity }),
    supportsTransactions: !batchOnly,
    supportsBatch: batchOnly,
  });
}

function engine(capacity: number | undefined): QueryEngine {
  return new QueryEngine(
    driver("postgresql", capacity),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function statementsFromOperation(
  capacity: number | undefined,
  rows: readonly Record<string, unknown>[]
) {
  const operation = new CreateManyOperation(engine(capacity), entry, {
    data: rows,
  });
  return operation.compile({}).steps.map((step) => {
    if (step.kind !== "write") throw new Error("expected a write step");
    return step.statement;
  });
}

describe("createMany bind-budget planning", () => {
  test("the verified budget chooses the largest fitting row prefix", () => {
    const statements = statementsFromOperation(
      6,
      Array.from({ length: 5 }, (_, index) => ({
        tenantId: "tenant",
        slot: `slot-${index}`,
        label: `label-${index}`,
      }))
    );

    expect(statements.map((statement) => statement.values.length)).toEqual([
      6, 6, 3,
    ]);
    expect(statements.flatMap((statement) => statement.values)).toEqual([
      "tenant",
      "slot-0",
      "label-0",
      "tenant",
      "slot-1",
      "label-1",
      "tenant",
      "slot-2",
      "label-2",
      "tenant",
      "slot-3",
      "label-3",
      "tenant",
      "slot-4",
      "label-4",
    ]);
  });

  test("compiled SQL values, not input field count, own the budget", () => {
    const queryEngine = engine(5);
    const plan = buildCreateManyPlan(
      createQueryScope(queryEngine, entry),
      {
        data: [
          {
            tenantId: sql`coalesce(${"tenant-0"}, ${"fallback"})`,
            slot: "slot-0",
            label: "label-0",
          },
          { tenantId: "tenant-1", slot: "slot-1", label: "label-1" },
          { tenantId: "tenant-2", slot: "slot-2", label: "label-2" },
        ],
      },
      false,
      undefined,
      queryEngine.maxBindParametersPerStatement
    );

    expect(plan.statements.map((statement) => statement.inputIndexes)).toEqual([
      [0],
      [1],
      [2],
    ]);
    expect(
      plan.statements.map((statement) => statement.sql.values.length)
    ).toEqual([4, 3, 3]);
  });

  test("an unknown budget preserves the maximal same-shape run", () => {
    const statements = statementsFromOperation(undefined, [
      { tenantId: "t1", slot: "s1", label: "one" },
      { tenantId: "t2", slot: "s2", label: "two" },
      { tenantId: "t3", slot: "s3", label: "three" },
    ]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toHaveLength(9);
  });

  test("compound foreign-key tuples stay whole across a chunk boundary", () => {
    const queryEngine = new QueryEngine(
      driver("sqlite", 6),
      createModelRegistry(compoundSchema, createSchemaRegistry(compoundSchema))
    );
    const operation = constructRoutedOperation(
      queryEngine,
      compoundSchema.parent,
      "create",
      {
        data: {
          region: "eu",
          code: "central",
          children: {
            createMany: {
              data: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
            },
          },
        },
      }
    );
    if (!(operation && "compile" in operation)) {
      throw new Error("expected one ordinary routed create operation");
    }
    const childWrites = operation
      .compile({})
      .steps.filter(
        (step) => step.kind === "write" && step.id.includes("createMany")
      );

    expect(
      childWrites.map((step) => {
        if (step.kind !== "write") throw new Error("expected a write step");
        return step.statement.values;
      })
    ).toEqual([
      ["c1", "eu", "central", "c2", "eu", "central"],
      ["c3", "eu", "central"],
    ]);
  });

  test("an indivisible oversized row refuses before driver I/O", async () => {
    const planningDriver = driver("postgresql", 2);
    const execute = vi.spyOn(planningDriver, "_execute");
    const client = createClient({ schema, driver: planningDriver });

    await expect(
      client.entry.createMany({
        data: [{ tenantId: "t1", slot: "s1", label: "one" }],
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("an oversized transaction member refuses before batch I/O", async () => {
    const planningDriver = driver("postgresql", 2, true);
    const executeBatch = vi.spyOn(planningDriver, "_executeBatch");
    const client = createClient({ schema, driver: planningDriver });

    await expect(
      client.$transaction([
        client.entry.createMany({
          data: [{ tenantId: "t1", slot: "s1", label: "one" }],
        }),
        client.tag.create({ data: { id: "sibling" } }),
      ])
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(executeBatch).not.toHaveBeenCalled();
  });
});
