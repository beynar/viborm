/**
 * MySQL effectful migration work requires a PROVEN strict session mode.
 *
 * Plan 3.3: "Strict exact-value behavior is required; a mode that converts
 * overflow or truncation to warnings is refused for effectful decimal
 * operations." That is not a preference on a fixed-decimal estate — it is the
 * difference between an exact column and a quietly clamped one. Measured on the
 * Docker server (8.4), with `sql_mode = ''`:
 *
 *   CREATE TABLE t (amount DECIMAL(6,2));  INSERT 10.00
 *   UPDATE t SET amount = amount * 100000
 *     -> "Rows matched: 1  Changed: 1  Warnings: 1",  amount = 9999.99
 *
 * The same statement under `STRICT_TRANS_TABLES` raises
 * `ER_WARN_DATA_OUT_OF_RANGE` and leaves the row alone. Migration work can run
 * provider-authored DDL and manual artifacts outside the ORM adapter's guarded
 * arithmetic, so the pinned producer refuses the truncating mode. Ordinary ORM
 * decimal updates carry their own same-statement non-strict refusal.
 *
 * The proof is taken ONCE per pinned migration session, on the producer that
 * runs the DDL, before any statement it protects — not per operation.
 *
 * Requires the Docker test database:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { VibORMErrorCode } from "@errors";
import { decimalConversionConstraintName } from "@migrations/decimal";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import {
  runSequentialProgram,
  withLockedMigrationProducer,
} from "@migrations/pinned-session";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { ddlContext } from "./_estate";

const MYSQL_CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfMysql = MYSQL_CONNECTION ? describe : describe.skip;

const STRICT_MODE =
  "IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

const LIST_TABLE = "viborm_decimal_list_transition";
const RECOVERY_SCALAR_TABLE = "viborm_decimal_recovery_scalar";
const RECOVERY_LIST_TABLE = "viborm_decimal_recovery_list";
const RECOVERY_COLLISION_TABLE = "viborm_decimal_recovery_collision";
const RESERVED_PROOF_MISMATCH = /reserved.*does not match/i;

interface ColumnCommentRow extends RowDataPacket {
  readonly columnComment: string;
}

interface StoredListRow extends RowDataPacket {
  readonly samples: string;
}

function listTransition(fromPrecision: number, toPrecision: number): string[] {
  return mysqlMigrationDriver
    .generateDDL(
      {
        type: "alterColumn",
        tableName: LIST_TABLE,
        columnName: "samples",
        from: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: fromPrecision, scale: 0 },
        },
        to: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: toPrecision, scale: 0 },
        },
      },
      ddlContext("live")
    )
    .split(";\n");
}

function scalarTransition(
  fromPrecision: number,
  toPrecision: number
): string[] {
  return mysqlMigrationDriver
    .generateDDL(
      {
        type: "alterColumn",
        tableName: RECOVERY_SCALAR_TABLE,
        columnName: "amount",
        from: {
          name: "amount",
          type: `DECIMAL(${fromPrecision},2)`,
          nullable: false,
          decimal: { precision: fromPrecision, scale: 2 },
        },
        to: {
          name: "amount",
          type: `DECIMAL(${toPrecision},2)`,
          nullable: false,
          decimal: { precision: toPrecision, scale: 2 },
        },
      },
      ddlContext("live")
    )
    .split(";\n");
}

function scalarRecoverySchema(precision: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision, scale: 2 }),
      })
      .map(RECOVERY_SCALAR_TABLE),
  };
}

function listRecoverySchema(precision: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        samples: s.decimal({ precision, scale: 0 }).array(),
      })
      .map(RECOVERY_LIST_TABLE),
  };
}

describeIfMysql("the MySQL strict-mode proof", () => {
  const admin = new MySQL2Driver({ databaseUrl: MYSQL_CONNECTION ?? "" });

  /** A driver whose pool is its own, so its connections read the mode fresh. */
  const freshDriver = () =>
    new MySQL2Driver({
      databaseUrl: MYSQL_CONNECTION ?? "",
      migrationNamespaceAttestation: "non-redirecting",
    });

  afterAll(async () => {
    await admin._executeRaw(`SET GLOBAL sql_mode = '${STRICT_MODE}'`);
    await admin.disconnect();
  });

  it("admits a strict session", async () => {
    await admin._executeRaw(`SET GLOBAL sql_mode = '${STRICT_MODE}'`);
    const driver = freshDriver();
    try {
      const seen = await withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        () => Promise.resolve("ran")
      );
      expect(seen).toBe("ran");
    } finally {
      await driver.disconnect();
    }
  }, 120_000);

  it("REFUSES a session with neither strict mode, naming the mode", async () => {
    // Global, not session: the pinned producer is a connection this test never
    // touches, so the only way to give it a non-strict mode is to make that the
    // mode it inherits when it is opened.
    await admin._executeRaw("SET GLOBAL sql_mode = 'ANSI_QUOTES'");
    const driver = freshDriver();
    try {
      const failure = await withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        () => Promise.resolve("ran")
      ).catch((error: unknown) => error);

      const code =
        failure instanceof Error ? Reflect.get(failure, "code") : undefined;

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("ANSI_QUOTES");
      expect(String(failure)).toContain("STRICT_TRANS_TABLES");
      expect(String(failure)).toContain("STRICT_ALL_TABLES");
      expect(code).toBe(VibORMErrorCode.DRIVER_NOT_SUPPORTED);
    } finally {
      await admin._executeRaw(`SET GLOBAL sql_mode = '${STRICT_MODE}'`);
      await driver.disconnect();
    }
  }, 120_000);

  it("admits STRICT_ALL_TABLES on its own", async () => {
    await admin._executeRaw("SET GLOBAL sql_mode = 'STRICT_ALL_TABLES'");
    const driver = freshDriver();
    try {
      const seen = await withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        () => Promise.resolve("ran")
      );
      expect(seen).toBe("ran");
    } finally {
      await admin._executeRaw(`SET GLOBAL sql_mode = '${STRICT_MODE}'`);
      await driver.disconnect();
    }
  }, 120_000);
});

describeIfMysql("MySQL decimal-list descriptor checks", () => {
  it.each([
    ["strict", STRICT_MODE],
    ["non-strict", ""],
  ])(
    "accepts only canonical coefficient containers in a %s session",
    async (_label, sqlMode) => {
      const connection = await createConnection(MYSQL_CONNECTION ?? "");
      const invalidContainers = [
        "[1]",
        '["-0"]',
        '["01"]',
        '["+1"]',
        '["1.0"]',
        '["1e2"]',
        "[null]",
        "null",
        '{"value":"1"}',
        '["1000"]',
      ];
      const run = async (statements: readonly string[]) => {
        for (const statement of statements) {
          await connection.query(statement);
        }
      };

      try {
        await connection.query("SET SESSION sql_mode = ?", [sqlMode]);
        await connection.query(`DROP TABLE IF EXISTS \`${LIST_TABLE}\``);
        await connection.query(
          `CREATE TABLE \`${LIST_TABLE}\` (\`samples\` JSON NOT NULL COMMENT 'viborm:decimal(3,0)')`
        );
        await connection.query(
          `INSERT INTO \`${LIST_TABLE}\` (\`samples\`) VALUES ('[]'), ('["0", "-1", "999"]')`
        );

        await run(listTransition(3, 4));

        const [validRows] = await connection.query<StoredListRow[]>(
          `SELECT CAST(\`samples\` AS CHAR CHARACTER SET utf8mb4) AS samples FROM \`${LIST_TABLE}\` ORDER BY CAST(\`samples\` AS CHAR CHARACTER SET utf8mb4)`
        );
        expect(validRows.map((row) => row.samples)).toEqual([
          '["0", "-1", "999"]',
          "[]",
        ]);

        // A list narrowing is deliberately not an admitted migration on
        // MySQL. Recreate the source estate instead of asking the production
        // planner to generate the forbidden 4 -> 3 inverse merely to prepare
        // the hostile-container witnesses below.
        await connection.query(`DROP TABLE \`${LIST_TABLE}\``);
        await connection.query(
          `CREATE TABLE \`${LIST_TABLE}\` (\`samples\` JSON NOT NULL COMMENT 'viborm:decimal(3,0)')`
        );

        for (const container of invalidContainers) {
          await connection.query(`DELETE FROM \`${LIST_TABLE}\``);
          await connection.query(
            `INSERT INTO \`${LIST_TABLE}\` (\`samples\`) VALUES (?)`,
            [container]
          );
          const [before] = await connection.query<StoredListRow[]>(
            `SELECT CAST(\`samples\` AS CHAR CHARACTER SET utf8mb4) AS samples FROM \`${LIST_TABLE}\``
          );

          await expect(run(listTransition(3, 4))).rejects.toThrow();

          const [comments] = await connection.query<ColumnCommentRow[]>(
            "SELECT COLUMN_COMMENT AS columnComment FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'samples'",
            [LIST_TABLE]
          );
          expect(comments[0]?.columnComment).toBe("viborm:decimal(3,0)");
          const [stored] = await connection.query<StoredListRow[]>(
            `SELECT CAST(\`samples\` AS CHAR CHARACTER SET utf8mb4) AS samples FROM \`${LIST_TABLE}\``
          );
          expect(stored).toEqual(before);
        }
      } finally {
        await connection.query(`DROP TABLE IF EXISTS \`${LIST_TABLE}\``);
        await connection.end();
      }
    },
    120_000
  );
});

describeIfMysql("MySQL interrupted decimal-conversion recovery", () => {
  const driver = new MySQL2Driver({
    databaseUrl: MYSQL_CONNECTION ?? "",
    migrationNamespaceAttestation: "non-redirecting",
  });

  afterAll(async () => {
    await driver._executeRaw(
      `DROP TABLE IF EXISTS \`${RECOVERY_SCALAR_TABLE}\``
    );
    await driver._executeRaw(`DROP TABLE IF EXISTS \`${RECOVERY_LIST_TABLE}\``);
    await driver._executeRaw(
      `DROP TABLE IF EXISTS \`${RECOVERY_COLLISION_TABLE}\``
    );
    await driver.disconnect();
  });

  it("recovers after ADD CHECK, reruns the scalar transition, and converges", async () => {
    await driver._executeRaw(
      `DROP TABLE IF EXISTS \`${RECOVERY_SCALAR_TABLE}\``
    );
    const before = createClient({ schema: scalarRecoverySchema(5), driver });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO \`${RECOVERY_SCALAR_TABLE}\` (\`id\`, \`amount\`) VALUES ('row', 123.45)`
    );

    const statements = scalarTransition(5, 10);
    const validate = statements[0];
    if (validate === undefined) throw new Error("missing validation statement");
    await driver._executeRaw(validate);

    const after = createClient({ schema: scalarRecoverySchema(10), driver });
    const resumed = await push(after, { force: true });
    expect(resumed.operations.map((operation) => operation.type)).toEqual([
      "alterColumn",
    ]);
    expect((await push(after, { force: true })).operations).toEqual([]);

    await driver._executeRaw(
      `INSERT INTO \`${RECOVERY_SCALAR_TABLE}\` (\`id\`, \`amount\`) VALUES ('wide', 12345678.90)`
    );
  }, 120_000);

  it("recovers after MODIFY, removes the stale list proof, and converges", async () => {
    await driver._executeRaw(`DROP TABLE IF EXISTS \`${RECOVERY_LIST_TABLE}\``);
    const before = createClient({ schema: listRecoverySchema(5), driver });
    await push(before, { force: true });

    const statements = mysqlMigrationDriver
      .generateDDL(
        {
          type: "alterColumn",
          tableName: RECOVERY_LIST_TABLE,
          columnName: "samples",
          from: {
            name: "samples",
            type: "JSON",
            nullable: false,
            decimal: { precision: 5, scale: 0 },
          },
          to: {
            name: "samples",
            type: "JSON",
            nullable: false,
            decimal: { precision: 10, scale: 0 },
          },
        },
        ddlContext("live")
      )
      .split(";\n");
    const validate = statements[0];
    const move = statements[1];
    if (validate === undefined || move === undefined) {
      throw new Error("missing list transition bracket");
    }
    await driver._executeRaw(validate);
    await driver._executeRaw(move);

    const after = createClient({ schema: listRecoverySchema(10), driver });
    expect((await push(after, { force: true })).operations).toEqual([]);
    await driver._executeRaw(
      `INSERT INTO \`${RECOVERY_LIST_TABLE}\` (\`id\`, \`samples\`) VALUES ('wide', JSON_ARRAY('123456'))`
    );
    expect((await push(after, { force: true })).operations).toEqual([]);
  }, 120_000);

  it("refuses a user collision before effects and preserves it", async () => {
    await driver._executeRaw(
      `DROP TABLE IF EXISTS \`${RECOVERY_COLLISION_TABLE}\``
    );
    await driver._executeRaw(
      `CREATE TABLE \`${RECOVERY_COLLISION_TABLE}\` (\`amount\` DECIMAL(5,2))`
    );
    const name = decimalConversionConstraintName("scalar", {
      precision: 10,
      scale: 2,
    });
    await driver._executeRaw(
      `ALTER TABLE \`${RECOVERY_COLLISION_TABLE}\` ADD CONSTRAINT \`${name}\` CHECK (\`amount\` IS NULL OR \`amount\` >= 0)`
    );

    const failure = await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      (pinned, command) =>
        runSequentialProgram(pinned, command, () => Promise.resolve("body-ran"))
    ).catch((error: unknown) => error);
    expect(String(failure)).toMatch(RESERVED_PROOF_MISMATCH);

    const remaining = await driver._executeRaw<{ CONSTRAINT_NAME: string }>(
      "SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?",
      [name]
    );
    expect(remaining.rows).toEqual([{ CONSTRAINT_NAME: name }]);
  }, 120_000);
});
