import { PostgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { VibORMErrorCode } from "@src/errors";
import type { BoundMigrationDriver } from "@src/migrations/drivers";
import { getMigrationDriver } from "@src/migrations/drivers";
import { SQLite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { buildPushPlan } from "@src/migrations/push-plan";
import { serializeResolvedModels } from "@src/migrations/serializer";
import {
  createDestructiveChange,
  type ResolveCallback,
  type SchemaSnapshot,
} from "@src/migrations/types";
import type { PushResolution } from "@src/migrations/v1-types";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { RecordingDriver, sqliteEstateDriver } from "./_estate";

const UNRELATED_RESOLUTION_ID = "0".repeat(64);

const foreignDestructive = createDestructiveChange({
  operation: "dropTable",
  table: "somewhere_else",
  description: "a decision that belongs to another change",
});

function commandReading(
  producer: RecordingDriver,
  snapshot: SchemaSnapshot
): BoundMigrationDriver {
  const command: BoundMigrationDriver = Object.create(
    getMigrationDriver(producer)
  );
  Object.defineProperty(command, "introspect", {
    value: () => Promise.resolve(snapshot),
  });
  return command;
}

// One renamed table is the smallest input the differ reports as ambiguous:
// the shapes match exactly, so only a human can say rename versus replace.
const ambiguousSchema = {
  profile: s.model({ id: s.string().id() }).map("profile"),
};
hydrateSchemaNames(ambiguousSchema);
const ambiguousRelations = resolveSchemaOrThrow(ambiguousSchema);
const ambiguousDesired = serializeResolvedModels(
  ambiguousSchema,
  new SQLite3MigrationDriver(),
  ambiguousRelations
);
const ambiguousCurrent: SchemaSnapshot = {
  ...ambiguousDesired,
  tables: ambiguousDesired.tables.map((table) => ({
    ...table,
    name: "account",
  })),
};

function planAmbiguity(source: {
  readonly callback?: ResolveCallback;
  readonly resolutions?: readonly PushResolution[];
}) {
  const producer = sqliteEstateDriver();
  return buildPushPlan(
    { $driver: producer, $schema: ambiguousSchema },
    producer,
    commandReading(producer, ambiguousCurrent),
    ambiguousRelations,
    {
      forceReset: false,
      skipValidation: false,
      resolve: source.callback,
      dryRun: true,
    },
    source.resolutions
      ? { kind: "replay", resolutions: source.resolutions }
      : { kind: "record", callback: source.callback }
  );
}

function postgresProducer(): RecordingDriver {
  const producer = new RecordingDriver(
    "postgresql",
    "pg",
    new PostgresAdapter("public", false)
  );
  producer.respond = (statement) =>
    statement.includes("current_database()") ? [{ database: "app" }] : [];
  return producer;
}

const enumSchema = {
  account: s.model({
    id: s.string().id(),
    status: s.enum(["active"]).name("resolution_status"),
  }),
};
hydrateSchemaNames(enumSchema);
const enumRelations = resolveSchemaOrThrow(enumSchema);

function planEnumRemoval(source: {
  readonly callback?: ResolveCallback;
  readonly resolutions?: readonly PushResolution[];
}) {
  const producer = postgresProducer();
  const desired = serializeResolvedModels(
    enumSchema,
    getMigrationDriver(postgresProducer()),
    enumRelations
  );
  const current: SchemaSnapshot = {
    ...desired,
    enums: desired.enums?.map((enumDef) =>
      enumDef.name === "resolution_status"
        ? { ...enumDef, values: ["active", "retired"] }
        : enumDef
    ),
  };
  return buildPushPlan(
    { $driver: producer, $schema: enumSchema },
    producer,
    commandReading(producer, current),
    enumRelations,
    {
      forceReset: false,
      skipValidation: false,
      resolve: source.callback,
      dryRun: true,
    },
    source.resolutions
      ? { kind: "replay", resolutions: source.resolutions }
      : { kind: "record", callback: source.callback }
  );
}

describe("push plan resolution arms", () => {
  test("an ambiguity with no resolve callback is left unresolved and refused", async () => {
    await expect(planAmbiguity({})).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("Unresolved ambiguous change"),
    });
  });

  test("an add-and-drop ambiguity is recorded and replayed as the same program", async () => {
    const recorded = await planAmbiguity({
      callback: (change) =>
        change.type === "ambiguous" ? change.addAndDrop() : undefined,
    });

    expect(recorded.resolutions).toEqual([
      expect.objectContaining({ decision: "addAndDrop" }),
    ]);
    expect(recorded.operations.map((operation) => operation.type)).toEqual([
      "dropTable",
      "createTable",
    ]);

    const replayed = await planAmbiguity({
      resolutions: recorded.resolutions,
    });
    expect(replayed.resolutions).toEqual(recorded.resolutions);
    expect(replayed.operations).toEqual(recorded.operations);
  });

  test("a decision produced by another change cannot authorize an ambiguity", async () => {
    await expect(
      planAmbiguity({
        callback: (change) =>
          change.type === "ambiguous"
            ? foreignDestructive.proceed()
            : undefined,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("invalid resolution result"),
    });
  });

  test.each([
    { name: "omits", resolutions: [] },
    {
      name: "misnames",
      resolutions: [{ id: UNRELATED_RESOLUTION_ID, decision: "rename" }],
    },
  ])("a locked push whose consent $name a requested resolution is refused", async ({
    resolutions,
  }) => {
    await expect(planAmbiguity({ resolutions })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
      message: expect.stringContaining("different set of resolutions"),
    });
  });

  test("a replayed NULL consent cannot resolve a non-nullable enum column", async () => {
    const recorded = await planEnumRemoval({
      callback: (change) =>
        change.type === "enumValueRemoval"
          ? change.mapValues({ retired: "active" })
          : undefined,
    });
    const resolution = recorded.resolutions[0];
    if (!resolution) throw new Error("expected one enum resolution");

    await expect(
      planEnumRemoval({
        resolutions: [{ ...resolution, decision: "useNull" }],
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
      message: expect.stringContaining("invalid for the locked request"),
    });
  });
});
