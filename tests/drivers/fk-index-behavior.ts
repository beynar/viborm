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

// --- Schema 3: volume, for the plan probe ------------------------------------
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
      // SQLite recreates the table for its FK churn, so prove the index is
      // still in the database rather than only that the differ was quiet.
      expect(await indexNames(c, dialect, "fk_idx_posts")).toContain(
        "fk_idx_posts_author_id_idx"
      );
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
    });
  });
}

export interface FkIndexPlanBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

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
      // The child table is reached by that index and by nothing else. The
      // aliases are the query's own (`t1` is the child).
      expect(plan).not.toContain("Seq Scan on fk_plan_posts");
      expect(plan).not.toContain("SCAN t1");
    }, 120_000);
  });
}
