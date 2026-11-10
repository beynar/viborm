/**
 * PostgreSQL enum evolution against one live provider: the migration rewrite
 * budget of adding values (catalog-only, so a table's relfilenode survives),
 * the cases that still replace the type, and the commit boundaries a later
 * use of an added value needs. PGlite runs it locally; the pg leg runs it on
 * the CI server, whose major version decides whether reset may replay an
 * addition and its use in one transaction (only PostgreSQL 17+ allows it).
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import type { ResolveChange } from "@migrations/types";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

/** An empty, existing PostgreSQL schema and a driver bound to it. */
export type OpenEnumEvolutionNamespace = (
  label: string
) => Promise<{ readonly namespace: string; readonly driver: AnyDriver }>;

const ROWS = 10_000;

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

/** Tickets tagged with a list of the enum, defaulting to `tags`. */
function taggedTickets<const V extends readonly [string, ...string[]]>(
  values: V,
  tags: V[number][]
) {
  return {
    ticket: s
      .model({
        id: s.int().id().increment(),
        title: s.string(),
        tags: s
          .enum([...values])
          .name("ticket_status")
          .array()
          .default(tags),
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
      })
      .map("tickets"),
  };
}

/** Items whose `kind` a hand-written CHECK reads (#85). */
function items(values: readonly [string, ...string[]]) {
  return {
    item: s
      .model({
        id: s.int().id(),
        kind: s.enum([...values]).name("kind"),
        note: s.string().nullable(),
      })
      .map("items"),
  };
}

/** Tickets whose `resolution` is text or the enum, and an optional partial index. */
function resolvedTickets(
  values: readonly [string, ...string[]],
  typed: boolean,
  where?: string
) {
  const model = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      status: s.enum([...values]).name("ticket_status"),
      resolution: typed
        ? s
            .enum([...values])
            .name("ticket_status")
            .nullable()
        : s.string().nullable(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
    })
    .map("tickets");
  return {
    ticket:
      where === undefined
        ? model
        : model.index(["title"], { name: "tickets_flagged", where }),
  };
}

async function estate(open: OpenEnumEvolutionNamespace, label: string) {
  const { namespace, driver } = await open(label);
  const raw = createClient({ schema: {}, driver });
  const query = <T>(sql: string, ...params: unknown[]) =>
    raw.$queryRawUnsafe<T>(sql, ...params);
  const table = `"${namespace}"."tickets"`;
  const type = `"${namespace}"."ticket_status"`;
  return {
    namespace,
    driver,
    table,
    type,
    query,
    view: `"${namespace}"."open_tickets"`,
    exec: (sql: string) => raw.$executeRawUnsafe(sql),
    seed: () =>
      raw.$executeRawUnsafe(
        `INSERT INTO ${table} ("title", "status", "updatedAt") SELECT 'ticket ' || g, (CASE WHEN g % 2 = 0 THEN 'open' ELSE 'closed' END)::${type}, now() FROM generate_series(1, ${ROWS}) g`
      ),
    relfilenode: async () =>
      (
        await query<{ relfilenode: number }>(
          "SELECT c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'tickets'",
          namespace
        )
      )[0]?.relfilenode,
    labels: async () =>
      (
        await query<{ enumlabel: string }>(
          "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'ticket_status' ORDER BY e.enumsortorder",
          namespace
        )
      ).map((row) => row.enumlabel),
  };
}

/** The CHECKs, rows and `kind` labels of an estate's `items` table. */
function itemReads(db: Awaited<ReturnType<typeof estate>>, table: string) {
  return {
    constraints: () =>
      db.query<{ name: string; validated: boolean }>(
        "SELECT con.conname AS name, con.convalidated AS validated FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'items' AND con.contype = 'c' ORDER BY con.conname",
        db.namespace
      ),
    rows: () =>
      db.query<{ id: number; kind: string; note: string | null }>(
        `SELECT "id", "kind"::text AS "kind", "note" FROM ${table} ORDER BY "id"`
      ),
    labels: async () =>
      (
        await db.query<{ label: string }>(
          "SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'kind' ORDER BY e.enumsortorder",
          db.namespace
        )
      ).map((row) => row.label),
  };
}

const CHECK_ADDED_UNVALIDATED =
  /^ALTER TABLE .+ ADD CONSTRAINT "Not a legacy, unchecked" CHECK \(.+\) NOT VALID$/;
const CHECK_ADDED =
  /^ALTER TABLE .+ ADD CONSTRAINT "note_of_a" CHECK \(.+\)\)$/;

export function enumEvolutionTests(open: OpenEnumEvolutionNamespace): void {
  test("push adds values in place, past a dependent view, and recreates only for removal, reorder or same-batch use", async () => {
    const db = await estate(open, "push");
    await syncLiveSchema(
      createClient({
        schema: tickets(["open", "closed"], "open"),
        driver: db.driver,
      })
    );
    await db.seed();
    await db.exec(
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
      await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${db.view}`
      )
    ).toEqual([{ count: ROWS / 2 }]);

    // Using a value the same batch adds is the one addition that recreates.
    await db.exec(`DROP VIEW ${db.view}`);
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

  test("a partial-index predicate or a cast of stored data reading an added value recreates the type", async () => {
    const db = await estate(open, "reads");
    const push = (schema: ReturnType<typeof resolvedTickets>) =>
      syncLiveSchema(createClient({ schema, driver: db.driver }));
    await push(resolvedTickets(["open", "closed"], false));
    await db.seed();
    await db.exec(
      `UPDATE ${db.table} SET "resolution" = 'merged' WHERE "id" % 10 = 0`
    );
    const original = await db.relfilenode();

    // The cast runs first: a partial index comparing the column to a label
    // blocks every later type replacement (its predicate cannot cast to text).
    const merged = await push(
      resolvedTickets(["open", "closed", "merged"], true)
    );
    expect(merged.sql).toContain(`DROP TYPE ${db.type}`);
    expect(
      await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${db.table} WHERE "resolution" = 'merged'`
      )
    ).toEqual([{ count: ROWS / 10 }]);
    const recreated = await db.relfilenode();
    expect(recreated).not.toBe(original);

    const flagged = await push(
      resolvedTickets(
        ["open", "closed", "merged", "flagged"],
        true,
        "status = 'flagged'"
      )
    );
    expect(flagged.sql).toContain(`DROP TYPE ${db.type}`);
    expect(await db.relfilenode()).not.toBe(recreated);
    expect(await db.labels()).toEqual(["open", "closed", "merged", "flagged"]);

    // A generated migration replays its stored blob as written.
    const generated = await estate(open, "reads_apply");
    const storage = new MemoryEstateStorage();
    const migrate = (schema: ReturnType<typeof resolvedTickets>) =>
      createMigrationClient(
        createClient({ schema, driver: generated.driver }),
        { storage }
      );
    await migrate(resolvedTickets(["open", "closed"], false)).generate();
    await migrate(resolvedTickets(["open", "closed"], false)).apply();
    const indexed = resolvedTickets(
      ["open", "closed", "flagged"],
      false,
      "status = 'flagged'"
    );
    await migrate(indexed).generate();
    expect((await migrate(indexed).apply()).statements).toContain(
      `DROP TYPE ${generated.type}`
    );
    expect(await generated.labels()).toEqual(["open", "closed", "flagged"]);
  });

  test("a partial-index predicate naming the enum recreates it whatever spells the label; one naming another column adds in place", async () => {
    const db = await estate(open, "spellings");
    const push = (values: readonly [string, ...string[]], where?: string) =>
      syncLiveSchema(
        createClient({
          schema: resolvedTickets(values, false, where),
          driver: db.driver,
        })
      );
    await push(["open", "closed"]);
    await db.seed();
    await db.exec(
      `CREATE VIEW ${db.view} AS SELECT "id", "title" FROM ${db.table} WHERE "status" = 'open'`
    );
    const original = await db.relfilenode();

    // A text column compared to the new label never reads the enum.
    const unrelated = await push(
      ["open", "closed", "archived"],
      "title = 'archived'"
    );
    expect(unrelated.sql[0]).toBe(`ALTER TYPE ${db.type} ADD VALUE 'archived'`);
    expect(unrelated.sql).not.toContain(`DROP TYPE ${db.type}`);
    expect(await db.relfilenode()).toBe(original);

    await db.exec(`DROP VIEW ${db.view}`);
    const values: [string, ...string[]] = ["open", "closed", "archived"];
    for (const [label, where] of [
      ["dollar", "status = $$dollar$$"],
      ["cast", `status = 'cast'::${db.type}`],
      ["escape", "status = E'escape'"],
    ] as const) {
      values.push(label);
      expect((await push(values, where)).sql).toContain(`DROP TYPE ${db.type}`);
      // Its predicate would block the next replacement; drop the index.
      await push(values);
    }
    expect(await db.labels()).toEqual(values);
  });

  test("removing a value an enum-array default names restores the destination default", async () => {
    const db = await estate(open, "array_default");
    await syncLiveSchema(
      createClient({
        schema: taggedTickets(["bug", "ux", "legacy"], ["bug", "legacy"]),
        driver: db.driver,
      })
    );
    await db.exec(
      `INSERT INTO ${db.table} ("title", "updatedAt") SELECT 'ticket ' || g, now() FROM generate_series(1, ${ROWS}) g`
    );
    const retired = createClient({
      schema: taggedTickets(["bug", "ux"], ["bug"]),
      driver: db.driver,
    });
    // Restoring the old default, which names the removed value, would fail.
    await syncLiveSchema(retired, {
      resolve: (change: ResolveChange) =>
        change.type === "enumValueRemoval"
          ? change.mapValues({ legacy: "ux" })
          : change.reject(),
    });
    expect(await db.labels()).toEqual(["bug", "ux"]);
    expect(
      await retired.ticket.count({ where: { tags: { equals: ["bug", "ux"] } } })
    ).toBe(ROWS);
    expect(
      await db.query<{ tags: string }>(
        `INSERT INTO ${db.table} ("title", "updatedAt") VALUES ('defaulted', now()) RETURNING "tags"::text`
      )
    ).toEqual([{ tags: "{bug}" }]);
  });

  test("a recreation keeps the CHECK constraints on its columns: name, definition, validation and enforcement", async () => {
    const db = await estate(open, "checks");
    const table = `"${db.namespace}"."items"`;
    await syncLiveSchema(
      createClient({ schema: items(["a", "b"]), driver: db.driver })
    );
    await db.exec(
      `INSERT INTO ${table} VALUES (1, 'b', 'kept'), (2, 'b', NULL), (3, 'b', 'legacy')`
    );
    await db.exec(
      `ALTER TABLE ${table} ADD CONSTRAINT "note_of_a" CHECK ("kind" <> 'a' OR "note" IS NOT NULL)`
    );
    // Row 3 breaks this one once it is 'a': only NOT VALID adds it back.
    await db.exec(
      `ALTER TABLE ${table} ADD CONSTRAINT "Not a legacy, unchecked" CHECK ("kind" <> 'a' OR "note" <> 'legacy') NOT VALID`
    );
    const { constraints, rows, labels } = itemReads(db, table);
    const migrations = createMigrationClient(
      createClient({ schema: items(["a"]), driver: db.driver })
    );
    const preview = () =>
      migrations.push({
        dryRun: true,
        resolve: (change: ResolveChange) =>
          change.type === "enumValueRemoval"
            ? change.mapValues({ b: "a" })
            : change.reject(),
      });

    // The preview drops each CHECK before the text conversion and adds it
    // back, as the catalog deparses it, after the cast back.
    const planned = (await preview()).statements.map(({ sql }) => sql);
    const position = (prefix: string) =>
      planned.findIndex((sql) => sql.startsWith(prefix));
    expect(planned.filter((sql) => sql.includes(" CONSTRAINT "))).toEqual([
      `ALTER TABLE ${table} DROP CONSTRAINT "Not a legacy, unchecked"`,
      `ALTER TABLE ${table} DROP CONSTRAINT "note_of_a"`,
      expect.stringMatching(CHECK_ADDED_UNVALIDATED),
      expect.stringMatching(CHECK_ADDED),
    ]);
    expect(position(`ALTER TABLE ${table} DROP CONSTRAINT`)).toBeLessThan(
      position(`ALTER TABLE ${table} ALTER COLUMN "kind" TYPE text`)
    );
    expect(
      position(
        `ALTER TABLE ${table} ALTER COLUMN "kind" TYPE "${db.namespace}"."kind"`
      )
    ).toBeLessThan(position(`ALTER TABLE ${table} ADD CONSTRAINT`));

    // Row 2 becomes ('a', NULL), which note_of_a refuses: the whole
    // recreation rolls back, the CHECKs and the removed value included.
    await expect(
      migrations.push({ consent: (await preview()).consent })
    ).rejects.toThrow();
    expect(await labels()).toEqual(["a", "b"]);
    expect(await rows()).toEqual([
      { id: 1, kind: "b", note: "kept" },
      { id: 2, kind: "b", note: null },
      { id: 3, kind: "b", note: "legacy" },
    ]);
    expect(await constraints()).toEqual([
      { name: "Not a legacy, unchecked", validated: false },
      { name: "note_of_a", validated: true },
    ]);

    await db.exec(`UPDATE ${table} SET "note" = 'filled' WHERE "id" = 2`);
    expect(
      (await migrations.push({ consent: (await preview()).consent })).outcome
    ).toBe("applied");
    expect(await labels()).toEqual(["a"]);
    expect(await rows()).toEqual([
      { id: 1, kind: "a", note: "kept" },
      { id: 2, kind: "a", note: "filled" },
      { id: 3, kind: "a", note: "legacy" },
    ]);
    // The same names, the unvalidated one still unvalidated, both enforced.
    expect(await constraints()).toEqual([
      { name: "Not a legacy, unchecked", validated: false },
      { name: "note_of_a", validated: true },
    ]);
    for (const note of ["NULL", "'legacy'"])
      await expect(
        db.exec(`INSERT INTO ${table} VALUES (4, 'a', ${note})`)
      ).rejects.toMatchObject({ code: VibORMErrorCode.CHECK_CONSTRAINT });
    expect(await rows()).toHaveLength(3);
    expect(
      (
        await syncLiveSchema(
          createClient({ schema: items(["a"]), driver: db.driver })
        )
      ).outcome
    ).toBe("noop");
  });

  test("a CHECK naming a value the change removes is refused before any effect", async () => {
    const db = await estate(open, "checks_refused");
    const table = `"${db.namespace}"."items"`;
    await syncLiveSchema(
      createClient({ schema: items(["a", "b", "c"]), driver: db.driver })
    );
    await db.exec(
      `ALTER TABLE ${table} ADD CONSTRAINT "never_b" CHECK ("kind" <> 'b')`
    );
    await db.exec(`INSERT INTO ${table} VALUES (1, 'c', NULL)`);
    const { constraints, rows, labels } = itemReads(db, table);
    const migrations = createMigrationClient(
      createClient({ schema: items(["a", "c"]), driver: db.driver })
    );
    const resolve = (change: ResolveChange) =>
      change.type === "enumValueRemoval"
        ? change.mapValues({ b: "a" })
        : change.reject();
    const refusal = {
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        `CHECK constraint "never_b" on "items" names the value 'b'`
      ),
    };
    await expect(
      migrations.push({ dryRun: true, resolve })
    ).rejects.toMatchObject(refusal);
    await expect(migrations.push({ resolve })).rejects.toMatchObject(refusal);
    expect(await labels()).toEqual(["a", "b", "c"]);
    expect(await rows()).toEqual([{ id: 1, kind: "c", note: null }]);
    expect(await constraints()).toEqual([{ name: "never_b", validated: true }]);
  });

  test("generate and apply add values in place and commit them before a later migration uses them", async () => {
    const db = await estate(open, "apply");
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
      await db.query<{ status: string }>(
        `INSERT INTO ${db.table} ("title", "updatedAt") VALUES ('defaulted', now()) RETURNING "status"`
      )
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
      await db.query<{ status: string }>(
        `INSERT INTO ${db.table} ("title", "updatedAt") VALUES ('restored', now()) RETURNING "status"`
      )
    ).toEqual([{ status: "review" }]);

    // Reset replays the whole history, the default that uses 'review'
    // included, committing after each migration that adds values: before
    // PostgreSQL 17 even a type reset itself created refuses them until then.
    await retired.reset();
    expect(await db.labels()).toEqual(["open", "closed", "archived"]);
  });
}
