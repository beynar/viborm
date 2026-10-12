/**
 * What a tenant migrator drives over RPC (plan D4 steps 7–9), on SQLite.
 *
 * - T1: the same document gives the same ids, and a document that only
 *   reorders models and fields is a `noop` that publishes nothing
 *   (decision 8; 1.1.0 published an empty state).
 * - T2: `createPredefinedResolver` turns plain JSON decisions into the
 *   resolve callback: renames, enum mappings and the destructive allow-list,
 *   refusing what they do not name and any decision that names nothing
 *   before anything is published; resending a published document with its
 *   decisions is a `noop`, so a tenant migrator's retry reaches apply.
 * - platform-12: `down({ dryRun: true })` returns each edge's rollback SQL
 *   and the refusal `down` would raise (1.1.0 returned `{ path, preview }`).
 * - The operator results cross an RPC boundary: they survive structuredClone.
 *
 * PGlite runs T1 and the preview's refusals in `tenant-intent-pglite.test.ts`.
 */

import { createClient as createEstateClient } from "@client/client";
import { createClient } from "@drivers/sqlite3";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { createPredefinedResolver } from "@migrations/resolver";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import { parseSchema } from "@schema/json";
import { sql } from "@sql";
import {
  documentOrderFacts,
  INVOICE_ROWS,
} from "@tests/unit/migrations/_tenant-documents";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MemoryStorage, pgEstateDriver } from "./_estate";

const ROWS = 2000;
const DROP_LINE_ITEM = /DROP TABLE "lineItem"/;

test("same document gives the same ids, and reordered fields give 0 operations (SQLite)", async () => {
  const db = new Database(":memory:");
  try {
    const facts = await documentOrderFacts(
      (documentText) =>
        createClient({ client: db, schema: parseSchema(documentText) }),
      async (sqlText) => db.exec(sqlText)
    );
    expect(facts.second).toMatchObject({
      stateId: facts.first.stateId,
      snapshotHash: facts.first.snapshotHash,
      sqlHash: facts.first.sqlHash,
    });
    expect(facts.reorder).toMatchObject({
      outcome: "noop",
      stateId: null,
      operations: [],
    });
    expect(facts.published).toBe(0);
    expect(facts.pending).toEqual([]);
    expect(facts.verified).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM "invoice"').get()
    ).toMatchObject({ n: INVOICE_ROWS });
  } finally {
    db.close();
  }
});

describe("createPredefinedResolver: decisions as data", () => {
  const accountFields = {
    id: { type: "string", id: true },
    email: { type: "string", unique: true },
    name: { type: "string" },
    tier: { type: "enum", enum: "tier", default: "free" },
    balance: { type: "int", default: 0 },
    country: { type: "string", nullable: true },
    legacyCode: { type: "string", nullable: true },
    settings: { type: "json", nullable: true },
    createdAt: { type: "datetime", generate: { kind: "now" } },
  };
  const base = {
    version: 1,
    enums: { tier: { values: ["free", "pro", "legacy"] } },
    models: { account: { fields: accountFields } },
  };
  const { name, legacyCode: _dropped, ...kept } = accountFields;
  const next = {
    version: 1,
    enums: { tier: { values: ["free", "pro"] } },
    models: { account: { fields: { ...kept, displayName: name } } },
  };
  const rename = {
    type: "column",
    tableName: "account",
    from: "name",
    to: "displayName",
    resolution: "rename",
  } as const;
  const drop = {
    type: "destructive",
    operation: "dropColumn",
    table: "account",
    column: "legacyCode",
  } as const;
  const mapping = {
    type: "enumValueRemoval",
    tableName: "account",
    columnName: "tier",
    mapValues: { legacy: "free" },
  } as const;

  /** One estate at `base` with 2,000 accounts, a third of them `legacy`. */
  async function seeded() {
    const db = new Database(":memory:");
    const storage = new MemoryEstateStorage();
    const open = (document: object) =>
      createClient({ client: db, schema: parseSchema(document) });
    const migrations = createMigrationClient(open(base), { storage });
    await migrations.generate({ name: "base" });
    await migrations.apply();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
INSERT INTO "account" ("id", "email", "name", "tier", "legacyCode")
SELECT 'a-' || i, 'a' || i || '@example.test', 'Name ' || i,
  CASE i % 3 WHEN 0 THEN 'legacy' ELSE 'pro' END, 'L' || i FROM n`);
    return {
      db,
      tenant: createMigrationClient(open(next), { storage }),
    };
  }

  /** The decisions as an API would carry them: through JSON. */
  const overJson = (decisions: readonly object[]) =>
    createPredefinedResolver(JSON.parse(JSON.stringify(decisions)));

  test("renames, enum mappings and allowed drops publish and apply", async () => {
    const { db, tenant } = await seeded();
    try {
      const generated = await tenant.generate({
        name: "next",
        resolve: overJson([rename, drop, mapping]),
      });
      expect(generated.outcome).toBe("published");
      expect(generated.operations.map((operation) => operation.type)).toEqual(
        expect.arrayContaining(["renameColumn", "dropColumn", "alterEnum"])
      );
      const shown = await tenant.show({ name: "next" });
      expect(JSON.stringify(shown)).toContain('"operation":"dropColumn"');
      await tenant.apply();
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n, SUM("tier" = 'free') AS free, MIN("displayName") AS first FROM "account"`
          )
          .get()
      ).toEqual({ n: ROWS, free: Math.floor(ROWS / 3), first: "Name 1" });
    } finally {
      db.close();
    }
  });

  test("a change no decision names is refused", async () => {
    const { db, tenant } = await seeded();
    try {
      await expect(
        tenant.generate({ name: "next", resolve: overJson([rename, mapping]) })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      });
      await expect(
        tenant.generate({ name: "next", resolve: overJson([rename, drop]) })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      });
    } finally {
      db.close();
    }
  });

  test("a decision that matches no change is refused, and nothing is published", async () => {
    const { db, tenant } = await seeded();
    try {
      const states = (await tenant.list()).length;
      for (const stray of [
        { ...drop, column: "noSuchColumn" },
        { ...rename, tableName: "noSuchTable" },
        { type: "table", from: "account", to: "member", resolution: "rename" },
      ]) {
        await expect(
          tenant.generate({
            name: "next",
            resolve: overJson([rename, drop, mapping, stray]),
          })
        ).rejects.toMatchObject({
          code: VibORMErrorCode.INVALID_INPUT,
          message: expect.stringContaining("match no change"),
        });
      }
      expect((await tenant.list()).length).toBe(states);
    } finally {
      db.close();
    }
  });
  test("resending a published document with its decisions is a noop, before and after apply", async () => {
    const { db, tenant } = await seeded();
    try {
      const resend = () =>
        tenant.generate({
          name: "next",
          resolve: overJson([rename, drop, mapping]),
        });
      expect((await resend()).outcome).toBe("published");
      // The response was lost or the apply failed: the retry must reach apply.
      expect(await resend()).toMatchObject({ outcome: "noop", stateId: null });
      await tenant.apply();
      expect(await resend()).toMatchObject({ outcome: "noop", stateId: null });
      expect(await tenant.list()).toHaveLength(2);
      expect((await tenant.status()).pending).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a stray decision publishes nothing where a PostgreSQL change splits into low-lock steps", async () => {
    const storage = new MemoryStorage();
    const fields = { id: s.string().id(), country: s.string() };
    const account = (next: boolean) =>
      createMigrationClient(
        createEstateClient({
          schema: {
            account: next
              ? s
                  .model({ ...fields, nickname: s.string().nullable() })
                  .index(["country"])
                  .map("accounts")
              : s.model(fields).map("accounts"),
          },
          driver: pgEstateDriver("public"),
        }),
        { storage }
      );
    await account(false).generate({ name: "v1" });
    const tenant = account(true);
    const stray = { ...rename, tableName: "accounts" };
    await expect(
      tenant.generate({
        name: "v2",
        lowLock: true,
        resolve: overJson([stray]),
      })
    ).rejects.toMatchObject({ code: VibORMErrorCode.INVALID_INPUT });
    expect(await tenant.list()).toHaveLength(1);
    // Without the stray decision the same change publishes its steps.
    await tenant.generate({ name: "v2", lowLock: true, resolve: overJson([]) });
    expect((await tenant.list()).length).toBeGreaterThan(2);
  });
});

describe("down({ dryRun: true }) previews the rollback and its refusal", () => {
  const invoice = s.model({
    id: s.string().id(),
    number: s.string().unique(),
    customerEmail: s.string(),
    amountCents: s.int(),
    createdAt: s.dateTime().now(),
  });
  const lineItem = s.model({
    id: s.string().id(),
    invoiceId: s.string(),
    sku: s.string(),
    quantity: s.int(),
    unitCents: s.int(),
  });
  const proceed: ResolveCallback = (change) =>
    change.type === "destructive" ? change.proceed() : undefined;

  /** invoices, then line items holding 2,000 rows. */
  async function twoStates() {
    const db = new Database(":memory:");
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(
      createClient({ client: db, schema: { invoice } }),
      { storage }
    );
    await first.generate({ name: "invoices" });
    await first.apply();
    const migrations = createMigrationClient(
      createClient({ client: db, schema: { invoice, lineItem } }),
      { storage }
    );
    await migrations.generate({ name: "line-items" });
    await migrations.apply();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
INSERT INTO "lineItem" ("id", "invoiceId", "sku", "quantity", "unitCents")
SELECT 'li-' || i, 'inv-' || i, 'sku-' || i, 1, 100 FROM n`);
    return { db, migrations };
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<Error> {
    try {
      await run();
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test("shows the rollback SQL and the consent down needs, and changes nothing", async () => {
    const { db, migrations } = await twoStates();
    try {
      const before = await migrations.status();
      const preview = await migrations.down({ dryRun: true });
      const real = await refusalOf(() => migrations.down());
      expect(real).toMatchObject({
        code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
      });
      expect(preview).toMatchObject({
        preview: true,
        path: [before.marker?.stateId],
        edges: [
          {
            stateId: before.marker?.stateId,
            sql: expect.stringMatching(DROP_LINE_ITEM),
          },
        ],
        refusal: {
          code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
          message: real.message,
        },
      });
      expect(
        await migrations.down({ dryRun: true, resolve: proceed })
      ).toMatchObject({ refusal: null });
      expect(await migrations.status()).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS n FROM "lineItem"').get()).toEqual({
        n: ROWS,
      });
    } finally {
      db.close();
    }
  });

  test("refuses an irreversible step as down does", async () => {
    const { db, migrations } = await twoStates();
    try {
      const at = (await migrations.show({ name: "line-items" })).stateId;
      await migrations.generate({
        name: "normalize-sku",
        manualMigration: {
          transitions: [
            {
              from: at,
              execution: "transactional",
              up: [sql.raw(`UPDATE "lineItem" SET "sku" = upper("sku")`)],
              rollback: { kind: "irreversible", reason: "sku case is lost" },
            },
          ],
        },
      });
      await migrations.apply();
      const preview = await migrations.down({ dryRun: true, resolve: proceed });
      await expect(migrations.down({ resolve: proceed })).rejects.toMatchObject(
        {
          code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
          message: "sku case is lost",
        }
      );
      expect(preview).toMatchObject({
        edges: [
          {
            sql: expect.stringContaining(
              "ROLLBACK unavailable: sku case is lost"
            ),
          },
        ],
        refusal: {
          code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
          message: "sku case is lost",
        },
      });
    } finally {
      db.close();
    }
  });

  test("refuses drift as down does", async () => {
    const { db, migrations } = await twoStates();
    try {
      db.exec('ALTER TABLE "invoice" ADD COLUMN "stray" TEXT');
      const real = await refusalOf(() => migrations.down({ resolve: proceed }));
      expect(real).toMatchObject({ code: VibORMErrorCode.MIGRATION_DRIFT });
      expect(
        await migrations.down({ dryRun: true, resolve: proceed })
      ).toMatchObject({
        refusal: {
          code: VibORMErrorCode.MIGRATION_DRIFT,
          message: real.message,
        },
      });
      // Down to where it already is does nothing, so neither checks drift.
      const here = { to: { name: "line-items" } };
      expect(await migrations.down(here)).toEqual({ path: [], preview: false });
      expect(await migrations.down({ ...here, dryRun: true })).toEqual({
        path: [],
        preview: true,
        edges: [],
        refusal: null,
      });
    } finally {
      db.close();
    }
  });

  test("status, log, show and the preview are plain data an RPC call can carry", async () => {
    const { db, migrations } = await twoStates();
    try {
      for (const result of [
        await migrations.status(),
        await migrations.log(),
        await migrations.show({ name: "line-items" }),
        await migrations.down({ dryRun: true }),
      ]) {
        expect(structuredClone(result)).toEqual(result);
      }
    } finally {
      db.close();
    }
  });
});
