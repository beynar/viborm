import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import {
  buildPushPlan,
  classifyPlanAtomicity,
  compilePlanStatements,
  hashPushPlan,
  introspectManaged,
} from "@src/migrations/push-plan";
import type { DiffOperation } from "@src/migrations/types";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("push plan helper contracts", () => {
  test("compiles reset clearing before structured effects", () => {
    const producer = sqliteEstateDriver();
    const driver = getMigrationDriver(producer);
    const operations = [
      {
        type: "createTable",
        table: {
          name: "account",
          columns: [{ name: "id", type: "TEXT", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      },
    ] satisfies DiffOperation[];
    const compiled = compilePlanStatements(
      {
        tables: ["legacy"],
        clearTracking: null,
        dropForeignKeys: ["ALTER TABLE child DROP CONSTRAINT child_fk"],
        dropTables: [{ name: "legacy", sql: "DROP TABLE legacy" }],
        dropEnums: ["DROP TYPE status"],
      },
      operations,
      driver,
      emptyManagedSnapshot()
    );

    expect(compiled.statements.map((statement) => statement.kind)).toEqual([
      "clear",
      "clear",
      "clear",
      "effect",
    ]);
    expect(
      compiled.statements.map((statement) => statement.operationId)
    ).toEqual([
      "force-reset:clear:0",
      "force-reset:clear:1",
      "force-reset:clear:2",
      "createTable:0:0",
    ]);
  });

  test("plan hashing is deterministic and sensitive to authenticated structure", () => {
    const producer = sqliteEstateDriver();
    const driver = getMigrationDriver(producer);
    const compiled = compilePlanStatements(
      undefined,
      [],
      driver,
      emptyManagedSnapshot()
    );
    const input = {
      mode: "diff" as const,
      validation: "full" as const,
      target: {
        dialect: "sqlite" as const,
        location: null,
        bindingId: "binding",
      },
      sourceFingerprint: HASH_A,
      desiredFingerprint: HASH_A,
      schemaHash: HASH_A,
      resolutions: [],
      operations: [],
      statements: compiled.statements,
      atomicity: "transactional" as const,
    };

    expect(hashPushPlan(input)).toBe(hashPushPlan({ ...input }));
    expect(hashPushPlan({ ...input, desiredFingerprint: HASH_B })).not.toBe(
      hashPushPlan(input)
    );
    expect(classifyPlanAtomicity(driver, [])).toBe("transactional");
  });

  test("managed introspection removes only private control tables", async () => {
    const producer = sqliteEstateDriver();
    const driver = getMigrationDriver(producer);
    const introspector: typeof driver = Object.create(driver);
    Object.defineProperty(introspector, "introspect", {
      value: () =>
        Promise.resolve({
          tables: [
            {
              name: "_viborm_migration_state",
              columns: [],
              indexes: [],
              foreignKeys: [],
              uniqueConstraints: [],
            },
            {
              name: "_viborm_migration_log",
              columns: [],
              indexes: [],
              foreignKeys: [],
              uniqueConstraints: [],
            },
            {
              name: "account",
              columns: [],
              indexes: [],
              foreignKeys: [],
              uniqueConstraints: [],
            },
          ],
        }),
    });

    const snapshot = await introspectManaged(producer, introspector);
    expect(snapshot.tables.map((table) => table.name)).toEqual(["account"]);
  });

  test("an empty provider-free schema produces a closed immutable no-op plan", async () => {
    const producer = sqliteEstateDriver();
    const command = getMigrationDriver(producer);
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);

    const plan = await buildPushPlan(
      { $driver: producer, $schema: schema },
      producer,
      command,
      relations,
      {
        forceReset: false,
        skipValidation: false,
        resolve: undefined,
        dryRun: true,
      },
      { kind: "record", callback: undefined }
    );

    expect(plan).toMatchObject({
      mode: "diff",
      validation: "full",
      operations: [],
      resolutions: [],
      destructive: false,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.operations)).toBe(true);
  });
});

describe("coverage low value", () => {
  test("replay refuses stale resolution entries after a no-op replan", async () => {
    const producer = sqliteEstateDriver();
    const command = getMigrationDriver(producer);
    const schema = {};
    const relations = resolveSchemaOrThrow(schema);

    await expect(
      buildPushPlan(
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
        {
          kind: "replay",
          resolutions: [{ id: HASH_A, decision: "proceed" }],
        }
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
    });
  });
});
