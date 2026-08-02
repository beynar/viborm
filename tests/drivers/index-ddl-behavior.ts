/**
 * The two DDL defects of the declared index — live driver behavior.
 *
 * Unit 2.1, the mapped column. `.index()` names TypeScript fields and the DDL
 * has to name columns. The index collection pushed the field name straight
 * through, so a `.map()`ed field made CREATE INDEX name a column that does not
 * exist: the push failed outright, and the schema had no way to index a mapped
 * field at all. `runMappedIndexBehavior` is wired on every driver.
 *
 * Unit 2.2, the partial index. The SQLite driver dropped an index's `where`
 * without a word: the index it built indexed rows the schema excluded, and
 * because nothing read the predicate back the differ could never see the two
 * agree. `runPartialIndexBehavior` proves the predicate reaches the database
 * and that a second push is quiet; it is wired on the SQLite dialects, which is
 * where the emitter was blind. `runPartialIndexRefusalBehavior` proves MySQL —
 * which has no partial index at all — refuses the declaration out loud instead
 * of quietly building the wrong index.
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

// --- Schema 1: a declared index over mapped columns --------------------------
// Both index fields are mapped, and one of them is also the FK column, so the
// declared index and the automatic foreign-key index have to agree on the one
// name the database knows or the push emits two indexes over one column.
const mappedUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => mappedPost),
  })
  .map("idx_map_users");

const mappedPost = s
  .model({
    id: s.string().id(),
    authorId: s.string().map("author_id"),
    publishedAt: s.dateTime().map("published_at"),
    author: s
      .manyToOne(() => mappedUser)
      .fields("authorId")
      .references("id"),
  })
  .index(["authorId", "publishedAt"], { name: "idx_map_posts_author_pub" })
  .map("idx_map_posts");

const mappedIndexSchema = { mappedUser, mappedPost };

// --- Schema 2: a partial index -----------------------------------------------
// The model holds a manyToOne on purpose: SQLite cannot alter a foreign key, so
// every push rebuilds this table and re-emits its indexes from the introspected
// list. A predicate that survives that rebuild is a predicate that was really
// read back, not merely written once.
const partialUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => partialPost),
  })
  .map("idx_part_users");

const partialPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
    authorId: s.string(),
    author: s
      .manyToOne(() => partialUser)
      .fields("authorId")
      .references("id"),
  })
  .index(["title"], {
    name: "idx_part_posts_published_title",
    where: "published = 1",
  })
  .map("idx_part_posts");

const partialIndexSchema = { partialUser, partialPost };

// --- Schema 3: the same declaration on MySQL ---------------------------------
const refusedPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
  })
  .index(["title"], {
    name: "idx_refused_posts_published_title",
    where: "published = 1",
  })
  .map("idx_refused_posts");

const refusedIndexSchema = { refusedPost };

/** The refusal names the index and quotes the predicate it cannot express. */
const REFUSAL_MESSAGE =
  /Index "idx_refused_posts_published_title" declares a partial index predicate \(where: "published = 1"\)\. MySQL does not support partial indexes\./;

type AnySchema =
  | typeof mappedIndexSchema
  | typeof partialIndexSchema
  | typeof refusedIndexSchema;

type IndexDdlClient = VibORMClient<
  VibORMConfig & { schema: AnySchema; driver: AnyDriver }
>;

/** The columns the database itself reports for `indexName`, in index order. */
async function indexColumns(
  client: IndexDdlClient,
  dialect: string,
  indexName: string
): Promise<string[]> {
  if (dialect === "postgresql") {
    const rows = await client.$queryRawUnsafe<{ name: string }>(
      `SELECT a.attname AS name
         FROM pg_class i
         JOIN pg_index x ON x.indexrelid = i.oid
         CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
        WHERE i.relname = $1
        ORDER BY k.ord`,
      indexName
    );
    return rows.map((row) => row.name);
  }

  if (dialect === "mysql") {
    const rows = await client.$queryRawUnsafe<{ name: string }>(
      `SELECT COLUMN_NAME AS name
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ?
        ORDER BY SEQ_IN_INDEX`,
      indexName
    );
    return rows.map((row) => row.name);
  }

  const rows = await client.$queryRawUnsafe<{ name: string }>(
    "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
    indexName
  );
  return rows.map((row) => row.name);
}

export interface IndexDdlBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runMappedIndexBehavior({
  driverName,
  createDriver,
}: IndexDdlBehaviorOptions) {
  describe(`${driverName} declared index on a mapped field`, () => {
    let client: IndexDdlClient | undefined;
    let dialect = "";

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    function make(schema: AnySchema): IndexDdlClient {
      const driver = createDriver();
      dialect = driver.dialect;
      client = createClient({ schema: schema as never, driver }) as never;
      return client as IndexDdlClient;
    }

    // REGRESSION (Phase 2, Unit 2.1): the index collection pushed
    // `indexDef.fields` raw, so this CREATE INDEX named `authorId` and
    // `publishedAt` — neither of which is a column of the table. Pushing at all
    // is half the witness.
    test("push creates the index over the mapped column names", async () => {
      const c = make(mappedIndexSchema);
      await push(c as never, { force: true });

      expect(
        await indexColumns(c, dialect, "idx_map_posts_author_pub")
      ).toEqual(["author_id", "published_at"]);
    });

    test("re-pushing the schema is not an index change", async () => {
      const c = make(mappedIndexSchema);
      await push(c as never, { force: true });

      const second = await push(c as never, { force: true });

      expect(
        second.operations.filter(
          (op) => op.type === "createIndex" || op.type === "dropIndex"
        )
      ).toEqual([]);
      expect(
        await indexColumns(c, dialect, "idx_map_posts_author_pub")
      ).toEqual(["author_id", "published_at"]);
    });

    // The declared index and the automatic FK index decide coverage against the
    // same resolved names, so the FK column is indexed once, not twice.
    test("the declared index leaves the FK index nothing to add", async () => {
      const c = make(mappedIndexSchema);
      await push(c as never, { force: true });

      expect(
        await indexColumns(c, dialect, "idx_map_posts_author_id_idx")
      ).toEqual([]);
    });
  });
}

export function runPartialIndexBehavior({
  driverName,
  createDriver,
}: IndexDdlBehaviorOptions) {
  describe(`${driverName} partial index`, () => {
    let client: IndexDdlClient | undefined;

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    function make(schema: AnySchema): IndexDdlClient {
      client = createClient({
        schema: schema as never,
        driver: createDriver(),
      }) as never;
      return client as IndexDdlClient;
    }

    /** What SQLite stored for the index — it keeps the statement verbatim. */
    async function storedSql(c: IndexDdlClient): Promise<string | null> {
      const rows = await c.$queryRawUnsafe<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        "idx_part_posts_published_title"
      );
      return rows[0]?.sql ?? null;
    }

    // REGRESSION (Phase 2, Unit 2.2): `generateCreateIndex` never read
    // `index.where`, so the index in the database covered every row instead of
    // the published ones.
    test("push writes the predicate into the index", async () => {
      const c = make(partialIndexSchema);
      await push(c as never, { force: true });

      expect(await storedSql(c)).toContain("WHERE published = 1");

      // SQLite's own verdict on the index, independent of the stored text.
      // `Number` because the LibSQL driver runs with `intMode: "bigint"`.
      const listed = await c.$queryRawUnsafe<{
        name: string;
        partial: number | bigint;
      }>('PRAGMA index_list("idx_part_posts")');
      const entry = listed.find(
        (row) => row.name === "idx_part_posts_published_title"
      );
      expect(entry).toBeDefined();
      expect(Number(entry?.partial)).toBe(1);
    });

    // The other half: introspection has to read the predicate back, or the
    // differ compares a declared `where` against `undefined` and re-creates the
    // index on every push, forever.
    test("a second push is not an index change", async () => {
      const c = make(partialIndexSchema);
      await push(c as never, { force: true });

      const second = await push(c as never, { force: true });

      expect(
        second.operations.filter(
          (op) => op.type === "createIndex" || op.type === "dropIndex"
        )
      ).toEqual([]);
      // The table carries a foreign key, so SQLite rebuilt it during that push
      // and re-emitted this index from the introspected list. The predicate has
      // to have survived the round trip, not merely the first write.
      expect(await storedSql(c)).toContain("WHERE published = 1");
    });
  });
}

export function runPartialIndexRefusalBehavior({
  driverName,
  createDriver,
}: IndexDdlBehaviorOptions) {
  describe(`${driverName} partial index refusal`, () => {
    let client: IndexDdlClient | undefined;

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    // MySQL has no partial index. Building the index without its predicate
    // would index rows the schema excluded — a silently different index — so
    // the declaration is refused and the push does not run.
    test("push refuses the declaration by name", async () => {
      client = createClient({
        schema: refusedIndexSchema as never,
        driver: createDriver(),
      }) as never;

      await expect(push(client as never, { force: true })).rejects.toThrow(
        REFUSAL_MESSAGE
      );
    });
  });
}
