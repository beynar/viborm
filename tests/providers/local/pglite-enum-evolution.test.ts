import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import type { ResolveChange } from "@migrations/types";
import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

// Migration rewrite budget: adding enum values is catalog-only. A table whose
// relfilenode changes was rewritten under ACCESS EXCLUSIVE.
const ROWS = 10_000;
const family = usePGliteSchemaFamily({});

function tickets<const V extends readonly [string, ...string[]]>(
  values: V,
  fallback: V[number]
) {
  return {
    ticket: s
      .model({
        id: s.int().id().increment(),
        title: s.string(),
        priority: s.int().default(0),
        status: s
          .enum([...values])
          .name("ticket_status")
          .default(fallback),
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
      })
      .map("tickets"),
  };
}

async function estate(label: string) {
  const { database, namespace: base } = family();
  const namespace = `${base}_${label}`;
  await database.exec(`CREATE SCHEMA "${namespace}"`);
  const driver = new PGliteDriver({ client: database, namespace });
  const table = `"${namespace}"."tickets"`;
  const type = `"${namespace}"."ticket_status"`;
  return {
    driver,
    table,
    type,
    view: `"${namespace}"."open_tickets"`,
    seed: () =>
      database.exec(
        `INSERT INTO ${table} ("title", "status", "updatedAt") SELECT 'ticket ' || g, (CASE WHEN g % 2 = 0 THEN 'open' ELSE 'closed' END)::${type}, now() FROM generate_series(1, ${ROWS}) g`
      ),
    relfilenode: async () =>
      (
        await database.query<{ relfilenode: number }>(
          "SELECT c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'tickets'",
          [namespace]
        )
      ).rows[0]?.relfilenode,
    labels: async () =>
      (
        await database.query<{ enumlabel: string }>(
          "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'ticket_status' ORDER BY e.enumsortorder",
          [namespace]
        )
      ).rows.map((row) => row.enumlabel),
    query: <T>(sql: string) => database.query<T>(sql),
  };
}

describe("PostgreSQL enum evolution", () => {
  test("push adds values in place, past a dependent view, and recreates only for removal, reorder or same-batch use", async () => {
    const db = await estate("push");
    await syncLiveSchema(
      createClient({
        schema: tickets(["open", "closed"], "open"),
        driver: db.driver,
      })
    );
    await db.seed();
    await db.query(
      `CREATE VIEW ${db.view} AS SELECT "id", "title" FROM ${db.table} WHERE "status" = 'open'`
    );
    const original = await db.relfilenode();

    const appended = createClient({
      schema: tickets(["open", "closed", "archived"], "open"),
      driver: db.driver,
    });
    expect((await syncLiveSchema(appended)).sql).toEqual([
      `ALTER TYPE ${db.type} ADD VALUE 'archived'`,
    ]);
    const inserted = createClient({
      schema: tickets(
        ["open", "triage", "review", "closed", "archived"],
        "open"
      ),
      driver: db.driver,
    });
    expect((await syncLiveSchema(inserted)).sql).toEqual([
      `ALTER TYPE ${db.type} ADD VALUE 'triage' BEFORE 'closed'`,
      `ALTER TYPE ${db.type} ADD VALUE 'review' BEFORE 'closed'`,
    ]);
    expect(await db.relfilenode()).toBe(original);
    expect(await db.labels()).toEqual([
      "open",
      "triage",
      "review",
      "closed",
      "archived",
    ]);
    expect((await syncLiveSchema(inserted)).outcome).toBe("noop");
    await inserted.ticket.create({ data: { title: "new", status: "review" } });
    expect(await inserted.ticket.count({ where: { status: "review" } })).toBe(
      1
    );
    expect(
      (
        await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${db.view}`
        )
      ).rows
    ).toEqual([{ count: ROWS / 2 }]);

    // Using a value the same batch adds is the one addition that recreates.
    await db.query(`DROP VIEW ${db.view}`);
    const usedAtOnce = await syncLiveSchema(
      createClient({
        schema: tickets(
          ["open", "triage", "review", "blocked", "closed", "archived"],
          "blocked"
        ),
        driver: db.driver,
      })
    );
    expect(usedAtOnce.sql).toContain(`DROP TYPE ${db.type}`);
    const recreated = await db.relfilenode();
    expect(recreated).not.toBe(original);

    const reordered = createClient({
      schema: tickets(
        ["triage", "open", "review", "blocked", "closed", "archived"],
        "blocked"
      ),
      driver: db.driver,
    });
    await syncLiveSchema(reordered);
    expect(await db.relfilenode()).not.toBe(recreated);
    expect(await db.labels()).toEqual([
      "triage",
      "open",
      "review",
      "blocked",
      "closed",
      "archived",
    ]);

    await syncLiveSchema(
      createClient({
        schema: tickets(
          ["triage", "open", "review", "blocked", "closed"],
          "blocked"
        ),
        driver: db.driver,
      }),
      {
        resolve: (change: ResolveChange) =>
          change.type === "enumValueRemoval"
            ? change.mapValues({ archived: "closed" })
            : change.reject(),
      }
    );
    expect(await db.labels()).toEqual([
      "triage",
      "open",
      "review",
      "blocked",
      "closed",
    ]);
    expect(await reordered.ticket.count({ where: { status: "closed" } })).toBe(
      ROWS / 2
    );
  });

  test("generate and apply add values in place and commit them before a later migration uses them", async () => {
    const db = await estate("apply");
    const storage = new MemoryEstateStorage();
    const migrate = (
      values: readonly [string, ...string[]],
      fallback: string
    ) =>
      createMigrationClient(
        createClient({ schema: tickets(values, fallback), driver: db.driver }),
        { storage }
      );
    await migrate(["open", "closed"], "open").generate();
    await migrate(["open", "closed"], "open").apply();
    await db.seed();
    const original = await db.relfilenode();

    await migrate(["open", "closed", "archived"], "open").generate();
    await migrate(["open", "review", "closed", "archived"], "open").generate();
    await migrate(
      ["open", "review", "closed", "archived"],
      "review"
    ).generate();
    const latest = migrate(["open", "review", "closed", "archived"], "review");
    expect((await latest.apply()).statements).toEqual([
      `ALTER TYPE ${db.type} ADD VALUE 'archived'`,
      `ALTER TYPE ${db.type} ADD VALUE 'review' BEFORE 'closed'`,
      `ALTER TABLE ${db.table} ALTER COLUMN "status" SET DEFAULT 'review'`,
    ]);
    expect(await db.relfilenode()).toBe(original);
    expect(await db.labels()).toEqual(["open", "review", "closed", "archived"]);
    expect(
      (
        await db.query<{ status: string }>(
          `INSERT INTO ${db.table} ("title", "updatedAt") VALUES ('defaulted', now()) RETURNING "status"`
        )
      ).rows
    ).toEqual([{ status: "review" }]);

    // Retiring the value is a removal and recreates the type. Rolling back the
    // removal and then the default change restores the value and commits it
    // before the restored default uses it.
    await migrate(["open", "review", "closed", "archived"], "open").generate();
    const retired = migrate(["open", "closed", "archived"], "open");
    await retired.generate({
      resolve: (change: ResolveChange) =>
        change.type === "enumValueRemoval"
          ? change.mapValues({ review: "open" })
          : change.type === "destructive"
            ? change.proceed()
            : change.reject(),
    });
    await retired.apply();
    expect(await db.labels()).toEqual(["open", "closed", "archived"]);
    expect(await db.relfilenode()).not.toBe(original);
    await retired.down({ steps: 2 });
    expect(await db.labels()).toEqual(["open", "review", "closed", "archived"]);
    expect(
      (
        await db.query<{ status: string }>(
          `INSERT INTO ${db.table} ("title", "updatedAt") VALUES ('restored', now()) RETURNING "status"`
        )
      ).rows
    ).toEqual([{ status: "review" }]);

    // Reset replays the whole history to the head in one transaction, the
    // default that uses 'review' included: the type is created there, so its
    // added values are usable without a commit between edges.
    await retired.reset();
    expect(await db.labels()).toEqual(["open", "closed", "archived"]);
  });
});
