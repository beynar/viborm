/**
 * Real MySQL proof for expression-backed decimal-list defaults.
 *
 * Enable with:
 * MYSQL_TEST_CONNECTION_STRING=mysql://... vitest ...
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { introspect, push } from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfMySQL = CONNECTION ? describe : describe.skip;
const TABLE = "decimal_list_defaults_live";

function beforeSchema() {
  return {
    ledger: s.model({ id: s.string().id() }).map(TABLE),
  };
}

function afterSchema() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amounts: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(["1.20", "-3.40", "0.00", "90071992547409.93"]),
        empty: s.decimal({ precision: 16, scale: 2 }).array().default([]),
        nullableList: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .nullable()
          .default(null),
        nullableScalar: s
          .decimal({ precision: 16, scale: 2 })
          .nullable()
          .default(null),
      })
      .map(TABLE),
  };
}

function changedSchema() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amounts: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(["4.20"]),
        empty: s.decimal({ precision: 16, scale: 2 }).array().default([]),
      })
      .map(TABLE),
  };
}

function noDefaultSchema() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amounts: s.decimal({ precision: 16, scale: 2 }).array(),
        empty: s.decimal({ precision: 16, scale: 2 }).array(),
      })
      .map(TABLE),
  };
}

function mysqlDriver(): MySQL2Driver {
  if (CONNECTION === undefined) {
    throw new Error("MYSQL_TEST_CONNECTION_STRING is required");
  }
  return new MySQL2Driver({
    databaseUrl: CONNECTION,
    namespace: "viborm",
    migrationNamespaceAttestation: "non-redirecting",
  });
}

describeIfMySQL("MySQL decimal-list defaults", () => {
  it("populates old rows, serves raw omitted inserts, introspects, and converges", async () => {
    const driver = mysqlDriver();
    const before = createClient({ schema: beforeSchema(), driver });
    try {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await push(before, { force: true });
      await driver._executeRaw(
        `INSERT INTO \`${TABLE}\` (\`id\`) VALUES ('old')`
      );

      const after = createClient({ schema: afterSchema(), driver });
      await push(after, { force: true });
      await after.ledger.create({ data: { id: "orm" } });
      await driver._executeRaw(
        `INSERT INTO \`${TABLE}\` (\`id\`) VALUES ('raw')`
      );
      const physical = await driver._executeRaw<{
        id: string;
        amounts: string;
        empty: string;
      }>(
        `SELECT \`id\`, CAST(\`amounts\` AS CHAR) AS \`amounts\`, CAST(\`empty\` AS CHAR) AS \`empty\` FROM \`${TABLE}\` ORDER BY \`id\``
      );
      expect(physical.rows).toEqual([
        {
          id: "old",
          amounts: '["120", "-340", "0", "9007199254740993"]',
          empty: "[]",
        },
        {
          id: "orm",
          amounts: '["120", "-340", "0", "9007199254740993"]',
          empty: "[]",
        },
        {
          id: "raw",
          amounts: '["120", "-340", "0", "9007199254740993"]',
          empty: "[]",
        },
      ]);

      const snapshot = await introspect(after);
      const table = snapshot.tables.find(
        (candidate) => candidate.name === TABLE
      );
      expect(
        table?.columns.find((column) => column.name === "amounts")?.default
      ).toBe(`('["120","-340","0","9007199254740993"]')`);
      expect(
        table?.columns.find((column) => column.name === "nullableList")?.default
      ).toBeUndefined();
      expect(
        table?.columns.find((column) => column.name === "nullableScalar")
          ?.default
      ).toBeUndefined();
      expect((await push(after, { force: true })).operations).toEqual([]);

      const changed = createClient({ schema: changedSchema(), driver });
      await push(changed, { force: true });
      await driver._executeRaw(
        `INSERT INTO \`${TABLE}\` (\`id\`) VALUES ('changed')`
      );
      const changedPhysical = await driver._executeRaw<{ amounts: string }>(
        `SELECT CAST(\`amounts\` AS CHAR) AS \`amounts\` FROM \`${TABLE}\` WHERE \`id\` = 'changed'`
      );
      expect(changedPhysical.rows).toEqual([{ amounts: '["420"]' }]);
      expect((await push(changed, { force: true })).operations).toEqual([]);

      const removed = createClient({ schema: noDefaultSchema(), driver });
      await push(removed, { force: true });
      expect((await push(removed, { force: true })).operations).toEqual([]);
      const removedSnapshot = await introspect(removed);
      expect(
        removedSnapshot.tables
          .find((candidate) => candidate.name === TABLE)
          ?.columns.find((column) => column.name === "amounts")?.default
      ).toBeUndefined();
    } finally {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await before.$disconnect();
    }
  });
});
