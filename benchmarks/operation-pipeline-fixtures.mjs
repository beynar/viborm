/** Fresh database construction and immutable seed data for pipeline workloads. */

import { createClient } from "../dist/index.mjs";
import { push } from "../dist/migrations.mjs";
import { s } from "../dist/schema.mjs";
import { SQLite3Driver } from "../dist/sqlite3.mjs";

class BatchOnlySQLite3Driver extends SQLite3Driver {
  supportsTransactions = false;
  supportsBatch = true;

  async executeBatch(client, queries) {
    return this.transaction(client, async (transaction) => {
      const results = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function createDriver(substrate) {
  const DriverClass =
    substrate === "batch-only" ? BatchOnlySQLite3Driver : SQLite3Driver;
  return new DriverClass({ dataDir: ":memory:" });
}

async function insertRows(driver, table, columns, rows) {
  const maximumRows = Math.max(1, Math.floor(900 / columns.length));
  const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
  for (let start = 0; start < rows.length; start += maximumRows) {
    const chunk = rows.slice(start, start + maximumRows);
    const placeholders = chunk
      .map(() => `(${columns.map(() => "?").join(", ")})`)
      .join(", ");
    await driver._executeRaw(
      `INSERT INTO "${table}" (${quotedColumns}) VALUES ${placeholders}`,
      chunk.flat()
    );
  }
}

async function setupCoreFixture(substrate) {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string().nullable(),
      email: s.string(),
      age: s.int().nullable(),
      posts: s.toMany(() => post),
    })
    .map("bench_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("bench_posts");
  const generated = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      score: s.int(),
    })
    .map("bench_generated");
  const generatedParent = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      children: s.toMany(() => generatedChild),
    })
    .map("bench_generated_parents");
  const generatedChild = s
    .model({
      id: s.string().id(),
      parentId: s.int(),
      label: s.string(),
      parent: s
        .toOne(() => generatedParent)
        .fields("parentId")
        .references("id"),
    })
    .map("bench_generated_children");
  const enumRecord = s
    .model({
      id: s.string().id(),
      status: s.enum(["draft", "review", "published"]),
      priority: s.enum(["low", "medium", "high"]),
      visibility: s.enum(["private", "team", "public"]),
    })
    .map("bench_enum_records");
  const driver = createDriver(substrate);
  const client = createClient({
    schema: {
      user,
      post,
      generated,
      generatedParent,
      generatedChild,
      enumRecord,
    },
    driver,
  });
  await push(client, { force: true });
  await insertRows(
    driver,
    "bench_users",
    ["id", "name", "email", "age"],
    Array.from({ length: 1000 }, (_, index) => [
      `user_${index}`,
      `User ${index}`,
      `user${index}@example.com`,
      20 + (index % 50),
    ])
  );
  await insertRows(
    driver,
    "bench_posts",
    ["id", "title", "content", "published", "views", "authorId"],
    Array.from({ length: 1000 }, (_, index) => [
      `post_${index}`,
      `Post ${index}`,
      `Content ${index}`,
      index % 2,
      index,
      `user_${index}`,
    ])
  );
  await insertRows(
    driver,
    "bench_enum_records",
    ["id", "status", "priority", "visibility"],
    Array.from({ length: 1000 }, (_, index) => [
      `enum_${index}`,
      ["draft", "review", "published"][index % 3],
      ["low", "medium", "high"][index % 3],
      ["private", "team", "public"][index % 3],
    ])
  );
  await client.user.create({
    data: {
      id: "update_target",
      name: "Update",
      email: "update@example.com",
      age: 1,
    },
  });
  await client.user.create({
    data: {
      id: "relation_update_target",
      name: "Relation update",
      email: "relation-update@example.com",
      age: 1,
    },
  });
  return { client, driver };
}

async function setupVariantFixture(substrate) {
  const article = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelf: s.toOne(() => shelf),
    })
    .map("bench_variant_articles");
  const clip = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelves: s.toMany(() => shelf),
    })
    .map("bench_variant_clips");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s
        .toMany(
          { article: () => article, clip: () => clip },
          {
            values: {
              article: "bench.shelf.article.v1",
              clip: "bench.shelf.clip.v1",
            },
          }
        )
        .through({
          article: {
            table: "bench_shelf_articles",
            source: "shelf_id",
            target: "article_id",
          },
          clip: {
            table: "bench_shelf_clips",
            source: "shelf_id",
            target: "clip_id",
          },
        }),
    })
    .map("bench_variant_shelves");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      subject: s
        .toOne(
          { article: () => article, clip: () => clip },
          {
            values: {
              article: "bench.article.v1",
              clip: "bench.clip.v1",
            },
          }
        )
        .optional(),
    })
    .map("bench_variant_comments");
  const driver = createDriver(substrate);
  const client = createClient({
    schema: { article, clip, shelf, comment },
    driver,
  });
  await push(client, { force: true });
  await insertRows(
    driver,
    "bench_variant_articles",
    ["id", "title"],
    Array.from({ length: 1000 }, (_, index) => [
      `article_${index}`,
      `Article ${index}`,
    ])
  );
  await insertRows(
    driver,
    "bench_variant_clips",
    ["id", "title"],
    Array.from({ length: 1000 }, (_, index) => [
      `clip_${index}`,
      `Clip ${index}`,
    ])
  );
  await insertRows(
    driver,
    "bench_variant_comments",
    ["id", "body", "subject_type", "subject_id"],
    Array.from({ length: 1000 }, (_, index) => {
      const isArticle = index % 2 === 0;
      return [
        `comment_${index}`,
        `Comment ${index}`,
        isArticle ? "bench.article.v1" : "bench.clip.v1",
        isArticle ? `article_${index / 2}` : `clip_${Math.floor(index / 2)}`,
      ];
    })
  );
  await insertRows(
    driver,
    "bench_variant_shelves",
    ["id"],
    Array.from({ length: 2000 }, (_, index) => [`shelf_${index}`])
  );
  await insertRows(
    driver,
    "bench_shelf_articles",
    ["shelf_id", "article_id"],
    Array.from({ length: 1000 }, (_, index) => [
      `shelf_${index}`,
      `article_${index}`,
    ])
  );
  await insertRows(
    driver,
    "bench_shelf_clips",
    ["shelf_id", "clip_id"],
    Array.from({ length: 1000 }, (_, index) => [
      `shelf_${index}`,
      `clip_${index}`,
    ])
  );
  return { client, driver };
}

function wideScalarShape(fieldCount) {
  return Object.fromEntries(
    Array.from({ length: fieldCount }, (_, index) => [
      `field${String(index + 1).padStart(3, "0")}`,
      s.string(),
    ])
  );
}

function optionalWideScalarShape(fieldCount) {
  return Object.fromEntries(
    Array.from({ length: fieldCount }, (_, index) => [
      `field${String(index + 1).padStart(3, "0")}`,
      s.string().default(""),
    ])
  );
}

function wideScalarColumns(fieldCount) {
  return Array.from(
    { length: fieldCount },
    (_, index) => `field${String(index + 1).padStart(3, "0")}`
  );
}

function wideScalarValues(fieldCount, prefix) {
  return Array.from(
    { length: fieldCount },
    (_, index) => `${prefix}_${String(index + 1).padStart(3, "0")}`
  );
}

async function setupWideFixture(substrate) {
  const levelRoot = s
    .model({
      id: s.string().id(),
      children: s.toMany(() => levelOne),
    })
    .map("bench_wide_roots");
  const levelOne = s
    .model({
      id: s.string().id(),
      ...wideScalarShape(100),
      rootId: s.string(),
      root: s
        .toOne(() => levelRoot)
        .fields("rootId")
        .references("id"),
      children: s.toMany(() => levelTwo),
    })
    .map("bench_wide_level_one");
  const levelTwo = s
    .model({
      id: s.string().id(),
      ...wideScalarShape(100),
      parentId: s.string(),
      parent: s
        .toOne(() => levelOne)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => levelThree),
    })
    .map("bench_wide_level_two");
  const levelThree = s
    .model({
      id: s.string().id(),
      ...wideScalarShape(100),
      parentId: s.string(),
      parent: s
        .toOne(() => levelTwo)
        .fields("parentId")
        .references("id"),
    })
    .map("bench_wide_level_three");
  const wideWrite = s
    .model({
      id: s.int().id().increment(),
      ...optionalWideScalarShape(20),
    })
    .map("bench_wide_writes");
  const driver = createDriver(substrate);
  const client = createClient({
    schema: { levelRoot, levelOne, levelTwo, levelThree, wideWrite },
    driver,
  });
  await push(client, { force: true });
  const scalarColumns = wideScalarColumns(100);
  await insertRows(driver, "bench_wide_roots", ["id"], [["wide_root"]]);
  await insertRows(
    driver,
    "bench_wide_level_one",
    ["id", ...scalarColumns, "rootId"],
    [["wide_level_one", ...wideScalarValues(100, "value"), "wide_root"]]
  );
  await insertRows(
    driver,
    "bench_wide_level_two",
    ["id", ...scalarColumns, "parentId"],
    [["wide_level_two", ...wideScalarValues(100, "value"), "wide_level_one"]]
  );
  await insertRows(
    driver,
    "bench_wide_level_three",
    ["id", ...scalarColumns, "parentId"],
    [["wide_level_three", ...wideScalarValues(100, "value"), "wide_level_two"]]
  );
  await insertRows(
    driver,
    "bench_wide_writes",
    ["id", ...wideScalarColumns(20)],
    [[1, ...wideScalarValues(20, "initial")]]
  );
  return { client, driver };
}

export async function createBenchmarkFixture(fixtureName, substrate) {
  if (fixtureName === "variant") return setupVariantFixture(substrate);
  if (fixtureName === "wide") return setupWideFixture(substrate);
  return setupCoreFixture(substrate);
}
