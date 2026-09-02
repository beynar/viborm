import { VibORMErrorCode } from "@src/errors";
import type { BoundMigrationDriver } from "@src/migrations/drivers";
import { getMigrationDriver } from "@src/migrations/drivers";
import { SQLite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { planPush } from "@src/migrations/push/planner";
import { buildPushPlan } from "@src/migrations/push-plan";
import { serializeResolvedModels } from "@src/migrations/serializer";
import {
  createAmbiguousChange,
  type SchemaSnapshot,
  type TableDef,
} from "@src/migrations/types";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

const legacyTable: TableDef = {
  name: "legacy",
  columns: [{ name: "id", type: "TEXT", nullable: false }],
  primaryKey: { columns: ["id"] },
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

function snapshotMigrationDriver(snapshot: SchemaSnapshot) {
  const driver = new SQLite3MigrationDriver();
  Object.defineProperty(driver, "introspect", {
    value: () => Promise.resolve(snapshot),
  });
  return driver;
}

function boundSnapshotCommand(snapshot: SchemaSnapshot): {
  producer: ReturnType<typeof sqliteEstateDriver>;
  command: BoundMigrationDriver;
} {
  const producer = sqliteEstateDriver();
  const command: BoundMigrationDriver = Object.create(
    getMigrationDriver(producer)
  );
  Object.defineProperty(command, "introspect", {
    value: () => Promise.resolve(snapshot),
  });
  return { producer, command };
}

describe("push planner destructive resolution", () => {
  test("a destructive callback can proceed, reject, or leave the change unresolved", async () => {
    const current: SchemaSnapshot = { tables: [legacyTable] };
    const driver = snapshotMigrationDriver(current);
    const producer = sqliteEstateDriver();
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);
    const client = { $driver: producer, $schema: schema };

    await expect(
      planPush(
        client,
        driver,
        {
          resolve: (change) =>
            change.type === "destructive" ? change.proceed() : undefined,
        },
        relations
      )
    ).resolves.toMatchObject({
      operations: [expect.objectContaining({ type: "dropTable" })],
    });

    await expect(
      planPush(
        client,
        driver,
        {
          resolve: (change) =>
            change.type === "destructive" ? change.reject() : undefined,
        },
        relations
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("Change rejected"),
    });

    await expect(
      planPush(client, driver, { resolve: () => undefined }, relations)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("Unresolved destructive change"),
    });
  });

  test("force admits an unhandled destructive change while ordinary planning reports it", async () => {
    const driver = snapshotMigrationDriver({ tables: [legacyTable] });
    const producer = sqliteEstateDriver();
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);
    const client = { $driver: producer, $schema: schema };

    await expect(planPush(client, driver, {}, relations)).rejects.toMatchObject(
      {
        code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
        message: expect.stringContaining('Drop table "legacy"'),
      }
    );
    await expect(
      planPush(
        client,
        driver,
        { force: true, resolve: () => undefined },
        relations
      )
    ).resolves.toMatchObject({
      operations: [expect.objectContaining({ type: "dropTable" })],
    });
  });
});

describe("push planner ambiguity resolution", () => {
  const schema = {
    profile: s.model({ id: s.string().id() }).map("profile"),
  };
  hydrateSchemaNames(schema);
  const relations = resolveSchemaOrThrow(schema);
  const serializer = new SQLite3MigrationDriver();
  const desired = serializeResolvedModels(schema, serializer, relations);
  const current: SchemaSnapshot = {
    ...desired,
    tables: desired.tables.map((table) => ({ ...table, name: "account" })),
  };

  test("table ambiguity supports native rename and explicit add-and-drop", async () => {
    const producer = sqliteEstateDriver();
    const driver = snapshotMigrationDriver(current);
    const client = { $driver: producer, $schema: schema };

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
      type: "renameTable",
      from: "account",
      to: "profile",
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
      "dropTable",
      "createTable",
    ]);
  });

  test("table ambiguity rejects explicit refusal and unresolved callbacks", async () => {
    const producer = sqliteEstateDriver();
    const driver = snapshotMigrationDriver(current);
    const client = { $driver: producer, $schema: schema };

    await expect(
      planPush(
        client,
        driver,
        {
          resolve: (change) =>
            change.type === "ambiguous" ? change.reject() : undefined,
        },
        relations
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("Change rejected"),
    });
    await expect(
      planPush(client, driver, { resolve: () => undefined }, relations)
    ).rejects.toMatchObject({
      message: expect.stringContaining("Unresolved ambiguous change"),
    });
  });

  test("force converts an unhandled ambiguity to one admitted add-and-drop pair", async () => {
    const producer = sqliteEstateDriver();
    const driver = snapshotMigrationDriver(current);
    const plan = await planPush(
      { $driver: producer, $schema: schema },
      driver,
      { force: true, resolve: () => undefined },
      relations
    );

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      "dropTable",
      "createTable",
    ]);
  });
});

describe("push plan consent resolution", () => {
  test("records the default destructive decision and replays the exact consent", async () => {
    const current: SchemaSnapshot = { tables: [legacyTable] };
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);
    const first = boundSnapshotCommand(current);
    const recorded = await buildPushPlan(
      { $driver: first.producer, $schema: schema },
      first.producer,
      first.command,
      relations,
      {
        forceReset: false,
        skipValidation: false,
        resolve: undefined,
        dryRun: true,
      },
      { kind: "record", callback: undefined }
    );

    expect(recorded.resolutions).toEqual([
      expect.objectContaining({ decision: "proceed" }),
    ]);
    const second = boundSnapshotCommand(current);
    const replayed = await buildPushPlan(
      { $driver: second.producer, $schema: schema },
      second.producer,
      second.command,
      relations,
      {
        forceReset: false,
        skipValidation: false,
        resolve: undefined,
        dryRun: false,
      },
      { kind: "replay", resolutions: recorded.resolutions }
    );
    expect(replayed.resolutions).toEqual(recorded.resolutions);
    expect(replayed.operations.map((operation) => operation.type)).toEqual([
      "dropTable",
    ]);
  });

  test("reject and cross-kind callback results are closed and authenticated", async () => {
    const current: SchemaSnapshot = { tables: [legacyTable] };
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);
    const rejected = boundSnapshotCommand(current);
    await expect(
      buildPushPlan(
        { $driver: rejected.producer, $schema: schema },
        rejected.producer,
        rejected.command,
        relations,
        {
          forceReset: false,
          skipValidation: false,
          resolve: undefined,
          dryRun: true,
        },
        {
          kind: "record",
          callback: (change) =>
            change.type === "destructive" ? change.reject() : undefined,
        }
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
    });

    const foreign = createAmbiguousChange({
      operation: "renameTable",
      table: "profile",
      oldName: "account",
      newName: "profile",
      description: "foreign decision",
    });
    const invalid = boundSnapshotCommand(current);
    await expect(
      buildPushPlan(
        { $driver: invalid.producer, $schema: schema },
        invalid.producer,
        invalid.command,
        relations,
        {
          forceReset: false,
          skipValidation: false,
          resolve: undefined,
          dryRun: true,
        },
        { kind: "record", callback: () => foreign.rename() }
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
  });

  test("records an ambiguity decision with its complete rename identity", async () => {
    const schema = {
      profile: s.model({ id: s.string().id() }).map("profile"),
    };
    hydrateSchemaNames(schema);
    const relations = resolveSchemaOrThrow(schema);
    const serializer = new SQLite3MigrationDriver();
    const desired = serializeResolvedModels(schema, serializer, relations);
    const current: SchemaSnapshot = {
      ...desired,
      tables: desired.tables.map((table) => ({ ...table, name: "account" })),
    };
    const planned = boundSnapshotCommand(current);

    const plan = await buildPushPlan(
      { $driver: planned.producer, $schema: schema },
      planned.producer,
      planned.command,
      relations,
      {
        forceReset: false,
        skipValidation: false,
        resolve: undefined,
        dryRun: true,
      },
      {
        kind: "record",
        callback: (change) =>
          change.type === "ambiguous" ? change.rename() : undefined,
      }
    );

    expect(plan.resolutions).toEqual([
      expect.objectContaining({ decision: "rename" }),
    ]);
    expect(plan.operations).toContainEqual({
      type: "renameTable",
      from: "account",
      to: "profile",
    });
  });
});

describe("coverage low value", () => {
  test("replay rejects a valid resolution identity with an invalid decision", async () => {
    const current: SchemaSnapshot = { tables: [legacyTable] };
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);
    const first = boundSnapshotCommand(current);
    const recorded = await buildPushPlan(
      { $driver: first.producer, $schema: schema },
      first.producer,
      first.command,
      relations,
      {
        forceReset: false,
        skipValidation: false,
        resolve: undefined,
        dryRun: true,
      },
      { kind: "record", callback: undefined }
    );
    const second = boundSnapshotCommand(current);

    await expect(
      buildPushPlan(
        { $driver: second.producer, $schema: schema },
        second.producer,
        second.command,
        relations,
        {
          forceReset: false,
          skipValidation: false,
          resolve: undefined,
          dryRun: false,
        },
        {
          kind: "replay",
          resolutions: [{ ...recorded.resolutions[0]!, decision: "rename" }],
        }
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
    });
  });
});
