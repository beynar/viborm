import { PostgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { PostgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { planPush } from "@src/migrations/push/planner";
import { serializeResolvedModels } from "@src/migrations/serializer";
import type { SchemaSnapshot } from "@src/migrations/types";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { RecordingDriver } from "./_estate";

const schema = {
  user: s
    .model({ id: s.string().id(), active: s.boolean() })
    .map("users")
    .index(["active"], {
      name: "users_active_idx",
      where: "active = true",
    }),
};

hydrateSchemaNames(schema);

class PredicatePlannerDriver extends PostgresMigrationDriver {
  current: SchemaSnapshot = { tables: [] };
  shouldFail = false;
  readonly calls: {
    tableName: string;
    predicates: readonly string[];
  }[] = [];

  override async introspect(): Promise<SchemaSnapshot> {
    return this.current;
  }

  override async canonicalizeIndexPredicates(
    tableName: string,
    predicates: readonly string[],
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ): Promise<ReadonlyArray<string | undefined>> {
    this.calls.push({ tableName, predicates });
    await executeRaw("SELECT predicate normalization");
    if (this.shouldFail) throw new Error("normalization unavailable");
    return predicates.map(() => "active = true");
  }
}

function currentWithCatalogPredicate(
  driver: PredicatePlannerDriver
): SchemaSnapshot {
  const relations = resolveSchemaOrThrow(schema);
  const desired = serializeResolvedModels(schema, driver, relations);
  return {
    ...desired,
    tables: desired.tables.map((table) => ({
      ...table,
      indexes: table.indexes.map((index) => ({
        ...index,
        where: index.where === undefined ? undefined : "(active = true)",
      })),
    })),
  };
}

describe("push planner predicate normalization", () => {
  test("normalizes the current and desired predicates in one transaction", async () => {
    const producer = new RecordingDriver(
      "postgresql",
      "pg",
      new PostgresAdapter()
    );
    const migrationDriver = new PredicatePlannerDriver();
    migrationDriver.current = currentWithCatalogPredicate(migrationDriver);
    const relations = resolveSchemaOrThrow(schema);

    const plan = await planPush(
      { $driver: producer, $schema: schema },
      migrationDriver,
      {},
      relations
    );

    expect(plan.operations).toEqual([]);
    expect(migrationDriver.calls).toEqual([
      {
        tableName: "users",
        predicates: ["(active = true)", "active = true"],
      },
    ]);
    expect(producer.statements).toContain("<begin>");
    expect(producer.statements).toContain("SELECT predicate normalization");
  });

  test("fails closed to index replacement when normalization fails", async () => {
    const producer = new RecordingDriver(
      "postgresql",
      "pg",
      new PostgresAdapter()
    );
    const migrationDriver = new PredicatePlannerDriver();
    migrationDriver.current = currentWithCatalogPredicate(migrationDriver);
    migrationDriver.shouldFail = true;
    const relations = resolveSchemaOrThrow(schema);

    const plan = await planPush(
      { $driver: producer, $schema: schema },
      migrationDriver,
      { force: true },
      relations
    );

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      "dropIndex",
      "createIndex",
    ]);
  });
});
