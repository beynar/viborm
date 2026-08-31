/**
 * Live fixed-decimal list default application and convergence.
 *
 * Runtime writes already encode these values through the decimal codec. The
 * migration serializer must retain the same physical value so an omitted
 * column receives it in raw SQL too, and every provider's introspection must
 * return the exact expression the serializer wrote or a second push churns.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { MigrationDriver } from "@migrations/drivers";
import { introspect } from "@migrations/push";
import { serializeModels } from "@migrations/serializer";
import type { ColumnDef, SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ddlContextFor } from "./_estate";

const TABLE = "decimal_list_defaults";
const LOGICAL_DEFAULT = ["1.20", "-3.40", "0.00", "90071992547409.93"];
const POSTGRES_DEFAULT = "'{1.20,-3.40,0.00,90071992547409.93}'";
const JSON_DEFAULT = '\'["120","-340","0","9007199254740993"]\'';
const MYSQL_DEFAULT = `(${JSON_DEFAULT})`;

function defaultSchema() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amounts: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(LOGICAL_DEFAULT),
        empty: s.decimal({ precision: 16, scale: 2 }).array().default([]),
        generated: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(() => ["4.20"]),
        nullable: s
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

function storageSchema() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amounts: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(LOGICAL_DEFAULT),
        empty: s.decimal({ precision: 16, scale: 2 }).array().default([]),
      })
      .map(TABLE),
  };
}

function changedStorageSchema() {
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

function noDefaultStorageSchema() {
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

function snapshotFor(driver: MigrationDriver): SchemaSnapshot {
  return serializeModels(defaultSchema(), { migrationDriver: driver });
}

function columnsFor(driver: MigrationDriver): Map<string, ColumnDef> {
  const table = snapshotFor(driver).tables[0];
  if (table === undefined) throw new Error("decimal default table is missing");
  return new Map(table.columns.map((column) => [column.name, column]));
}

function createTableSql(driver: MigrationDriver): string {
  const table = snapshotFor(driver).tables[0];
  if (table === undefined) throw new Error("decimal default table is missing");
  return driver.generateDDL(
    { type: "createTable", table },
    ddlContextFor("artifact", { tables: [] })
  );
}

describe("literal decimal-list defaults converge and populate old rows", () => {
  it("applies transformed scalar and list literals once for ORM and raw omission", async () => {
    let scalarRuns = 0;
    let listRuns = 0;
    const shift = (observe: () => void) => ({
      "~standard": {
        version: 1 as const,
        vendor: "decimal-list-default-test",
        validate(value: unknown) {
          observe();
          return value instanceof Decimal
            ? { value: value.plus(1) }
            : { issues: [{ message: "Expected Decimal" }] };
        },
      },
    });
    const schema = {
      ledger: s
        .model({
          id: s.string().id(),
          amount: s
            .decimal({ precision: 16, scale: 2 })
            .schema(
              shift(() => {
                scalarRuns += 1;
              })
            )
            .default("1.00"),
          amounts: s
            .decimal({ precision: 16, scale: 2 })
            .schema(
              shift(() => {
                listRuns += 1;
              })
            )
            .array()
            .default(["1.00", "-3.00"]),
        })
        .map(TABLE),
    };
    expect({ scalarRuns, listRuns }).toEqual({ scalarRuns: 1, listRuns: 2 });

    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema, driver });
    expect({ scalarRuns, listRuns }).toEqual({ scalarRuns: 1, listRuns: 2 });
    await push(client, { force: true });
    expect({ scalarRuns, listRuns }).toEqual({ scalarRuns: 1, listRuns: 2 });
    await client.ledger.create({ data: { id: "orm" } });
    expect({ scalarRuns, listRuns }).toEqual({ scalarRuns: 1, listRuns: 2 });
    await client.ledger.create({
      data: { id: "explicit", amount: "4.00", amounts: ["4.00", "-4.00"] },
    });
    expect({ scalarRuns, listRuns }).toEqual({ scalarRuns: 2, listRuns: 4 });

    await driver._executeRaw(`INSERT INTO "${TABLE}" ("id") VALUES ('raw')`);
    const physical = await driver._executeRaw<{
      id: string;
      amount: number;
      amounts: string;
    }>(`SELECT "id", "amount", "amounts" FROM "${TABLE}" ORDER BY "id"`);
    expect(physical.rows).toEqual([
      { id: "explicit", amount: 500, amounts: '["500","-300"]' },
      { id: "orm", amount: 200, amounts: '["200","-200"]' },
      { id: "raw", amount: 200, amounts: '["200","-200"]' },
    ]);
    await client.$disconnect();
  });

  it("SQLite applies the default to a populated table and then converges", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: {
        ledger: s.model({ id: s.string().id() }).map(TABLE),
      },
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(`INSERT INTO "${TABLE}" ("id") VALUES ('old')`);

    const after = createClient({ schema: storageSchema(), driver });
    await push(after, { force: true });
    await after.ledger.create({ data: { id: "orm" } });
    await driver._executeRaw(`INSERT INTO "${TABLE}" ("id") VALUES ('raw')`);
    const physical = await driver._executeRaw<{
      id: string;
      amounts: string;
      empty: string;
    }>(`SELECT "id", "amounts", "empty" FROM "${TABLE}" ORDER BY "id"`);
    expect(physical.rows).toEqual([
      {
        id: "old",
        amounts: JSON_DEFAULT.slice(1, -1),
        empty: "[]",
      },
      {
        id: "orm",
        amounts: JSON_DEFAULT.slice(1, -1),
        empty: "[]",
      },
      {
        id: "raw",
        amounts: JSON_DEFAULT.slice(1, -1),
        empty: "[]",
      },
    ]);
    expect((await push(after, { force: true })).operations).toEqual([]);
    await after.$disconnect();
  });

  it("SQLite changes and removes a list default without churn", async () => {
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: storageSchema(), driver });
    await push(initial, { force: true });

    const changed = createClient({ schema: changedStorageSchema(), driver });
    await push(changed, { force: true });
    await driver._executeRaw(
      `INSERT INTO "${TABLE}" ("id") VALUES ('changed')`
    );
    const physical = await driver._executeRaw<{ amounts: string }>(
      `SELECT "amounts" FROM "${TABLE}" WHERE "id" = 'changed'`
    );
    expect(physical.rows).toEqual([{ amounts: '["420"]' }]);
    expect((await push(changed, { force: true })).operations).toEqual([]);

    const removed = createClient({ schema: noDefaultStorageSchema(), driver });
    await push(removed, { force: true });
    expect((await push(removed, { force: true })).operations).toEqual([]);
    const snapshot = await introspect(removed);
    expect(
      snapshot.tables
        .find((table) => table.name === TABLE)
        ?.columns.find((column) => column.name === "amounts")?.default
    ).toBeUndefined();
    await removed.$disconnect();
  });

  it("PostgreSQL ORM and raw omitted-column inserts agree and converge", async () => {
    const database = openTestPGlite();
    const client = createClient({
      schema: storageSchema(),
      driver: new PGliteDriver({ client: database }),
    });
    try {
      await push(client, { force: true });
      await client.ledger.create({ data: { id: "orm" } });
      await database.exec(`INSERT INTO "${TABLE}" ("id") VALUES ('raw')`);
      const physical = await database.query<{
        id: string;
        amounts: string;
        empty: string;
      }>(
        `SELECT "id", "amounts"::text AS "amounts", "empty"::text AS "empty" FROM "${TABLE}" ORDER BY "id"`
      );
      expect(physical.rows).toEqual([
        {
          id: "orm",
          amounts: "{1.20,-3.40,0.00,90071992547409.93}",
          empty: "{}",
        },
        {
          id: "raw",
          amounts: "{1.20,-3.40,0.00,90071992547409.93}",
          empty: "{}",
        },
      ]);
      expect((await push(client, { force: true })).operations).toEqual([]);
    } finally {
      await client.$disconnect();
      await closeTestPGlite(database);
    }
  });

  it("PostgreSQL changes and removes a list default without churn", async () => {
    const database = openTestPGlite();
    const initial = createClient({
      schema: storageSchema(),
      driver: new PGliteDriver({ client: database }),
    });
    try {
      await push(initial, { force: true });

      const changed = createClient({
        schema: changedStorageSchema(),
        driver: new PGliteDriver({ client: database }),
      });
      await push(changed, { force: true });
      await database.exec(`INSERT INTO "${TABLE}" ("id") VALUES ('changed')`);
      const physical = await database.query<{ amounts: string }>(
        `SELECT "amounts"::text AS "amounts" FROM "${TABLE}" WHERE "id" = 'changed'`
      );
      expect(physical.rows).toEqual([{ amounts: "{4.20}" }]);
      expect((await push(changed, { force: true })).operations).toEqual([]);

      const removed = createClient({
        schema: noDefaultStorageSchema(),
        driver: new PGliteDriver({ client: database }),
      });
      await push(removed, { force: true });
      expect((await push(removed, { force: true })).operations).toEqual([]);
      const snapshot = await introspect(removed);
      expect(
        snapshot.tables
          .find((table) => table.name === TABLE)
          ?.columns.find((column) => column.name === "amounts")?.default
      ).toBeUndefined();
    } finally {
      await initial.$disconnect();
      await closeTestPGlite(database);
    }
  });
});
