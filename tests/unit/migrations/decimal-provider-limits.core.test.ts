/**
 * One provider-domain decision, reached by every schema-to-provider boundary.
 *
 * Client construction already refused an over-limit fixed decimal. These
 * falsifiers close the other public routes: direct serialization, offline
 * generation, and every live push mode. Each refusal must happen before the
 * boundary can read storage, connect, reserve a session, introspect, render, or
 * execute provider SQL.
 */

import { MigrationError, VibORMErrorCode } from "@errors";
import { generate } from "@migrations";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import {
  serializeModels,
  serializeResolvedModels,
} from "@migrations/serializer";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { resolveSchemaOrThrow } from "@schema/validation";
import { SchemaValidationError } from "@schema/validation/error";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";
import {
  MemoryStorage,
  type RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

const PROVIDER_REFUSAL_PATTERN = /ledger\.amount.*maximum precision of 18/;

const wideSchema = () => ({
  ledger: s.model({
    id: s.string().id(),
    amount: s.decimal({ precision: 19, scale: 0 }),
  }),
});

const validSchema = () => ({
  ledger: s.model({
    id: s.string().id(),
    amount: s.decimal({ precision: 18, scale: 0 }),
  }),
});

const duplicateWideSchema = () => {
  const shared = s.model({
    id: s.string().id(),
    amount: s.decimal({ precision: 19, scale: 0 }),
  });
  return { schema: { alpha: shared, beta: shared }, shared };
};

const clientFor = (
  schema:
    | ReturnType<typeof wideSchema>
    | ReturnType<typeof validSchema>
    | ReturnType<typeof duplicateWideSchema>["schema"],
  driver: RecordingDriver
) => ({ $schema: schema, $driver: driver });

function providerRefusal(error: unknown): MigrationError {
  if (!(error instanceof MigrationError)) {
    throw new Error("Expected a migration provider-limit refusal", {
      cause: error,
    });
  }
  return error;
}

function registrationRefusal(error: unknown): SchemaValidationError {
  if (!(error instanceof SchemaValidationError)) {
    throw new Error("Expected the model-registration preflight refusal", {
      cause: error,
    });
  }
  return error;
}

describe("public decimal provider-limit composition roots", () => {
  test("public serializeModels reports M003 before provider admission", () => {
    const { schema, shared } = duplicateWideSchema();
    let error: unknown;

    try {
      serializeModels(schema, { migrationDriver: sqlite3MigrationDriver });
    } catch (failure) {
      error = failure;
    }

    const refusal = registrationRefusal(error);
    expect(refusal.issues).toEqual([
      expect.objectContaining({ code: "M003", model: "beta" }),
    ]);
    expect(refusal.message).not.toMatch(PROVIDER_REFUSAL_PATTERN);
    expect(shared["~"].names.ts).toBeUndefined();
  });

  test("public serializeModels refuses, while the resolved internal seam trusts its caller", () => {
    let error: unknown;
    try {
      serializeModels(wideSchema(), {
        migrationDriver: sqlite3MigrationDriver,
      });
    } catch (failure) {
      error = failure;
    }
    expect(providerRefusal(error)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringMatching(PROVIDER_REFUSAL_PATTERN),
    });

    const resolved = wideSchema();
    hydrateSchemaNames(resolved);
    const snapshot = serializeResolvedModels(
      resolved,
      sqlite3MigrationDriver,
      resolveSchemaOrThrow(resolved)
    );
    expect(
      snapshot.tables[0]?.columns.find((column) => column.name === "amount")
    ).toMatchObject({
      type: "INTEGER",
      decimal: { precision: 19, scale: 0 },
    });
  });

  test("public serializeModels keeps a valid boundary control", () => {
    expect(
      serializeModels(validSchema(), {
        migrationDriver: sqlite3MigrationDriver,
      }).tables[0]?.columns.find((column) => column.name === "amount")
    ).toMatchObject({ type: "INTEGER", decimal: { precision: 18, scale: 0 } });
  });

  test.each([
    ["effectful", false],
    ["dry run", true],
  ] as const)("generate refuses %s before every storage or provider observation", async (_name, dryRun) => {
    const driver = sqliteEstateDriver();
    const storage = new MemoryStorage();
    const error = await generate(clientFor(wideSchema(), driver), storage, {
      name: "wide",
      dryRun,
    }).catch((failure: unknown) => failure);

    expect(providerRefusal(error)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringMatching(PROVIDER_REFUSAL_PATTERN),
    });
    expect(storage.reads).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(driver.statements).toEqual([]);
    expect(driver.sessions).toEqual([]);
  });

  test("generate reports M003 before storage or provider effects", async () => {
    const { schema, shared } = duplicateWideSchema();
    const driver = sqliteEstateDriver();
    const storage = new MemoryStorage();
    const error = await generate(clientFor(schema, driver), storage, {
      name: "duplicate-wide",
    }).catch((failure: unknown) => failure);

    const refusal = registrationRefusal(error);
    expect(refusal.issues).toEqual([
      expect.objectContaining({ code: "M003", model: "beta" }),
    ]);
    expect(refusal.message).not.toMatch(PROVIDER_REFUSAL_PATTERN);
    expect(storage.reads).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(driver.statements).toEqual([]);
    expect(driver.sessions).toEqual([]);
    expect(shared["~"].names.ts).toBeUndefined();
  });

  test("generate keeps a valid control and reaches storage without provider I/O", async () => {
    const driver = sqliteEstateDriver();
    const storage = new MemoryStorage();
    const result = await generate(clientFor(validSchema(), driver), storage, {
      name: "valid",
    });

    expect(result.outcome).toBe("published");
    expect(storage.reads.length).toBeGreaterThan(0);
    expect(storage.writes.length).toBeGreaterThan(0);
    expect(driver.statements).toEqual([]);
  });

  test.each([
    ["dry run", { dryRun: true, force: true }],
    ["effectful", { force: true }],
    ["force reset", { force: true, forceReset: true }],
    ["skip validation", { force: true, skipValidation: true }],
  ] as const)("push refuses %s before connection, reservation, introspection, or effects", async (_name, options) => {
    const driver = sqliteEstateDriver();
    const error = await push(clientFor(wideSchema(), driver), options).catch(
      (failure: unknown) => failure
    );

    expect(providerRefusal(error)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringMatching(PROVIDER_REFUSAL_PATTERN),
    });
    expect(driver.statements).toEqual([]);
    expect(driver.sessions).toEqual([]);
  });

  test.each([
    ["ordinary", { force: true }],
    ["skip validation", { force: true, skipValidation: true }],
  ] as const)("push reports M003 before %s provider effects", async (_name, options) => {
    const { schema, shared } = duplicateWideSchema();
    const driver = sqliteEstateDriver();
    const error = await push(clientFor(schema, driver), options).catch(
      (failure: unknown) => failure
    );

    const refusal = registrationRefusal(error);
    expect(refusal.issues).toEqual([
      expect.objectContaining({ code: "M003", model: "beta" }),
    ]);
    expect(refusal.message).not.toMatch(PROVIDER_REFUSAL_PATTERN);
    expect(driver.statements).toEqual([]);
    expect(driver.sessions).toEqual([]);
    expect(shared["~"].names.ts).toBeUndefined();
  });

  test("push keeps a valid dry-run control and reaches provider introspection", async () => {
    const driver = sqliteEstateDriver();
    const result = await push(clientFor(validSchema(), driver), {
      dryRun: true,
      force: true,
    });

    expect(result.applied).toBe(false);
    expect(result.operations.length).toBeGreaterThan(0);
    expect(driver.statements.length).toBeGreaterThan(0);
  });
});
