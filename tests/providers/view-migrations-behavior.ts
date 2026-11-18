/**
 * Views (`s.view`) through the real migration paths, on one provider: push
 * creates a view and reads it back by its marker (a second push is a no-op),
 * replaces it when its hash changes, drops and creates it again around a
 * column type change, a column rename and a table rename, keeps a view on a
 * view in order, drops it when undeclared, replaces a table of its name with
 * consent and refuses a hand-made view of its name before any effect, and generate, apply, verify, down and reset converge.
 *
 * The test file mocks `@migrations/view-definition` with
 * `testViewDefinition` (`./view-definitions`): the body is written per
 * dialect here, the identity is the hash this file gives.
 */

import type { AnyDriver } from "@drivers";
import { qualifiedName } from "@migrations/catalog-probes";
import { CONTROL_TABLES } from "@migrations/control";
import {
  createMigrationClient,
  MemoryEstateStorage,
} from "@migrations/dialects/all";
import { getMigrationDriver } from "@migrations/drivers";
import type { ResolveCallback, ViewDef } from "@migrations/types";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";
import { testView } from "./view-definitions";

const POSTS = "view_posts";
const ARTICLES = "view_articles";
const FEED = "view_feed";
const DIGEST = "view_digest";
const FEED_A = "a".repeat(40);
const FEED_B = "b".repeat(40);
const DIGEST_HASH = "c0".repeat(20);

/** What a push that plans nothing answers. */
const NOOP = { outcome: "noop", operations: [] };
const DROP_DIGEST = /^DROP VIEW .*view_digest/;
const DROP_FEED = /^DROP VIEW .*view_feed/;
const DROP_POSTS = /^DROP TABLE .*view_posts/;
const VIEW_OVER_FOREIGN_VIEW =
  /relation "view_feed" is a view VibORM did not create, but this schema declares a view/;

/** One version of the schema. */
interface Shape {
  readonly table: typeof POSTS | typeof ARTICLES;
  readonly title: "title" | "heading";
  readonly bigScore: boolean;
  /** Which body and hash the feed has, or none. */
  readonly feed?: "A" | "B";
  /** A view reading the feed. */
  readonly digest?: boolean;
}

const FIRST: Shape = {
  table: POSTS,
  title: "title",
  bigScore: false,
  feed: "A",
};

function schemaOf(shape: Shape): Record<string, AnyModel> {
  // A type and a nullability change: an alteration on every dialect (SQLite
  // stores both integers alike, and rebuilds the table for the nullability).
  const score = shape.bigScore ? s.bigInt().nullable() : s.int();
  const post = (
    shape.title === "title"
      ? s.model({ id: s.string().id(), title: s.string(), score })
      : s.model({ id: s.string().id(), heading: s.string(), score })
  ).map(shape.table);
  const schema: Record<string, AnyModel> = { post };
  if (shape.feed !== undefined) {
    const floor = shape.feed === "A" ? 0 : 1;
    schema.feed = testView(post, FEED, {
      hash: shape.feed === "A" ? FEED_A : FEED_B,
      dependsOn: [shape.table],
      body: ({ table, column }) =>
        `SELECT ${column("id")}, ${column(shape.title)}, ${column("score")} FROM ${table(shape.table)} WHERE ${column("score")} > ${floor}`,
    });
  }
  if (shape.digest)
    schema.digest = testView(post, DIGEST, {
      hash: DIGEST_HASH,
      dependsOn: [FEED],
      body: ({ table, column }) => `SELECT ${column("id")} FROM ${table(FEED)}`,
    });
  return schema;
}

/** Renames are renames, and a type change is accepted. */
const resolve: ResolveCallback = (change) => {
  if (change.type === "ambiguous") return change.rename();
  if (change.type === "destructive") return change.proceed();
  return undefined;
};

export interface ViewBehaviorOptions {
  readonly driverName: string;
  /** A driver on an empty database or namespace. */
  readonly createDriver: () => AnyDriver | Promise<AnyDriver>;
}

export function runViewMigrationBehavior({
  driverName,
  createDriver,
}: ViewBehaviorOptions): void {
  describe(`${driverName} views`, () => {
    async function withDriver(
      run: (driver: AnyDriver) => Promise<void>
    ): Promise<void> {
      const driver = await createDriver();
      try {
        await run(driver);
      } finally {
        const command = getMigrationDriver(driver);
        for (const table of [CONTROL_TABLES.log, CONTROL_TABLES.state])
          await driver._executeRaw(
            `DROP TABLE IF EXISTS ${qualifiedName(command, table)}`
          );
        // What VibORM marked goes with the empty schema; the hand-made
        // objects of the refusals are dropped by their test.
        await syncLiveSchema({ $driver: driver, $schema: {} });
        await driver.disconnect();
      }
    }

    const client = (driver: AnyDriver, shape: Shape) => ({
      $driver: driver,
      $schema: schemaOf(shape),
    });

    /** Push `shape` through preview and consent; the operations it ran. */
    async function push(driver: AnyDriver, shape: Shape): Promise<string[]> {
      const migrations = createMigrationClient(client(driver, shape));
      const preview = await migrations.push({ dryRun: true, resolve });
      const result = await migrations.push({ consent: preview.consent });
      return result.operations.map(({ label }) => label);
    }

    /** A push of `shape` without consent: a no-op when the live views read back equal. */
    function pushAgain(driver: AnyDriver, shape: Shape) {
      return createMigrationClient(client(driver, shape)).push();
    }

    async function liveViews(driver: AnyDriver): Promise<ViewDef[]> {
      const live = await getMigrationDriver(driver).introspect(
        (statement, parameters) => driver._executeRaw(statement, parameters)
      );
      return live.views ?? [];
    }

    async function names(driver: AnyDriver): Promise<[string, string][]> {
      return (await liveViews(driver)).map(({ name, hash }) => [name, hash]);
    }

    async function ids(driver: AnyDriver, view: string): Promise<string[]> {
      const command = getMigrationDriver(driver);
      const id = command.escapeIdentifier("id");
      const rows = await driver._executeRaw<{ id: string }>(
        `SELECT ${id} AS ${id} FROM ${qualifiedName(command, view)} ORDER BY ${id}`
      );
      return rows.rows.map((row) => row.id);
    }

    async function seed(driver: AnyDriver): Promise<void> {
      const command = getMigrationDriver(driver);
      const column = (name: string) => command.escapeIdentifier(name);
      await driver._executeRaw(
        `INSERT INTO ${qualifiedName(command, POSTS)} (${column("id")}, ${column("title")}, ${column("score")}) VALUES ('p0', 'zero', 0), ('p1', 'one', 1), ('p2', 'two', 2)`
      );
    }

    test("push creates, reads back, replaces, follows what it reads and drops", async () => {
      await withDriver(async (driver) => {
        expect(await push(driver, FIRST)).toEqual([
          `+ Create table "${POSTS}" with 3 columns`,
          `+ Create view "${FEED}"`,
        ]);
        expect(await names(driver)).toEqual([[FEED, FEED_A]]);
        expect(await pushAgain(driver, FIRST)).toMatchObject(NOOP);
        await seed(driver);
        expect(await ids(driver, FEED)).toEqual(["p1", "p2"]);

        // A new hash: dropped and created again.
        const second: Shape = { ...FIRST, feed: "B" };
        expect(await push(driver, second)).toEqual([
          `- Drop view "${FEED}"`,
          `+ Create view "${FEED}"`,
        ]);
        expect(await names(driver)).toEqual([[FEED, FEED_B]]);
        expect(await pushAgain(driver, second)).toMatchObject(NOOP);
        expect(await ids(driver, FEED)).toEqual(["p2"]);

        // A column type change under it (PostgreSQL refuses one under a view,
        // SQLite rebuilds the table): the same view, around it.
        const wide: Shape = { ...second, bigScore: true };
        expect(await push(driver, wide)).toEqual([
          `- Drop view "${FEED}"`,
          `~ Alter column "score" in "${POSTS}"`,
          `+ Create view "${FEED}"`,
        ]);
        expect(await pushAgain(driver, wide)).toMatchObject(NOOP);
        expect(await ids(driver, FEED)).toEqual(["p2"]);

        // A column rename (MySQL's view breaks on one, SQLite rewrites it).
        const heading: Shape = { ...wide, title: "heading" };
        expect(await push(driver, heading)).toEqual([
          `- Drop view "${FEED}"`,
          `~ Rename column "title" → "heading" in "${POSTS}"`,
          `+ Create view "${FEED}"`,
        ]);
        expect(await pushAgain(driver, heading)).toMatchObject(NOOP);
        expect(await ids(driver, FEED)).toEqual(["p2"]);

        // A table rename.
        const articles: Shape = { ...heading, table: ARTICLES };
        expect(await push(driver, articles)).toEqual([
          `- Drop view "${FEED}"`,
          `~ Rename table "${POSTS}" → "${ARTICLES}"`,
          `+ Create view "${FEED}"`,
        ]);
        expect(await pushAgain(driver, articles)).toMatchObject(NOOP);
        expect(await ids(driver, FEED)).toEqual(["p2"]);

        // A view on the view: created after it.
        const digest: Shape = { ...articles, digest: true };
        expect(await push(driver, digest)).toEqual([
          `+ Create view "${DIGEST}"`,
        ]);
        expect(await pushAgain(driver, digest)).toMatchObject(NOOP);
        expect(await ids(driver, DIGEST)).toEqual(["p2"]);

        // The feed replaced under it: the digest goes first and comes back last.
        const back: Shape = { ...digest, feed: "A" };
        expect(await push(driver, back)).toEqual([
          `- Drop view "${DIGEST}"`,
          `- Drop view "${FEED}"`,
          `+ Create view "${FEED}"`,
          `+ Create view "${DIGEST}"`,
        ]);
        expect(await names(driver)).toEqual([
          [DIGEST, DIGEST_HASH],
          [FEED, FEED_A],
        ]);
        expect(await pushAgain(driver, back)).toMatchObject(NOOP);
        expect(await ids(driver, DIGEST)).toEqual(["p1", "p2"]);

        // Undeclared: dropped, the reader first.
        const none: Shape = { ...back, feed: undefined, digest: false };
        expect(await push(driver, none)).toEqual([
          `- Drop view "${DIGEST}"`,
          `- Drop view "${FEED}"`,
        ]);
        expect(await names(driver)).toEqual([]);
        expect(await pushAgain(driver, none)).toMatchObject(NOOP);
      });
    });

    test("a name the database holds as something VibORM cannot take over is refused before any effect", async () => {
      await withDriver(async (driver) => {
        const command = getMigrationDriver(driver);
        const feed = qualifiedName(command, FEED);
        const id = command.escapeIdentifier("id");
        await push(driver, { ...FIRST, feed: undefined });
        await seed(driver);

        // A table under the view's name is an undeclared table of this push:
        // dropped with the consent a drop takes, never without it.
        await driver._executeRaw(
          `CREATE TABLE ${feed} (${id} VARCHAR(10) PRIMARY KEY)`
        );
        await driver._executeRaw(`INSERT INTO ${feed} (${id}) VALUES ('kept')`);
        await expect(pushAgain(driver, FIRST)).rejects.toMatchObject({
          code: "V11017",
        });
        expect(await ids(driver, FEED)).toEqual(["kept"]);
        expect(await push(driver, FIRST)).toEqual([
          `- Drop table "${FEED}"`,
          `+ Create view "${FEED}"`,
        ]);
        expect(await ids(driver, FEED)).toEqual(["p1", "p2"]);
        await push(driver, { ...FIRST, feed: undefined });

        // A view VibORM did not create under the view's name.
        await driver._executeRaw(
          `CREATE VIEW ${feed} AS SELECT ${id} FROM ${qualifiedName(command, POSTS)}`
        );
        await expect(push(driver, FIRST)).rejects.toMatchObject({
          code: "V11009",
          message: expect.stringMatching(VIEW_OVER_FOREIGN_VIEW),
        });
        expect(await ids(driver, FEED)).toEqual(["p0", "p1", "p2"]);
        expect(await names(driver)).toEqual([]);
        await driver._executeRaw(`DROP VIEW ${feed}`);

        // VibORM's own view under a table's name is its to drop: the view
        // becomes a table in one push.
        await push(driver, FIRST);
        const table = testTableNamed(FEED);
        const migrations = createMigrationClient({
          $driver: driver,
          $schema: { post: schemaOf(FIRST).post!, table },
        });
        const preview = await migrations.push({ dryRun: true, resolve });
        const result = await migrations.push({ consent: preview.consent });
        expect(result.operations.map(({ label }) => label)).toEqual([
          `- Drop view "${FEED}"`,
          `+ Create table "${FEED}" with 1 columns`,
        ]);
        expect(await names(driver)).toEqual([]);
      });
    });

    test("a force-reset push drops the views before the tables and builds them again", async () => {
      await withDriver(async (driver) => {
        const shape: Shape = { ...FIRST, digest: true };
        await push(driver, shape);
        const migrations = createMigrationClient(client(driver, shape));
        const preview = await migrations.push({
          dryRun: true,
          forceReset: true,
        });
        const at = (statement: RegExp) =>
          preview.statements.findIndex(({ sql }) => statement.test(sql));
        // The clear first: the reader, then what it reads, then the table.
        expect(at(DROP_DIGEST)).toBe(0);
        expect(at(DROP_FEED)).toBe(1);
        expect(at(DROP_POSTS)).toBeGreaterThan(1);
        await migrations.push({ consent: preview.consent });
        expect(await names(driver)).toEqual([
          [DIGEST, DIGEST_HASH],
          [FEED, FEED_A],
        ]);
        expect(await pushAgain(driver, shape)).toMatchObject(NOOP);
      });
    });

    test("generate, apply, verify, down and reset converge", async () => {
      await withDriver(async (driver) => {
        const storage = new MemoryEstateStorage();
        const step = async (name: string, shape: Shape) => {
          const migrations = createMigrationClient(client(driver, shape), {
            storage,
          });
          await migrations.generate({ name, resolve: resolve as never });
          await expect(migrations.apply()).resolves.toMatchObject({
            outcome: "applied",
          });
          await expect(migrations.verify()).resolves.toEqual({ ok: true });
          return migrations;
        };
        await step("first", FIRST);
        // The type change rebuilds the feed around it in the history too.
        await step("wide", { ...FIRST, bigScore: true });
        const migrations = await step("digest", {
          ...FIRST,
          bigScore: true,
          feed: "B",
          digest: true,
        });
        expect(await names(driver)).toEqual([
          [DIGEST, DIGEST_HASH],
          [FEED, FEED_B],
        ]);

        await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
          preview: false,
        });
        await expect(migrations.verify()).resolves.toEqual({ ok: true });
        expect(await names(driver)).toEqual([[FEED, FEED_A]]);

        await expect(migrations.reset()).resolves.toMatchObject({
          preview: false,
        });
        await expect(migrations.verify()).resolves.toEqual({ ok: true });
        expect(await names(driver)).toEqual([
          [DIGEST, DIGEST_HASH],
          [FEED, FEED_B],
        ]);
      });
    });
  });
}

/** A one-column table named `name`. */
function testTableNamed(name: string): AnyModel {
  return s.model({ id: s.string().id() }).map(name);
}
