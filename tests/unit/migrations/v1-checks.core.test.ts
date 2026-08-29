import { sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "@src/errors";
import {
  assertManualStepwiseProof,
  classifyStoredAtomicity,
  compileGeneratedTransition,
  compileManualTransition,
  compileTrustedCheck,
  rebindChecks,
} from "@src/migrations/compile";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { evaluateCheck } from "@src/migrations/execute-dispatch";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("migration v1 checks", () => {
  test("stepwise manual work without origin and destination checks refuses before dispatch", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      { kind: "irreversible", reason: "none" },
      "sqlite",
      "stepwise",
      undefined,
      assembly
    );
    expect(() => assertManualStepwiseProof(compiled, [])).toThrow(
      MigrationError
    );
    try {
      assertManualStepwiseProof(compiled, []);
    } catch (error) {
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  });

  test("stepwise manual work with both proof arms is admitted", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      { kind: "irreversible", reason: "none" },
      "sqlite",
      "stepwise",
      [{ kind: "trusted-read", query: sql`SELECT 1`, equals: true }],
      assembly
    );
    const destination = [
      compileTrustedCheck(
        { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
        "sqlite",
        assembly,
        "destination:0"
      ),
    ];
    expect(() =>
      assertManualStepwiseProof(compiled, destination)
    ).not.toThrow();
  });

  test("transactional manual work does not require origin and destination checks", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      { kind: "irreversible", reason: "none" },
      "sqlite",
      "transactional",
      undefined,
      assembly
    );
    expect(() => assertManualStepwiseProof(compiled, [])).not.toThrow();
  });

  test("evaluateCheck accepts exactly one boolean cell", async () => {
    const driver = createInMemorySQLite3Driver();
    await driver._connect();
    const matching = new SqlAssembly();
    const drafted = compileTrustedCheck(
      { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
      "sqlite",
      matching,
      "probe"
    );
    const sealed = matching.seal();
    const [check] = rebindChecks([drafted], sealed.dispatches);
    expect(await evaluateCheck(driver, sealed.bytes, check!)).toBe(true);
    const mismatching = new SqlAssembly();
    const draftedMismatch = compileTrustedCheck(
      { kind: "trusted-read", query: sql`SELECT 0`, equals: true },
      "sqlite",
      mismatching,
      "mismatch"
    );
    const sealedMismatch = mismatching.seal();
    const [mismatch] = rebindChecks(
      [draftedMismatch],
      sealedMismatch.dispatches
    );
    expect(await evaluateCheck(driver, sealedMismatch.bytes, mismatch!)).toBe(
      false
    );
    await driver._disconnect();
  });

  test("driver probes and trusted-read checks keep distinct manifest arms", () => {
    const assembly = new SqlAssembly();
    const generated = compileGeneratedTransition(
      [
        {
          type: "createTable",
          table: {
            name: "user",
            columns: [{ name: "id", type: "TEXT", nullable: false }],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        },
      ],
      sqlite3MigrationDriver,
      "artifact",
      emptyManagedSnapshot(),
      {
        tables: [
          {
            name: "user",
            columns: [{ name: "id", type: "TEXT", nullable: false }],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      },
      assembly
    );
    const proven = generated.operations[0]!.steps.find(
      (step) => step.retry === "proven"
    );
    expect(proven?.retry).toBe("proven");
    if (proven?.retry === "proven") {
      expect(proven.precheck.kind).toBe("driver");
      expect(proven.postcheck.kind).toBe("driver");
    }
    const trusted = compileTrustedCheck(
      { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
      "sqlite",
      assembly,
      "manual-origin"
    );
    expect(trusted.kind).toBe("trusted-read");
    expectTypeOf(trusted.kind).toEqualTypeOf<"trusted-read">();
  });

  test("forward transactional plus rollback stepwise derive independently", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      {
        kind: "manual",
        execution: "stepwise",
        sql: [sql`SELECT 2`],
      },
      "sqlite",
      "transactional",
      [{ kind: "trusted-read", query: sql`SELECT 1`, equals: true }],
      assembly
    );
    expect(compiled.requestedForwardBoundary).toBe("transactional");
    if (compiled.rollback.kind === "manual") {
      expect(compiled.rollback.requestedBoundary).toBe("stepwise");
    }
    expect(
      classifyStoredAtomicity(
        sqlite3MigrationDriver,
        compiled.requestedForwardBoundary,
        compiled.operations
      )
    ).toBe("transactional");
    expect(
      classifyStoredAtomicity(
        sqlite3MigrationDriver,
        compiled.rollback.kind === "manual"
          ? compiled.rollback.requestedBoundary
          : null,
        compiled.rollback.kind === "manual" ? compiled.rollback.operations : []
      )
    ).toBe("stepwise");
  });

  test("forward stepwise plus rollback transactional derive independently", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      {
        kind: "manual",
        execution: "transactional",
        sql: [sql`SELECT 2`],
      },
      "sqlite",
      "stepwise",
      [{ kind: "trusted-read", query: sql`SELECT 1`, equals: true }],
      assembly
    );
    expect(compiled.requestedForwardBoundary).toBe("stepwise");
    if (compiled.rollback.kind === "manual") {
      expect(compiled.rollback.requestedBoundary).toBe("transactional");
    }
    expect(
      classifyStoredAtomicity(
        sqlite3MigrationDriver,
        "stepwise",
        compiled.operations
      )
    ).toBe("stepwise");
    expect(
      classifyStoredAtomicity(
        sqlite3MigrationDriver,
        "transactional",
        compiled.rollback.kind === "manual" ? compiled.rollback.operations : []
      )
    ).toBe("transactional");
  });

  test("an empty irreversible reason is refused at compile", () => {
    expect(() =>
      compileManualTransition(
        [sql`SELECT 1`],
        { kind: "irreversible", reason: "   " },
        "sqlite",
        "transactional",
        undefined,
        new SqlAssembly()
      )
    ).toThrow(MigrationError);
  });

  test("a manual transactional requirement on MySQL refuses before effects", () => {
    expect(() =>
      classifyStoredAtomicity(mysqlMigrationDriver, "transactional", [])
    ).toThrow(MigrationError);
    try {
      classifyStoredAtomicity(mysqlMigrationDriver, "transactional", []);
    } catch (error) {
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
      );
    }
  });
});
