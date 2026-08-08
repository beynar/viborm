import { defineContract } from "@tests/contracts/contract";
/**
 * Foreign-key index on the to-many side — live driver behavior.
 *
 * The serializer emits an index for the FK columns every `manyToOne` relation
 * holds, because that is the column every include, every relation filter and
 * every nested-write locate reads the child table through. Only MySQL/InnoDB
 * indexes an FK constraint by itself; PostgreSQL and SQLite scan the whole
 * child table without it.
 *
 * Two suites live here:
 * - `runFkIndexBehavior` proves the index reaches the database (its own
 *   catalog: `pg_indexes`, `sqlite_master`, `information_schema.STATISTICS`),
 *   that a second push is not a change, and that a `.index()` the schema
 *   already declares is not duplicated. Wired on every driver.
 * - `runFkIndexUpgradeBehavior` proves a database that predates the index gains
 *   it — the upgrade path, where SQLite's table recreation used to destroy the
 *   index in the same push that created it. Wired on PGlite, SQLite3 and
 *   LibSQL: on MySQL the state cannot exist, because InnoDB keeps an index on
 *   the FK column whether or not viborm asks for one.
 * - `runFkIndexPlanBehavior` proves the index is what the planner uses for an
 *   include at volume. Wired on PGlite and SQLite3, the two dialects that had
 *   no FK index at all before.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, describe, expect, test } from "vitest";

// --- Schema 1: a plain to-many, with a mapped FK column ----------------------
// The FK scalar is mapped, so a serializer that wrote the TypeScript field name
// into the index would not merely mis-name the index: CREATE INDEX would name a
// column that does not exist and the push would fail.
const fkIdxUser = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => fkIdxPost),
  })
  .map("fk_idx_users");

const fkIdxPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().map("author_id"),
    author: s
      .manyToOne(() => fkIdxUser)
      .fields("authorId")
      .references("id"),
  })
  .map("fk_idx_posts");

const fkIndexSchema = { fkIdxUser, fkIdxPost };

// --- Schema 2: the same relation, with the index already declared ------------
const declaredUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => declaredPost),
  })
  .map("fk_idx_decl_users");

const declaredPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .manyToOne(() => declaredUser)
      .fields("authorId")
      .references("id"),
  })
  .index(["authorId"])
  .map("fk_idx_decl_posts");

const declaredIndexSchema = { declaredUser, declaredPost };

// --- Schema 3: the two stages of "widen the index over the FK columns" -------
// Stage 1 is a plain to-many: the FK index is the only index on the column, so
// MySQL/InnoDB binds the constraint to it. Stage 2 is the edit the docs
// recommend — a declared index that starts with the same column — which retires
// the automatic one. The drop and its replacement land in the same batch.
const wideUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => widePost),
  })
  .map("fk_idx_wide_users");

const widePost = s
  .model({
    id: s.string().id(),
    slug: s.string(),
    authorId: s.string(),
    author: s
      .manyToOne(() => wideUser)
      .fields("authorId")
      .references("id"),
  })
  .map("fk_idx_wide_posts");

const wideStage1Schema = { wideUser, widePost };

const widerUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => widerPost),
  })
  .map("fk_idx_wide_users");

const widerPost = s
  .model({
    id: s.string().id(),
    slug: s.string(),
    authorId: s.string(),
    author: s
      .manyToOne(() => widerUser)
      .fields("authorId")
      .references("id"),
  })
  .index(["authorId", "slug"])
  .map("fk_idx_wide_posts");

const wideStage2Schema = { widerUser, widerPost };

// The other way the same columns get covered: a compound unique whose first
// column is the FK.
const uniqueUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => uniquePost),
  })
  .map("fk_idx_wide_users");

const uniquePost = s
  .model({
    id: s.string().id(),
    slug: s.string(),
    authorId: s.string(),
    author: s
      .manyToOne(() => uniqueUser)
      .fields("authorId")
      .references("id"),
  })
  .unique(["authorId", "slug"])
  .map("fk_idx_wide_posts");

const wideStage2UniqueSchema = { uniqueUser, uniquePost };

// --- Schema 4: volume, for the plan probe ------------------------------------
const planUser = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => planPost),
  })
  .map("fk_plan_users");

const planPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().map("author_id"),
    author: s
      .manyToOne(() => planUser)
      .fields("authorId")
      .references("id"),
  })
  .map("fk_plan_posts");

const planSchema = { planUser, planPost };

type AnySchema =
  | typeof fkIndexSchema
  | typeof declaredIndexSchema
  | typeof wideStage1Schema
  | typeof wideStage2Schema
  | typeof wideStage2UniqueSchema
  | typeof planSchema;

type FkIndexClient = VibORMClient<
  VibORMConfig & { schema: AnySchema; driver: AnyDriver }
>;

/** Every index the database itself reports for `table`. */
async function indexNames(
  client: FkIndexClient,
  dialect: string,
  table: string
): Promise<string[]> {
  const query =
    dialect === "postgresql"
      ? "SELECT indexname AS name FROM pg_indexes WHERE tablename = $1"
      : dialect === "mysql"
        ? "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?"
        : "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?";
  const rows = await client.$queryRawUnsafe<{ name: string }>(query, table);
  return rows.map((row) => row.name).sort();
}

export interface FkIndexBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runFkIndexBehavior({
  driverName,
  createDriver,
}: FkIndexBehaviorOptions) {
  describe(`${driverName} foreign-key index`, () => {
    let client: FkIndexClient | undefined;
    let dialect = "";

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    function make(schema: AnySchema): FkIndexClient {
      const driver = createDriver();
      dialect = driver.dialect;
      client = createClient({ schema: schema as never, driver }) as never;
      return client as FkIndexClient;
    }

    /** A second schema over the database the current client already pushed. */
    function restage(schema: AnySchema): FkIndexClient {
      const driver = (client as FkIndexClient).$driver as AnyDriver;
      client = createClient({ schema: schema as never, driver }) as never;
      return client as FkIndexClient;
    }

    /**
     * Pushes `next` over the database the current client already pushed, and
     * reports where the superseded index's drop landed relative to the index
     * (or unique constraint) that replaces it. Running at all is half the
     * witness: MySQL refused the batch with errno 1553 when the drop ran first.
     */
    async function replacementAndDropPositions(next: AnySchema) {
      const c = restage(next);
      const planned = await push(c as never, { force: true });

      return {
        dropAt: planned.operations.findIndex((op) => op.type === "dropIndex"),
        replacementAt: planned.operations.findIndex(
          (op) => op.type === "createIndex" || op.type === "addUniqueConstraint"
        ),
      };
    }

    test("push creates an index over the manyToOne FK column", async () => {
      const c = make(fkIndexSchema);
      await push(c as never, { force: true });

      expect(await indexNames(c, dialect, "fk_idx_posts")).toContain(
        "fk_idx_posts_author_id_idx"
      );
      // The referenced side holds no FK, so it gains no index.
      expect(await indexNames(c, dialect, "fk_idx_users")).not.toContain(
        "fk_idx_users_author_id_idx"
      );
    });

    test("re-pushing the schema is not an index change", async () => {
      const c = make(fkIndexSchema);
      await push(c as never, { force: true });

      const second = await push(c as never, { force: true });

      expect(
        second.operations.filter(
          (op) => op.type === "createIndex" || op.type === "dropIndex"
        )
      ).toEqual([]);
      expect(await indexNames(c, dialect, "fk_idx_posts")).toContain(
        "fk_idx_posts_author_id_idx"
      );
    });

    // REGRESSION: `PRAGMA foreign_key_list` carries no constraint name, so
    // SQLite's introspection synthesises `<table>_fk_<n>` — which never matches
    // the `<table>_<column>_fkey` the serializer declares. Matched by name, the
    // declared key was therefore missing and the read one extra on EVERY push,
    // and the differ planned drop-and-add forever. SQLite has no
    // `ALTER TABLE ADD FOREIGN KEY`, so each of those rebuilt the whole table,
    // copy included: two full rebuilds per push of a schema nobody had edited.
    // (Before the recreation replay landed they also accumulated — 1, then 2,
    // then 3 identical constraints. That half is `sqlite-recreation-indexes`;
    // this one is the churn that survived it.)
    //
    // Every dialect gets this test, not just SQLite: the assertion is simply
    // that an unchanged schema plans nothing, which is what a name-carrying
    // catalog gives for free and what shape identity gives SQLite.
    test("re-pushing the schema is not a foreign-key change", async () => {
      const c = make(fkIndexSchema);
      await push(c as never, { force: true });

      const second = await push(c as never, { force: true });
      const third = await push(c as never, { force: true });

      expect(second.operations).toEqual([]);
      expect(third.operations).toEqual([]);
    });

    test("a declared .index() on the FK column is not duplicated", async () => {
      const c = make(declaredIndexSchema);
      await push(c as never, { force: true });

      // MySQL/InnoDB adds its own index for the FK constraint, named after the
      // constraint; the indexes viborm declares are the `_idx` ones.
      const declared = (
        await indexNames(c, dialect, "fk_idx_decl_posts")
      ).filter((name) => name.endsWith("_idx"));
      expect(declared).toEqual(["fk_idx_decl_posts_authorId_idx"]);

      // REGRESSION (P1 review): the serializer leaves a plain `.index()`'s
      // `unique` undefined while introspection reads `false` back, so a raw
      // comparison re-planned drop+create on EVERY push — and on MySQL the drop
      // is a hard 1553 abort, because this declared index is the one InnoDB
      // bound the FK to (the automatic FK index defers to it). The second push
      // must be a no-op, not merely survivable.
      const second = await push(c as never, { force: true });
      expect(
        second.operations.filter(
          (op) => op.type === "createIndex" || op.type === "dropIndex"
        )
      ).toEqual([]);
    });

    // REGRESSION: the FK index this file put on the column is the index
    // MySQL/InnoDB binds the constraint to, and every `dropIndex` used to be
    // ordered ahead of every `createIndex`. Superseding the FK index therefore
    // asked InnoDB to drop the last index covering the constraint's columns and
    // the transactional push aborted with errno 1553. Both edits below are the
    // documented way to widen the coverage.
    test("a wider declared index over the FK columns replaces it in one push", async () => {
      const c = make(wideStage1Schema);
      await push(c as never, { force: true });
      expect(await indexNames(c, dialect, "fk_idx_wide_posts")).toContain(
        "fk_idx_wide_posts_authorId_idx"
      );

      const { dropAt, replacementAt } =
        await replacementAndDropPositions(wideStage2Schema);

      expect(dropAt).toBeGreaterThan(-1);
      expect(replacementAt).toBeGreaterThan(-1);
      expect(replacementAt).toBeLessThan(dropAt);
    });

    test("a compound unique over the FK columns replaces it in one push", async () => {
      const c = make(wideStage1Schema);
      await push(c as never, { force: true });

      const { dropAt, replacementAt } = await replacementAndDropPositions(
        wideStage2UniqueSchema
      );

      expect(dropAt).toBeGreaterThan(-1);
      expect(replacementAt).toBeGreaterThan(-1);
      expect(replacementAt).toBeLessThan(dropAt);
    });
  });
}

export interface FkIndexUpgradeBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * The upgrade path: a database created before this phase, pushed again.
 *
 * REGRESSION: SQLite cannot `ALTER TABLE ADD FOREIGN KEY`, so it rebuilds the
 * table for every FK change — and it rebuilt it from the snapshot introspected
 * before the batch ever ran, whose index list is the pre-batch one. `createIndex` is
 * priority 15 and `addForeignKey` 16, so the push created the FK index and then
 * dropped the table out from under it. Nothing made this rare: SQLite's
 * introspection has no constraint names to read, so the differ plans an FK drop
 * and add on every push for every `manyToOne`. The index never landed on an
 * existing database and the push never went quiet.
 */
export function runFkIndexUpgradeBehavior({
  driverName,
  createDriver,
}: FkIndexUpgradeBehaviorOptions) {
  describe(`${driverName} foreign-key index upgrade`, () => {
    let client: FkIndexClient | undefined;

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("a database without the index gains it, and keeps it", async () => {
      const driver = createDriver();
      const { dialect } = driver;
      client = createClient({
        schema: fkIndexSchema as never,
        driver,
      }) as never;
      const c = client as FkIndexClient;
      await push(c as never, { force: true });

      // Reduce the database to the pre-phase state: same tables, same
      // constraint, no FK index.
      await c.$executeRawUnsafe('DROP INDEX "fk_idx_posts_author_id_idx"');
      expect(await indexNames(c, dialect, "fk_idx_posts")).not.toContain(
        "fk_idx_posts_author_id_idx"
      );

      const upgrade = await push(c as never, { force: true });
      expect(
        upgrade.operations.filter((op) => op.type === "createIndex")
      ).toHaveLength(1);
      expect(await indexNames(c, dialect, "fk_idx_posts")).toContain(
        "fk_idx_posts_author_id_idx"
      );

      // Converged: the next push is not an index change, and the index is still
      // there afterwards — the FK churn SQLite plans forever must not eat it.
      const settled = await push(c as never, { force: true });
      expect(
        settled.operations.filter(
          (op) => op.type === "createIndex" || op.type === "dropIndex"
        )
      ).toEqual([]);
      expect(await indexNames(c, dialect, "fk_idx_posts")).toContain(
        "fk_idx_posts_author_id_idx"
      );
    });
  });
}

export interface FkIndexPlanBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/** The child table's alias in the emitted include, e.g. `"fk_plan_posts" AS "t1"`. */
const CHILD_TABLE_ALIAS = /["`]fk_plan_posts["`]\s+AS\s+["`](\w+)["`]/;

const USER_COUNT = 200;
const POST_COUNT = 4000;

export function runFkIndexPlanBehavior({
  driverName,
  createDriver,
}: FkIndexPlanBehaviorOptions) {
  describe(`${driverName} foreign-key index query plan`, () => {
    let client: FkIndexClient | undefined;

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("an include at volume reads the child table through the FK index", async () => {
      const statements: Array<{ sql: string; params: unknown[] }> = [];
      const driver = createDriver();
      const { dialect } = driver;
      client = createClient({
        schema: planSchema as never,
        driver,
        instrumentation: {
          logging: {
            query: (event) => {
              statements.push({
                sql: event.sql ?? "",
                params: event.params ?? [],
              });
            },
            includeSql: true,
            includeParams: true,
          },
        },
      }) as never;
      const c = client as FkIndexClient as unknown as Record<string, any>;
      await push(client as never, { force: true });

      await c.planUser.createMany({
        data: Array.from({ length: USER_COUNT }, (_, i) => ({
          id: `u${i}`,
          name: `name-${i}`,
        })),
      });
      await c.planPost.createMany({
        data: Array.from({ length: POST_COUNT }, (_, i) => ({
          id: `p${i}`,
          title: `title-${i}`,
          authorId: `u${i % USER_COUNT}`,
        })),
      });
      // Plan on real statistics, not on the empty-table defaults.
      await (client as FkIndexClient).$executeRawUnsafe("ANALYZE");
      if (dialect === "postgresql") {
        // PGlite ships with enable_seqscan=off, which would let the planner
        // pick an index whatever it costs. Turn it back on so the assertion
        // below means the index actually won.
        await (client as FkIndexClient).$executeRawUnsafe(
          "SET enable_seqscan = on"
        );
        const [setting] = await (client as FkIndexClient).$queryRawUnsafe<{
          enable_seqscan: string;
        }>("SHOW enable_seqscan");
        expect(setting?.enable_seqscan).toBe("on");
      }

      statements.length = 0;
      const users = await c.planUser.findMany({
        take: 5,
        include: { posts: true },
      });
      expect(users).toHaveLength(5);
      expect(users[0].posts.length).toBeGreaterThan(0);

      // The read path is one statement: the include rides a subquery over the
      // child table inside it.
      expect(statements).toHaveLength(1);
      const included = statements[0]!;

      const explain =
        dialect === "postgresql"
          ? `EXPLAIN ${included.sql}`
          : `EXPLAIN QUERY PLAN ${included.sql}`;
      const rows = await (client as FkIndexClient).$queryRawUnsafe<
        Record<string, string>
      >(explain, ...included.params);
      const plan = rows
        .map((row) =>
          dialect === "postgresql" ? row["QUERY PLAN"] : row.detail
        )
        .join("\n");

      expect(plan).toContain("fk_plan_posts_author_id_idx");
      // The child table is reached by that index and by NOTHING else. Each
      // dialect spells a full scan its own way, so run only the spelling this
      // plan could actually contain — asserting both means one of the two is
      // always vacuous, and a vacuous assertion is not a second opinion.
      //
      // The child alias is read off the emitted SQL rather than hard-coded:
      // `SCAN <alias>` names the query's own alias, so a builder that renames it
      // would leave a hard-coded `SCAN t1` matching nothing and passing forever.
      // The match itself is the tripwire for that rename.
      const childAlias = CHILD_TABLE_ALIAS.exec(included.sql)?.[1];
      expect(childAlias).toBeDefined();
      if (dialect === "postgresql") {
        expect(plan).not.toContain("Seq Scan on fk_plan_posts");
      } else {
        expect(plan).not.toContain(`SCAN ${childAlias}`);
      }
    }, 120_000);
  });
}

export const fkIndexContract = defineContract({
  id: "drivers.fk-index",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runFkIndexBehavior,
});

export const fkIndexUpgradeContract = defineContract({
  id: "drivers.fk-index-upgrade",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runFkIndexUpgradeBehavior,
});

export const fkIndexPlanContract = defineContract({
  id: "drivers.fk-index-plan",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runFkIndexPlanBehavior,
});
