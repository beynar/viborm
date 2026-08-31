import {
  decimalConversionConstraintName,
  mysqlDecimalFitsCatalogCheck,
  mysqlDecimalListFitsCatalogCheck,
} from "@src/migrations/decimal";
import { planInterruptedMySQLDecimalRecovery } from "@src/migrations/drivers/mysql/decimal-recovery";
import {
  mysqlAcquireLockStatement,
  mysqlLockAnswer,
  mysqlMigrationLockName,
  mysqlReleaseLockStatement,
  mysqlSelectTargetStatement,
} from "@src/migrations/drivers/mysql/pinned-session";
import { describe, expect, test } from "vitest";
import { mysqlEstateDriver } from "./_estate";

const DESCRIPTOR = { precision: 10, scale: 2 };
const SCALAR_PROOF = decimalConversionConstraintName("scalar", DESCRIPTOR);
const LIST_PROOF = decimalConversionConstraintName("list", DESCRIPTOR);
const LOCK_NAME_SHAPE = /^viborm_migration_[a-z0-9_]+_[0-9a-f]{8}$/;

function recoveryDriver(
  constraints: readonly Record<string, unknown>[],
  columns: readonly Record<string, unknown>[] = []
) {
  const execution = mysqlEstateDriver({
    namespace: "billing",
    attested: true,
  });
  execution.respond = (sql) =>
    sql.includes("CHECK_CONSTRAINTS") ? [...constraints] : [...columns];
  return execution;
}

function scalarConstraint(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    TABLE_NAME: "ledger",
    CONSTRAINT_NAME: SCALAR_PROOF,
    ENFORCED: "YES",
    CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck("`amount`", "DECIMAL(10,2)"),
    ...overrides,
  };
}

function scalarColumn(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    TABLE_NAME: "ledger",
    COLUMN_NAME: "amount",
    DATA_TYPE: "decimal",
    COLUMN_COMMENT: "",
    ...overrides,
  };
}

async function recover(
  constraints: readonly Record<string, unknown>[],
  columns: readonly Record<string, unknown>[] = []
) {
  const execution = recoveryDriver(constraints, columns);
  return await planInterruptedMySQLDecimalRecovery(
    (sql, params) => execution._executeRaw(sql, params),
    "billing",
    (name) => `\`${name.replaceAll("`", "``")}\``
  );
}

describe("provider-free interrupted MySQL decimal recovery", () => {
  test("accepts mysql2 catalog quoting and character-set introducers", async () => {
    const catalogClause = mysqlDecimalListFitsCatalogCheck(
      "`amounts`",
      DESCRIPTOR
    )
      .replace("'['", "_utf8mb4'['")
      .replaceAll("'", String.raw`\'`);

    await expect(
      recover(
        [
          {
            TABLE_NAME: "ledger",
            CONSTRAINT_NAME: LIST_PROOF,
            ENFORCED: "YES",
            CHECK_CLAUSE: catalogClause,
          },
        ],
        [
          {
            TABLE_NAME: "ledger",
            COLUMN_NAME: "amounts",
            DATA_TYPE: "json",
            COLUMN_COMMENT: "viborm:decimal(10,2)",
          },
        ]
      )
    ).resolves.toEqual([
      "ALTER TABLE `billing`.`ledger` DROP CHECK `viborm_decimal_l_10_2`",
    ]);
  });

  test.each([
    ["CONSTRAINT_NAME", { CONSTRAINT_NAME: 17 }],
    ["TABLE_NAME", { TABLE_NAME: null }],
    ["CHECK_CLAUSE", { CHECK_CLAUSE: false }],
    ["ENFORCED", { ENFORCED: undefined }],
  ])("refuses a non-string catalog %s", async (field, override) => {
    await expect(
      recover([scalarConstraint(override)], [scalarColumn()])
    ).rejects.toThrow(`catalog ${field} is not a string`);
  });

  test.each([
    [
      "viborm_decimal_s_66_0",
      "name declares a decimal domain this provider does not admit",
    ],
    [
      "viborm_decimal_s_010_2",
      "name is not the canonical spelling of its decimal proof",
    ],
    [
      "viborm_decimal_not_a_complete_identity",
      "name does not match the complete reserved proof identity",
    ],
  ])("refuses malformed reserved identity %s", async (name, message) => {
    await expect(
      recover([scalarConstraint({ CONSTRAINT_NAME: name })], [scalarColumn()])
    ).rejects.toThrow(message);
  });

  test("refuses a list proof attached to non-JSON storage", async () => {
    await expect(
      recover(
        [
          {
            TABLE_NAME: "ledger",
            CONSTRAINT_NAME: LIST_PROOF,
            ENFORCED: "YES",
            CHECK_CLAUSE: mysqlDecimalListFitsCatalogCheck(
              "`amounts`",
              DESCRIPTOR
            ),
          },
        ],
        [
          {
            TABLE_NAME: "ledger",
            COLUMN_NAME: "amounts",
            DATA_TYPE: "text",
            COLUMN_COMMENT: "viborm:decimal(10,2)",
          },
        ]
      )
    ).rejects.toThrow("list proof is attached to impossible text storage");
  });

  test("translates an invalid reserved list marker into a recovery refusal", async () => {
    await expect(
      recover(
        [
          {
            TABLE_NAME: "ledger",
            CONSTRAINT_NAME: LIST_PROOF,
            ENFORCED: "YES",
            CHECK_CLAUSE: mysqlDecimalListFitsCatalogCheck(
              "`amounts`",
              DESCRIPTOR
            ),
          },
        ],
        [
          {
            TABLE_NAME: "ledger",
            COLUMN_NAME: "amounts",
            DATA_TYPE: "json",
            COLUMN_COMMENT: "viborm:decimal(0,2)",
          },
        ]
      )
    ).rejects.toThrow("invalid decimal-list marker");
  });
});

describe("coverage low value", () => {
  test("returns no cleanup for an empty reserved inventory", async () => {
    await expect(recover([])).resolves.toEqual([]);
  });

  test("ignores malformed column inventory rows before authenticating a proof", async () => {
    await expect(
      recover(
        [scalarConstraint()],
        [
          scalarColumn({ TABLE_NAME: null }),
          scalarColumn({ COLUMN_NAME: null }),
          scalarColumn({ DATA_TYPE: null }),
          scalarColumn({ COLUMN_COMMENT: null }),
          scalarColumn(),
        ]
      )
    ).resolves.toHaveLength(1);
  });

  test.each([
    ["'doubled''quote'"],
    [String.raw`'backslash\\escape'`],
    ["`unterminated"],
  ])("refuses an impossible catalog CHECK spelling %s", async (clause) => {
    await expect(
      recover([scalarConstraint({ CHECK_CLAUSE: clause })], [scalarColumn()])
    ).rejects.toThrow("concrete CHECK predicate does not match");
  });

  test.each([
    [[], "acquired", false],
    [[{ acquired: 1 }, { acquired: 1 }], "acquired", false],
    [[null], "acquired", false],
    [[17], "acquired", false],
    [[{ acquired: 1 }], "acquired", true],
    [[{ acquired: "1" }], "acquired", true],
    [[{ acquired: "not-one" }], "acquired", false],
    [[{ acquired: true }], "acquired", false],
    [[{ released: "1" }], "released", true],
  ] as const)("classifies lock answer %#", (rows, column, expected) => {
    expect(mysqlLockAnswer(rows, column)).toBe(expected);
  });

  test("renders bounded lock and target statements from hostile-looking names", () => {
    const namespace = `${"A-Long.Database".repeat(8)}-tail`;
    const lockName = mysqlMigrationLockName(namespace);
    const quoteValue = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const quoteIdentifier = (value: string) =>
      `\`${value.replaceAll("`", "``")}\``;

    expect(lockName).toHaveLength(64);
    expect(lockName).toMatch(LOCK_NAME_SHAPE);
    expect(mysqlAcquireLockStatement(namespace, 7, quoteValue)).toContain(
      `${quoteValue(lockName)}, 7`
    );
    expect(mysqlReleaseLockStatement(namespace, quoteValue)).toContain(
      quoteValue(lockName)
    );
    expect(mysqlSelectTargetStatement(namespace, quoteIdentifier)).toBe(
      `USE ${quoteIdentifier(namespace)}`
    );
  });
});
