import { PostgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { VibORMErrorCode } from "@src/errors";
import type { BoundMigrationDriver } from "@src/migrations/drivers";
import { getMigrationDriver } from "@src/migrations/drivers";
import { planPush } from "@src/migrations/push/planner";
import { buildPushPlan } from "@src/migrations/push-plan";
import { serializeResolvedModels } from "@src/migrations/serializer";
import {
  createAmbiguousChange,
  type ResolveCallback,
  type SchemaSnapshot,
} from "@src/migrations/types";
import type { PushResolution } from "@src/migrations/v1-types";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { RecordingDriver } from "./_estate";

const AMBIGUITY_THEN_ENUM = /old_account[\s\S]*enumValueRemoval/;

function postgresProducer(postgis = false): RecordingDriver {
  const producer = new RecordingDriver(
    "postgresql",
    "pg",
    new PostgresAdapter("public", postgis)
  );
  producer.respond = (statement) =>
    statement.includes("current_database()") ? [{ database: "app" }] : [];
  return producer;
}

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

function currentWithRetiredValue(desired: SchemaSnapshot): SchemaSnapshot {
  return {
    ...desired,
    enums: desired.enums?.map((enumDef) =>
      enumDef.name === "resolution_status"
        ? { ...enumDef, values: ["active", "retired"] }
        : enumDef
    ),
  };
}

async function planEnumRemoval(options: {
  readonly nullable: boolean;
  readonly callback?: ResolveCallback;
  readonly resolutions?: readonly PushResolution[];
}) {
  const status = options.nullable
    ? s.enum(["active"]).name("resolution_status").nullable()
    : s.enum(["active"]).name("resolution_status");
  const schema = {
    account: s.model({ id: s.string().id(), status }),
  };
  hydrateSchemaNames(schema);
  const relations = resolveSchemaOrThrow(schema);
  const serializer = getMigrationDriver(postgresProducer());
  const desired = serializeResolvedModels(schema, serializer, relations);
  const producer = postgresProducer();
  const command = commandReading(producer, currentWithRetiredValue(desired));
  const plan = await buildPushPlan(
    { $driver: producer, $schema: schema },
    producer,
    command,
    relations,
    {
      forceReset: false,
      skipValidation: false,
      resolve: options.callback,
      dryRun: true,
    },
    options.resolutions
      ? { kind: "replay", resolutions: options.resolutions }
      : { kind: "record", callback: options.callback }
  );
  return { plan, producer };
}

describe("push enum consent closure", () => {
  test("reports table ambiguity and enum removal together before resolution", async () => {
    const schema = {
      account: s.model({
        id: s.string().id(),
        status: s.enum(["active"]).name("resolution_status"),
      }),
    };
    hydrateSchemaNames(schema);
    const relations = resolveSchemaOrThrow(schema);
    const producer = postgresProducer();
    const serializer = getMigrationDriver(producer);
    const desired = serializeResolvedModels(schema, serializer, relations);
    const currentWithEnum = currentWithRetiredValue(desired);
    const current: SchemaSnapshot = {
      ...currentWithEnum,
      tables: currentWithEnum.tables.map((table) => ({
        ...table,
        name: "old_account",
      })),
    };

    await expect(
      planPush(
        { $driver: producer, $schema: schema },
        commandReading(producer, current),
        {},
        relations
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringMatching(AMBIGUITY_THEN_ENUM),
    });
  });

  test("records and replays an exact per-column enum mapping", async () => {
    const recorded = await planEnumRemoval({
      nullable: false,
      callback: (change) =>
        change.type === "enumValueRemoval"
          ? change.mapValues({ retired: "active" })
          : undefined,
    });

    expect(recorded.plan.resolutions).toEqual([
      expect.objectContaining({
        decision: 'map:{"retired":"active"}',
      }),
    ]);
    expect(recorded.plan.operations).toContainEqual(
      expect.objectContaining({
        type: "alterEnum",
        columnValueReplacements: {
          "account.status": { retired: "active" },
        },
      })
    );

    const replayed = await planEnumRemoval({
      nullable: false,
      resolutions: recorded.plan.resolutions,
    });
    expect(replayed.plan.resolutions).toEqual(recorded.plan.resolutions);
    expect(replayed.plan.operations).toEqual(recorded.plan.operations);
  });

  test("maps a nullable enum removal to NULL without asking for consent", async () => {
    const presented: string[] = [];
    const planned = await planEnumRemoval({
      nullable: true,
      callback: (change) => {
        presented.push(change.type);
        return;
      },
    });

    expect(presented).not.toContain("enumValueRemoval");
    expect(planned.plan.resolutions).toEqual([]);
    expect(planned.plan.operations).toContainEqual(
      expect.objectContaining({
        type: "alterEnum",
        defaultReplacement: null,
        columnValueReplacements: {
          "account.status": { retired: null },
        },
      })
    );
  });

  test("refuses NULL consent for a non-nullable enum column", async () => {
    await expect(
      planEnumRemoval({
        nullable: false,
        callback: (change) =>
          change.type === "enumValueRemoval" ? change.useNull() : undefined,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("non-nullable enum column"),
    });
  });

  test("dispatches desired-schema requirements through the active producer", async () => {
    const schema = {
      place: s.model({ id: s.string().id(), location: s.point() }),
    };
    hydrateSchemaNames(schema);
    const relations = resolveSchemaOrThrow(schema);
    const producer = postgresProducer(true);
    producer.respond = (statement) =>
      statement.includes("current_database()")
        ? [{ database: "app" }]
        : statement.includes("WITH postgis")
          ? [{ ready: true }]
          : [];
    const serializer = getMigrationDriver(producer);
    const desired = serializeResolvedModels(schema, serializer, relations);
    const command = commandReading(producer, desired);

    const plan = await buildPushPlan(
      { $driver: producer, $schema: schema },
      producer,
      command,
      relations,
      {
        forceReset: false,
        skipValidation: true,
        resolve: undefined,
        dryRun: true,
      },
      { kind: "record", callback: undefined }
    );

    expect(plan.validation).toBe("structural-only");
    expect(
      producer.statements.some((statement) =>
        statement.includes("WITH postgis")
      )
    ).toBe(true);
  });
});

describe("coverage low value", () => {
  test.each([
    ["map:{", "malformed enum resolution"],
    [
      'map:{"retired":"active", "unused":null}',
      "non-canonical enum resolution",
    ],
    ['map:{"retired":1}', "only strings or null"],
  ])("refuses a replayed %s decision", async (decision, message) => {
    const recorded = await planEnumRemoval({
      nullable: false,
      callback: (change) =>
        change.type === "enumValueRemoval"
          ? change.mapValues({ retired: "active" })
          : undefined,
    });
    const resolution = recorded.plan.resolutions[0];
    if (!resolution) throw new Error("expected one enum resolution");

    await expect(
      planEnumRemoval({
        nullable: false,
        resolutions: [{ ...resolution, decision }],
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
      message: expect.stringContaining(message),
    });
  });

  test("refuses a cross-kind result and an unauthenticated enumMapped result", async () => {
    const ambiguity = createAmbiguousChange({
      operation: "renameTable",
      table: "account",
      oldName: "old_account",
      newName: "account",
      description: "foreign ambiguity",
    });
    await expect(
      planEnumRemoval({
        nullable: false,
        callback: (change) =>
          change.type === "enumValueRemoval" ? ambiguity.rename() : undefined,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await expect(
      planEnumRemoval({
        nullable: false,
        callback: (change) =>
          change.type === "enumValueRemoval" ? "enumMapped" : undefined,
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
  });
});
