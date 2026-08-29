import {
  decimalConversionConstraintName,
  mysqlDecimalFitsCatalogCheck,
  mysqlDecimalListFitsCatalogCheck,
} from "@migrations/decimal";
import { planInterruptedMySQLDecimalRecovery } from "@migrations/drivers/mysql/decimal-recovery";
import type { CatalogRead } from "@migrations/target";
import { describe, expect, it } from "vitest";

const NAMESPACE = "billing";
const RESERVED_MISMATCH = /reserved.*does not match/i;
const MULTIPLE_PROOFS = /catalog contains 2 reserved proofs/i;
const IMPOSSIBLE_TEXT = /impossible text storage/i;
const INCOMPATIBLE_LIST_MARKER =
  /compatible source or target decimal-list marker/i;
const NOT_ENFORCED = /CHECK is not enforced/i;

interface CatalogFixture {
  readonly constraints: readonly Record<string, unknown>[];
  readonly columns: readonly Record<string, unknown>[];
}

function readerFor(fixture: CatalogFixture): CatalogRead {
  const read: CatalogRead = async <T>(sql: string) => {
    if (sql.includes("CHECK_CONSTRAINTS")) {
      return { rows: [...fixture.constraints] as T[] };
    }
    if (sql.includes("information_schema.COLUMNS")) {
      return { rows: [...fixture.columns] as T[] };
    }
    return { rows: [] };
  };
  return read;
}

function scalarColumn(
  name: string,
  dataType = "decimal",
  tableName = "ledger"
): Record<string, unknown> {
  return {
    TABLE_NAME: tableName,
    COLUMN_NAME: name,
    DATA_TYPE: dataType,
    COLUMN_COMMENT: "",
  };
}

function listColumn(
  name: string,
  comment = "viborm:decimal(10,2)"
): Record<string, unknown> {
  return {
    TABLE_NAME: "ledger",
    COLUMN_NAME: name,
    DATA_TYPE: "json",
    COLUMN_COMMENT: comment,
  };
}

describe("MySQL interrupted decimal-conversion recovery", () => {
  it("uses one bounded name over the spelling-stable proof identity", () => {
    const descriptor = { precision: 10, scale: 2 };
    const name = decimalConversionConstraintName("scalar", descriptor);

    expect(name).toBe("viborm_decimal_s_10_2");
    expect(name.length).toBeLessThanOrEqual(63);
    // `lower_case_table_names` may change catalog spelling after the ADD. The
    // name therefore identifies the exact descriptor, while the authenticated
    // CHECK identifies its table and column.
    expect(
      new Set([
        name,
        decimalConversionConstraintName("list", descriptor),
        decimalConversionConstraintName("scalar", {
          precision: 11,
          scale: 2,
        }),
      ]).size
    ).toBe(3);
  });

  it("authenticates one enforced scalar proof", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const name = decimalConversionConstraintName("scalar", descriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: name,
          ENFORCED: "YES",
          CHECK_CLAUSE:
            "((`amount` is null) or (`amount` = cast(`amount` as decimal(10,2))))",
        },
      ],
      columns: [scalarColumn("amount")],
    });

    const statements = await planInterruptedMySQLDecimalRecovery(
      read,
      NAMESPACE,
      (name) => `\`${name}\``
    );

    expect(statements).toEqual([
      `ALTER TABLE \`${NAMESPACE}\`.\`ledger\` DROP CHECK \`${name}\``,
    ]);
  });

  it.each([
    ["source", "viborm:decimal(7,2)"],
    ["target", "viborm:decimal(10,2)"],
  ])("authenticates a list proof against its %s marker", async (_state, marker) => {
    const descriptor = { precision: 7, scale: 2 };
    const name = decimalConversionConstraintName("list", descriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: name,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalListFitsCatalogCheck(
            "`samples`",
            descriptor
          ),
        },
      ],
      columns: [listColumn("samples", marker)],
    });

    await expect(
      planInterruptedMySQLDecimalRecovery(
        read,
        NAMESPACE,
        (identifier) => `\`${identifier}\``
      )
    ).resolves.toEqual([
      `ALTER TABLE \`${NAMESPACE}\`.\`ledger\` DROP CHECK \`${name}\``,
    ]);
  });

  it("refuses a reserved-name collision before dropping any proof", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const name = decimalConversionConstraintName("scalar", descriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: name,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(9,2)"
          ),
        },
      ],
      columns: [scalarColumn("amount")],
    });

    await expect(
      planInterruptedMySQLDecimalRecovery(
        read,
        NAMESPACE,
        (identifier) => `\`${identifier}\``
      )
    ).rejects.toThrow(RESERVED_MISMATCH);
  });

  it("refuses two individually authentic proofs as an impossible estate", async () => {
    const firstDescriptor = { precision: 10, scale: 2 };
    const secondDescriptor = { precision: 11, scale: 2 };
    const first = decimalConversionConstraintName("scalar", firstDescriptor);
    const second = decimalConversionConstraintName("scalar", secondDescriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: first,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(10,2)"
          ),
        },
        {
          TABLE_NAME: "archive",
          CONSTRAINT_NAME: second,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(11,2)"
          ),
        },
      ],
      columns: [
        scalarColumn("amount"),
        scalarColumn("amount", "decimal", "archive"),
      ],
    });

    await expect(
      planInterruptedMySQLDecimalRecovery(
        read,
        NAMESPACE,
        (identifier) => `\`${identifier}\``
      )
    ).rejects.toThrow(MULTIPLE_PROOFS);
  });

  it("refuses an exact-looking scalar proof on impossible TEXT storage", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const name = decimalConversionConstraintName("scalar", descriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: name,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(10,2)"
          ),
        },
      ],
      columns: [scalarColumn("amount", "text")],
    });

    await expect(
      planInterruptedMySQLDecimalRecovery(
        read,
        NAMESPACE,
        (identifier) => `\`${identifier}\``
      )
    ).rejects.toThrow(IMPOSSIBLE_TEXT);
  });

  it.each([
    ["missing", ""],
    ["wrong-scale", "viborm:decimal(10,3)"],
    ["too-narrow", "viborm:decimal(6,2)"],
  ])("refuses a list proof with a %s marker", async (_case, marker) => {
    const descriptor = { precision: 7, scale: 2 };
    const name = decimalConversionConstraintName("list", descriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: name,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalListFitsCatalogCheck(
            "`samples`",
            descriptor
          ),
        },
      ],
      columns: [listColumn("samples", marker)],
    });

    await expect(
      planInterruptedMySQLDecimalRecovery(
        read,
        NAMESPACE,
        (identifier) => `\`${identifier}\``
      )
    ).rejects.toThrow(INCOMPATIBLE_LIST_MARKER);
  });

  it("refuses an exact-looking proof that is not enforced", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const name = decimalConversionConstraintName("scalar", descriptor);
    const read = readerFor({
      constraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: name,
          ENFORCED: "NO",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(10,2)"
          ),
        },
      ],
      columns: [scalarColumn("amount")],
    });

    await expect(
      planInterruptedMySQLDecimalRecovery(
        read,
        NAMESPACE,
        (identifier) => `\`${identifier}\``
      )
    ).rejects.toThrow(NOT_ENFORCED);
  });
});
