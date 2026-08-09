import { defineContract } from "@tests/contracts/contract";
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
 *
 * Unit 2.3, the coverage of a partial index (found reviewing 2.2). The
 * serializer counted every declared index as total coverage. Once 2.2 made the
 * predicate real, declaring a partial index over a foreign-key column removed
 * that column's index entirely, and declaring a partial UNIQUE one over a 1:1
 * foreign key left the relation with no uniqueness at all — two children could
 * own one parent. `runPartialIndexCoverageBehavior` proves the whole-column
 * index and the uniqueness both survive the declaration; it is wired on the
 * dialects that build a predicate (PostgreSQL and the SQLite family), which is
 * every dialect that can hold the declaration at all.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";
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

// --- Schema 4: a partial index over the foreign-key column -------------------
// The predicate is written over an integer so one schema serves PostgreSQL and
// SQLite unchanged. The declared index takes the name the automatic foreign-key
// index would generate, so this schema also witnesses the name the automatic
// index falls back on.
const coverUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => coverPost),
  })
  .map("idx_cov_users");

const coverPost = s
  .model({
    id: s.string().id(),
    views: s.int(),
    authorId: s.string(),
    author: s
      .manyToOne(() => coverUser)
      .fields("authorId")
      .references("id"),
  })
  .index(["authorId"], { where: "views > 0" })
  .map("idx_cov_posts");

const coverIndexSchema = { coverUser, coverPost };

// --- Schema 5: a partial UNIQUE index over a 1:1 foreign-key column ----------
const coverOwner = s
  .model({
    id: s.string().id(),
    profile: s.oneToOne(() => coverProfile).optional(),
  })
  .map("idx_cov_owners");

const coverProfile = s
  .model({
    id: s.string().id(),
    views: s.int(),
    ownerId: s.string(),
    owner: s
      .oneToOne(() => coverOwner)
      .fields("ownerId")
      .references("id"),
  })
  .index(["ownerId"], { unique: true, where: "views > 0" })
  .map("idx_cov_profiles");

const coverUniqueSchema = { coverOwner, coverProfile };

// --- Schema 6: the PostgreSQL predicate deparse (Decision 7.4) ---------------
// One table, three declarations. PostgreSQL does not store the statement it was
// given: it parses the predicate and `pg_get_expr` deparses it back, so
// `published = true` returns as `(published = true)` and the differ saw a change
// on every push. The three declarations separate the two questions that answer
// has to keep apart — is the SAME predicate quiet (in two spellings), and is a
// DIFFERENT predicate still seen.
const CHURN_INDEX = "idx_7p4_posts_published_title";

const churnDeclaredPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
  })
  .index(["title"], { name: CHURN_INDEX, where: "published = true" })
  .map("idx_7p4_posts");

const churnRespelledPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
  })
  .index(["title"], { name: CHURN_INDEX, where: "(published = TRUE)" })
  .map("idx_7p4_posts");

const churnChangedPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
  })
  .index(["title"], { name: CHURN_INDEX, where: "published = false" })
  .map("idx_7p4_posts");

// The fourth declaration exists to break the round trip rather than to be
// pushed: `published = true AND` is a predicate PostgreSQL will not parse, so
// the scratch view for it fails, the canonicalizing transaction aborts, and
// `buildIndexPredicateCanonicalizer` reaches its catch. That is the only way
// into the catch from outside — every other predicate the schema can hold is
// one the database can parse.
const churnUnparseablePost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
  })
  .index(["title"], { name: CHURN_INDEX, where: "published = true AND" })
  .map("idx_7p4_posts");

const churnDeclaredSchema = { churnPost: churnDeclaredPost };
const churnRespelledSchema = { churnPost: churnRespelledPost };
const churnChangedSchema = { churnPost: churnChangedPost };
const churnUnparseableSchema = { churnPost: churnUnparseablePost };

/** The refusal names the index and quotes the predicate it cannot express. */
const REFUSAL_MESSAGE =
  /Index "idx_refused_posts_published_title" declares a partial index predicate \(where: "published = 1"\)\. MySQL does not support partial indexes\./;

type AnySchema =
  | typeof mappedIndexSchema
  | typeof partialIndexSchema
  | typeof refusedIndexSchema
  | typeof coverIndexSchema
  | typeof coverUniqueSchema
  | typeof churnDeclaredSchema
  | typeof churnUnparseableSchema;

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

/** Whether the database built `indexName` with a predicate of its own. */
async function isPartial(
  client: IndexDdlClient,
  dialect: string,
  tableName: string,
  indexName: string
): Promise<boolean> {
  if (dialect === "postgresql") {
    const rows = await client.$queryRawUnsafe<{ partial: boolean }>(
      `SELECT (x.indpred IS NOT NULL) AS partial
         FROM pg_class i
         JOIN pg_index x ON x.indexrelid = i.oid
        WHERE i.relname = $1`,
      indexName
    );
    return rows[0]?.partial === true;
  }

  // SQLite's own verdict, independent of the stored text. `Number` because the
  // LibSQL driver runs with `intMode: "bigint"`.
  const rows = await client.$queryRawUnsafe<{
    name: string;
    partial: number | bigint;
  }>(`PRAGMA index_list("${tableName}")`);
  return Number(rows.find((row) => row.name === indexName)?.partial) === 1;
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

export function runPartialIndexPredicateChurnBehavior({
  driverName,
  createDriver,
}: IndexDdlBehaviorOptions) {
  describe(`${driverName} partial index predicate churn`, () => {
    // One driver per test, several clients on it: two of these tests push a
    // SECOND declaration of the same table and have to reach the database the
    // first one wrote. A fresh driver would be a fresh (empty) database.
    let driver: AnyDriver | undefined;
    let connected: IndexDdlClient | undefined;

    afterEach(async () => {
      if (connected) {
        await connected.$disconnect();
        connected = undefined;
      }
      driver = undefined;
    });

    function make(schema: AnySchema): IndexDdlClient {
      driver ??= createDriver();
      connected = createClient({
        schema: schema as never,
        driver,
      }) as never;
      return connected as IndexDdlClient;
    }

    /** What PostgreSQL says the index's predicate is, in its own spelling. */
    async function storedPredicate(c: IndexDdlClient): Promise<string | null> {
      const rows = await c.$queryRawUnsafe<{ predicate: string | null }>(
        `SELECT pg_get_expr(x.indpred, x.indrelid) AS predicate
           FROM pg_class i
           JOIN pg_index x ON x.indexrelid = i.oid
          WHERE i.relname = $1`,
        CHURN_INDEX
      );
      return rows[0]?.predicate ?? null;
    }

    function indexOps(operations: readonly { type: string }[]) {
      return operations.filter(
        (op) => op.type === "createIndex" || op.type === "dropIndex"
      );
    }

    // REGRESSION (Decision 7.4): the declaration and the catalog never agreed,
    // so this second push planned a drop and a create — and so did the third,
    // and every one after it, forever.
    test("re-pushing the same declaration is not an index change", async () => {
      const c = make(churnDeclaredSchema);
      await push(c as never, { force: true });

      // The gap this closes, stated rather than assumed: what the catalog
      // gives back is NOT what the schema declared.
      expect(await storedPredicate(c)).toBe("(published = true)");

      const second = await push(c as never, { force: true });

      expect(indexOps(second.operations)).toEqual([]);
      expect(await storedPredicate(c)).toBe("(published = true)");
    });

    // The stronger half. Re-pushing the same text could in principle be settled
    // by any normalization; two DIFFERENT texts for one predicate can only be
    // settled by the database, which is what the canonicalization asks.
    test("the same predicate in another spelling is not an index change", async () => {
      await push(make(churnDeclaredSchema) as never, { force: true });

      const respelled = make(churnRespelledSchema);
      const second = await push(respelled as never, { force: true });

      expect(indexOps(second.operations)).toEqual([]);
      expect(await storedPredicate(respelled)).toBe("(published = true)");
    });

    // And the guard the canonicalization must not swallow: a predicate that
    // really changed is still a drop and a create.
    test("a real predicate change is still an index change", async () => {
      await push(make(churnDeclaredSchema) as never, { force: true });

      const changed = make(churnChangedSchema);
      const second = await push(changed as never, { force: true });

      expect(indexOps(second.operations).map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
      expect(await storedPredicate(changed)).toBe("(published = false)");
    });

    // The failure half of Decision 7.4, and the only test that runs
    // `buildIndexPredicateCanonicalizer`'s catch. The three above all take the
    // success path: the round trip answers, and the differ reads the answers.
    // Here the round trip THROWS, and the catch decides what the differ is
    // told. Answering a spelling — any spelling, including one constant for
    // every predicate — would make the two texts read alike and silently
    // cancel a real index change. Answering nothing leaves the raw texts, and
    // the drop/create stands. Both halves of the catch's promise are here: the
    // push does not fail, and nothing was claimed equal.
    test("a canonicalization that fails answers nothing, and the change stands", async () => {
      await push(make(churnDeclaredSchema) as never, { force: true });

      const unparseable = make(churnUnparseableSchema);
      const second = await push(unparseable as never, {
        dryRun: true,
        force: true,
      });

      expect(indexOps(second.operations).map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
      // dryRun: the CREATE INDEX this plans is the one PostgreSQL refuses, so
      // it is never executed and the index the first push built is untouched.
      expect(await storedPredicate(unparseable)).toBe("(published = true)");
    });
  });
}

export function runPartialIndexCoverageBehavior({
  driverName,
  createDriver,
}: IndexDdlBehaviorOptions) {
  describe(`${driverName} partial index coverage`, () => {
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

    // REGRESSION (Phase 2 review): the declared partial index counted as total
    // coverage, so the foreign-key index was skipped and this column — the one
    // every include, relation filter and nested-write locate reads — had no
    // index for the rows the predicate excludes.
    test("the foreign-key column keeps a whole-column index", async () => {
      const c = make(coverIndexSchema);
      await push(c as never, { force: true });

      // The declared index is still exactly what the schema asked for.
      expect(
        await indexColumns(c, dialect, "idx_cov_posts_authorId_idx")
      ).toEqual(["authorId"]);
      expect(
        await isPartial(
          c,
          dialect,
          "idx_cov_posts",
          "idx_cov_posts_authorId_idx"
        )
      ).toBe(true);

      // And the foreign key has its own index over every row. It cannot take
      // the name the declared index holds, so it takes the constraint's.
      expect(
        await indexColumns(c, dialect, "idx_cov_posts_authorId_fkey_idx")
      ).toEqual(["authorId"]);
      expect(
        await isPartial(
          c,
          dialect,
          "idx_cov_posts",
          "idx_cov_posts_authorId_fkey_idx"
        )
      ).toBe(false);
    });

    // Scoped to the foreign-key index on purpose. That the DECLARED partial
    // index is quiet too is a different claim with a different cause — the
    // PostgreSQL predicate deparse, Decision 7.4 — and it has its own witness
    // in `runPartialIndexPredicateChurnBehavior`.
    test("a second push does not touch the foreign-key index", async () => {
      const c = make(coverIndexSchema);
      await push(c as never, { force: true });

      const second = await push(c as never, { force: true });

      expect(
        second.operations.filter(
          (op) =>
            (op.type === "createIndex" &&
              op.index.name === "idx_cov_posts_authorId_fkey_idx") ||
            (op.type === "dropIndex" &&
              op.indexName === "idx_cov_posts_authorId_fkey_idx")
        )
      ).toEqual([]);
      expect(
        await indexColumns(c, dialect, "idx_cov_posts_authorId_fkey_idx")
      ).toEqual(["authorId"]);
    });

    // REGRESSION (Phase 2 review): the same blindness accepted a partial UNIQUE
    // index as the 1:1 uniqueness, so no unique constraint was emitted at all.
    // Both rows below sit outside the predicate, so only a constraint over the
    // whole column can refuse the second one — and without it the relation the
    // schema calls 1:1 holds two children on one parent.
    test("two rows the predicate excludes cannot share the 1:1 key", async () => {
      const c = make(coverUniqueSchema);
      await push(c as never, { force: true });

      const owner = c as never as {
        coverOwner: { create: (a: unknown) => Promise<unknown> };
        coverProfile: { create: (a: unknown) => Promise<unknown> };
      };
      await owner.coverOwner.create({ data: { id: "o1" } });
      await owner.coverProfile.create({
        data: { id: "p1", views: 0, ownerId: "o1" },
      });

      await expect(
        owner.coverProfile.create({
          data: { id: "p2", views: 0, ownerId: "o1" },
        })
      ).rejects.toThrow(UniqueConstraintError);
    });
  });
}

export const mappedIndexContract = defineContract({
  id: "drivers.mapped-index",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runMappedIndexBehavior,
});

export const partialIndexContract = defineContract({
  id: "drivers.partial-index",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runPartialIndexBehavior,
});

export const partialIndexRefusalContract = defineContract({
  id: "drivers.partial-index-refusal",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runPartialIndexRefusalBehavior,
});

export const partialIndexPredicateChurnContract = defineContract({
  id: "drivers.partial-index-predicate-churn",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runPartialIndexPredicateChurnBehavior,
});

export const partialIndexCoverageContract = defineContract({
  id: "drivers.partial-index-coverage",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runPartialIndexCoverageBehavior,
});
