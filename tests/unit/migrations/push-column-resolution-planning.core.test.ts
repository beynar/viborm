import { SQLite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { planPush } from "@src/migrations/push/planner";
import { serializeResolvedModels } from "@src/migrations/serializer";
import type { SchemaSnapshot } from "@src/migrations/types";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

function columnSnapshotDriver(snapshot: SchemaSnapshot) {
  const driver = new SQLite3MigrationDriver();
  Object.defineProperty(driver, "introspect", {
    value: () => Promise.resolve(snapshot),
  });
  return driver;
}

function desiredSnapshot<
  Schema extends Parameters<typeof hydrateSchemaNames>[0],
>(schema: Schema) {
  hydrateSchemaNames(schema);
  const relations = resolveSchemaOrThrow(schema);
  const snapshot = serializeResolvedModels(
    schema,
    new SQLite3MigrationDriver(),
    relations
  );
  return { relations, snapshot };
}

describe("push planner column resolution", () => {
  test("column ambiguity supports rename and an admitted add-and-drop pair", async () => {
    const schema = {
      account: s.model({
        id: s.string().id(),
        displayName: s.string(),
      }),
    };
    const { relations, snapshot: desired } = desiredSnapshot(schema);
    const current: SchemaSnapshot = {
      ...desired,
      tables: desired.tables.map((table) => ({
        ...table,
        columns: table.columns.map((column) =>
          column.name === "displayName"
            ? { ...column, name: "legacyName" }
            : column
        ),
      })),
    };
    const producer = sqliteEstateDriver();
    const client = { $driver: producer, $schema: schema };
    const driver = columnSnapshotDriver(current);

    const renamed = await planPush(
      client,
      driver,
      {
        resolve: (change) =>
          change.type === "ambiguous" ? change.rename() : undefined,
      },
      relations
    );
    expect(renamed.operations).toContainEqual({
      type: "renameColumn",
      tableName: "account",
      from: "legacyName",
      to: "displayName",
    });

    const replaced = await planPush(
      client,
      driver,
      {
        resolve: (change) =>
          change.type === "ambiguous" ? change.addAndDrop() : undefined,
      },
      relations
    );
    expect(replaced.operations.map((operation) => operation.type)).toEqual([
      "dropColumn",
      "addColumn",
    ]);
  });

  test("destructive drop-column resolution exposes the exact table and column", async () => {
    const schema = { account: s.model({ id: s.string().id() }) };
    const { relations, snapshot: desired } = desiredSnapshot(schema);
    const current: SchemaSnapshot = {
      ...desired,
      tables: desired.tables.map((table) => ({
        ...table,
        columns: [
          ...table.columns,
          { name: "legacy", type: "TEXT", nullable: true },
        ],
      })),
    };
    const seen: Array<{ table: string; column: string | undefined }> = [];

    const plan = await planPush(
      { $driver: sqliteEstateDriver(), $schema: schema },
      columnSnapshotDriver(current),
      {
        resolve: (change) => {
          if (change.type !== "destructive") return undefined;
          seen.push({ table: change.table, column: change.column });
          return change.proceed();
        },
      },
      relations
    );

    expect(seen).toEqual([{ table: "account", column: "legacy" }]);
    expect(plan.operations).toContainEqual({
      type: "dropColumn",
      tableName: "account",
      columnName: "legacy",
    });
  });

  test("destructive alter-column resolution uses the differ-owned description", async () => {
    const schema = {
      account: s.model({ id: s.string().id(), requiredName: s.string() }),
    };
    const { relations, snapshot: desired } = desiredSnapshot(schema);
    const current: SchemaSnapshot = {
      ...desired,
      tables: desired.tables.map((table) => ({
        ...table,
        columns: table.columns.map((column) =>
          column.name === "requiredName"
            ? { ...column, nullable: true }
            : column
        ),
      })),
    };
    const descriptions: string[] = [];

    const plan = await planPush(
      { $driver: sqliteEstateDriver(), $schema: schema },
      columnSnapshotDriver(current),
      {
        resolve: (change) => {
          if (change.type !== "destructive") return undefined;
          descriptions.push(change.description);
          return change.proceed();
        },
      },
      relations
    );

    expect(plan.operations.map((operation) => operation.type)).toContain(
      "alterColumn"
    );
    expect(descriptions.join("\n")).toContain("requiredName");
  });
});
