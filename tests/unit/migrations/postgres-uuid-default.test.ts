/**
 * types-08: PostgreSQL DDL follows the scalar's own generator rule
 * (src/schema/scalars/string/scalar.ts `withIdentifier`). Only a uuid
 * generator the scalar installed becomes `gen_random_uuid()`; a non-key
 * `.uuid()` and `.id({ generate: false }).uuid()` are caller-supplied, so a
 * raw insert that omits them must fail rather than invent a value the typed
 * client would refuse.
 *
 * 1.1.0 rendered those two the way a generated uuid renders, so the legacy
 * schema below declares them generated: its snapshot and DDL are exactly what
 * a 1.1.0 history holds. The same rendering gave a uuid list
 * `text[] DEFAULT gen_random_uuid()`, which PostgreSQL refuses to create.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { NotNullConstraintError } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

const ROWS = 10_000;

function schema(legacy: boolean) {
  const account = s
    .model({
      id: s.string().id().uuid(),
      externalRef: legacy
        ? s.string().uuid({ generate: true })
        : s.string().uuid(),
      partnerRef: s.string().uuid().nullable(),
      trackingId: s.string().uuid({ generate: true }),
      email: s.string().unique(),
      displayName: s.string(),
      status: s.enum(["active", "suspended", "closed"]).default("active"),
      plan: s.string().default("free"),
      balanceCents: s.int().default(0),
      creditLimitCents: s.int().nullable(),
      country: s.string().nullable(),
      verified: s.boolean().default(false),
      settings: s.json().nullable(),
      lastLoginAt: s.dateTime().nullable(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
    })
    .map("uuid_default_accounts");
  const importedOrder = s
    .model({
      id: legacy
        ? s.string().id().uuid()
        : s.string().id({ generate: false }).uuid(),
      number: s.string().unique(),
      totalCents: s.int(),
      payload: s.json().nullable(),
      importedAt: s.dateTime().now(),
    })
    .map("uuid_default_orders");
  return { account, importedOrder };
}

const uuidList = s
  .model({
    id: s.string().id().uuid(),
    members: s.string().uuid().array(),
  })
  .map("uuid_default_lists");

async function columnDefaults(driver: PGliteDriver) {
  const { rows } = await driver._executeRaw<{
    column: string;
    default: string | null;
  }>(
    `SELECT table_name || '.' || column_name AS "column", column_default AS "default"
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'uuid_default_%'
       AND column_name IN ('id', 'externalRef', 'partnerRef', 'trackingId', 'members')`
  );
  return Object.fromEntries(rows.map((row) => [row.column, row.default]));
}

const CONVERGED = {
  "uuid_default_accounts.id": "gen_random_uuid()",
  "uuid_default_accounts.externalRef": null,
  "uuid_default_accounts.partnerRef": null,
  "uuid_default_accounts.trackingId": "gen_random_uuid()",
  "uuid_default_orders.id": null,
};

describe("PostgreSQL uuid column defaults follow the generator rule", () => {
  it("a new history gives caller-supplied uuids no database default", async () => {
    const driver = new PGliteDriver();
    const client = createClient({
      schema: { ...schema(false), uuidList },
      driver,
    });
    try {
      const migrations = createMigrationClient(client, {
        storage: new MemoryEstateStorage(),
      });
      const init = await migrations.generate({ name: "init" });
      expect(init.sql).toContain(
        '"trackingId" uuid NOT NULL DEFAULT gen_random_uuid()'
      );
      expect(init.sql).not.toContain('"externalRef" uuid NOT NULL DEFAULT');
      await migrations.apply();
      expect(await columnDefaults(driver)).toEqual({
        ...CONVERGED,
        "uuid_default_lists.id": "gen_random_uuid()",
        "uuid_default_lists.members": null,
      });
      await expect(
        driver._executeRaw(
          `INSERT INTO "uuid_default_orders" ("number", "totalCents") VALUES ('N-1', 100)`
        )
      ).rejects.toBeInstanceOf(NotNullConstraintError);
    } finally {
      await client.$disconnect();
    }
  });

  it(`an existing history converges with one DROP DEFAULT per column, keeping ${ROWS} rows`, async () => {
    const driver = new PGliteDriver();
    const storage = new MemoryEstateStorage();
    const legacy = createClient({ schema: schema(true), driver });
    const current = createClient({ schema: schema(false), driver });
    try {
      const before = createMigrationClient(legacy, { storage });
      await before.generate({ name: "init" });
      await before.apply();
      // Rows written the 1.1.0 way: the database invented the omitted uuids.
      await driver._executeRaw(
        `INSERT INTO "uuid_default_accounts" ("email", "displayName", "updatedAt")
         SELECT 'user' || n || '@example.com', 'User ' || n, now()
         FROM generate_series(1, ${ROWS}) AS n`
      );
      await driver._executeRaw(
        `INSERT INTO "uuid_default_orders" ("number", "totalCents")
         SELECT 'N-' || n, n FROM generate_series(1, ${ROWS}) AS n`
      );

      const after = createMigrationClient(current, { storage });
      const upgrade = await after.generate({ name: "uuid-defaults" });
      expect(upgrade.outcome).toBe("published");
      expect(
        upgrade.operations.map((operation) =>
          operation.type === "alterColumn"
            ? `${operation.tableName}.${operation.columnName}: ${operation.from.default} -> ${operation.to.default}`
            : operation.type
        )
      ).toEqual([
        "uuid_default_accounts.externalRef: gen_random_uuid() -> undefined",
        "uuid_default_orders.id: gen_random_uuid() -> undefined",
      ]);
      expect(upgrade.sql.match(/DROP DEFAULT/g)).toHaveLength(2);
      await after.apply();

      expect(await columnDefaults(driver)).toEqual(CONVERGED);
      const { rows } = await driver._executeRaw<{
        accounts: number;
        orders: number;
      }>(
        `SELECT (SELECT count(*) FROM "uuid_default_accounts" WHERE "externalRef" IS NOT NULL)::int AS accounts,
                (SELECT count(*) FROM "uuid_default_orders")::int AS orders`
      );
      expect(rows[0]).toEqual({ accounts: ROWS, orders: ROWS });
      await expect(
        driver._executeRaw(
          `INSERT INTO "uuid_default_accounts" ("email", "displayName", "updatedAt") VALUES ('late@example.com', 'Late', now())`
        )
      ).rejects.toBeInstanceOf(NotNullConstraintError);
      expect((await after.generate({ name: "again" })).outcome).toBe("noop");
    } finally {
      await driver._disconnect();
    }
  });
});
