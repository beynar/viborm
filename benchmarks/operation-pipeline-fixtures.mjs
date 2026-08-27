/** Fresh database construction and immutable seed data for pipeline workloads. */

import { createClient } from "../dist/index.mjs";
import { push } from "../dist/migrations.mjs";
import { s } from "../dist/schema.mjs";
import { SQLite3Driver } from "../dist/sqlite3.mjs";

/**
 * The dialect each core-fixture provider speaks.
 *
 * The core fixture used to be SQLite3-only, which made "flat read, nested read,
 * create, 100-statement batch" unmeasurable on any other engine. The provider
 * is now a parameter; everything below that differs between engines — identifier
 * quoting, the bind placeholder, the wire shape of a boolean, and where a fresh
 * database comes from — is derived from this map and nothing else.
 */
const PROVIDER_DIALECTS = Object.freeze({
  sqlite3: "sqlite",
  pglite: "postgresql",
  mysql2: "mysql",
});

/**
 * A driver whose only transactional substrate is a batch.
 *
 * The batch-only substrate is a property of the WORKLOAD, not of the engine, so
 * it is expressed once as a subclass factory and applied to whichever provider
 * the leg names.
 */
function batchOnly(DriverClass) {
  return class BatchOnlyDriver extends DriverClass {
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
  };
}

const BatchOnlySQLite3Driver = batchOnly(SQLite3Driver);

/**
 * A driver that closes the pool it was handed.
 *
 * The fixture creates that pool, so the fixture is the caller a supplied pool
 * belongs to, and the worker's single `disconnect()` is where it has to be
 * released — otherwise the pool's idle sockets keep the measuring process alive
 * after it has printed its result. Making it explicit here also keeps the two
 * sides of a comparison symmetric whatever either build's own default is.
 */
function poolOwning(DriverClass) {
  return class PoolOwningDriver extends DriverClass {
    async closeClient(pool) {
      await pool.end();
    }
  };
}

/**
 * Two fixtures are built per worker (measured and semantic), and on a service
 * provider they cannot share one database or the second one's seed would land
 * on top of the first one's rows. Each gets its own disposable database, named
 * from this counter and dropped-then-created at setup, so a worker never
 * inherits a previous worker's state either.
 */
let serviceFixtureIndex = 0;

const LEADING_SLASH = /^\//;

async function freshMySQLDatabaseUrl() {
  const base = process.env.VIBORM_BENCH_MYSQL2_URL;
  if (!base) {
    throw new Error(
      "The mysql2 core fixture requires VIBORM_BENCH_MYSQL2_URL pointing at a disposable benchmark server"
    );
  }
  const url = new URL(base);
  const source = url.pathname.replace(LEADING_SLASH, "") || "viborm";
  const database = `${source}_bench_${serviceFixtureIndex++}`;
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(base);
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.query(`CREATE DATABASE \`${database}\``);
  } finally {
    await connection.end();
  }
  url.pathname = `/${database}`;
  return url.toString();
}

const EMPTY_EXTENSION_PATCH = Object.freeze({});
const NOOP_CLIENT_METHODS = Object.freeze({
  $benchmarkNoop: () => undefined,
});
const NOOP_MODEL_METHODS = Object.freeze({
  benchmarkNoop: () => undefined,
});
const NOOP_EXTENSION_DEFINITIONS = Object.freeze({
  request: Object.freeze({
    name: "benchmark-noop-request",
    request: () => EMPTY_EXTENSION_PATCH,
  }),
  query: Object.freeze({
    name: "benchmark-noop-query",
    query: async ({ proceed }) => proceed(),
  }),
  statement: Object.freeze({
    name: "benchmark-noop-statement",
    statement: ({ statement }) => statement,
  }),
  observe: Object.freeze({
    name: "benchmark-noop-observe",
    observe: () => undefined,
  }),
  client: Object.freeze({
    name: "benchmark-noop-client",
    client: () => NOOP_CLIENT_METHODS,
  }),
  model: Object.freeze({
    name: "benchmark-noop-model",
    model: Object.freeze({ user: () => NOOP_MODEL_METHODS }),
  }),
});

function applyExtensionArm(client, extensionArm) {
  if (extensionArm === "unextended") return client;
  const definition = NOOP_EXTENSION_DEFINITIONS[extensionArm];
  if (!definition) {
    throw new Error(`Unknown extension benchmark arm: ${extensionArm}`);
  }
  if (typeof client.$extends !== "function") {
    throw new Error(
      `Extension benchmark arm ${extensionArm} requires client.$extends()`
    );
  }
  return client.$extends(definition);
}

/**
 * The driver a fixture MEASURES through, and the one it BUILDS its schema with.
 *
 * They are the same object everywhere except mysql2. There, the measured driver
 * takes a supplied connection pool — an opaque handle from which no target is
 * derived — so the statements under measurement name their tables exactly as
 * they always did, and the pool's own database is what resolves them. Migration
 * work needs a resolved database, so the schema is built through a second,
 * URL-bound driver on the same database and that driver is closed again before
 * anything is measured. Setup is never a measured stage.
 */
async function createDriver(substrate, providerName) {
  const batched = substrate === "batch-only";
  if (providerName === "sqlite3") {
    const DriverClass = batched ? BatchOnlySQLite3Driver : SQLite3Driver;
    return { driver: new DriverClass({ dataDir: ":memory:" }) };
  }
  if (providerName === "pglite") {
    const { PGliteDriver } = await import("../dist/pglite.mjs");
    const DriverClass = batched ? batchOnly(PGliteDriver) : PGliteDriver;
    return { driver: new DriverClass() };
  }
  if (providerName === "mysql2") {
    const { MySQL2Driver } = await import("../dist/mysql2.mjs");
    const { createPool } = await import("mysql2/promise");
    const DriverClass = poolOwning(
      batched ? batchOnly(MySQL2Driver) : MySQL2Driver
    );
    const databaseUrl = await freshMySQLDatabaseUrl();
    return {
      driver: new DriverClass({ pool: createPool(databaseUrl) }),
      // The attestation is the shipped requirement for MySQL migration work and
      // is an unread extra key on any build that does not know it, so ONE
      // fixture serves both sides of a comparison.
      schemaDriver: new MySQL2Driver({
        databaseUrl,
        migrationNamespaceAttestation: "non-redirecting",
      }),
    };
  }
  throw new Error(`The core fixture is not defined for ${providerName}`);
}

function quoteIdentifier(dialect, name) {
  return dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
}

/** PostgreSQL binds by position; SQLite and MySQL both bind by `?`. */
function bindPlaceholder(dialect, position) {
  return dialect === "postgresql" ? `$${position}` : "?";
}

/** PostgreSQL's `boolean` refuses an integer bind; SQLite and MySQL want one. */
function booleanSeed(dialect, value) {
  return dialect === "postgresql" ? Boolean(value) : value;
}

async function insertRows(driver, dialect, table, columns, rows) {
  const maximumRows = Math.max(1, Math.floor(900 / columns.length));
  const quotedColumns = columns
    .map((column) => quoteIdentifier(dialect, column))
    .join(", ");
  for (let start = 0; start < rows.length; start += maximumRows) {
    const chunk = rows.slice(start, start + maximumRows);
    let position = 0;
    const placeholders = chunk
      .map(
        () =>
          `(${columns
            .map(() => bindPlaceholder(dialect, ++position))
            .join(", ")})`
      )
      .join(", ");
    await driver._executeRaw(
      `INSERT INTO ${quoteIdentifier(dialect, table)} (${quotedColumns}) VALUES ${placeholders}`,
      chunk.flat()
    );
  }
}

/** Builds the fixture's tables, through the schema driver when there is one. */
async function buildSchema(schema, driver, schemaDriver) {
  if (!schemaDriver) {
    await push(createClient({ schema, driver }), { force: true });
    return;
  }
  try {
    await push(createClient({ schema, driver: schemaDriver }), { force: true });
  } finally {
    await schemaDriver.disconnect();
  }
}

async function setupCoreFixture(substrate, extensionArm, providerName) {
  const dialect = PROVIDER_DIALECTS[providerName];
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
  const schema = {
    user,
    post,
    generated,
    generatedParent,
    generatedChild,
    enumRecord,
  };
  const { driver, schemaDriver } = await createDriver(substrate, providerName);
  const baseClient = createClient({ schema, driver });
  await buildSchema(schema, driver, schemaDriver);
  await insertRows(
    driver,
    dialect,
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
    dialect,
    "bench_posts",
    ["id", "title", "content", "published", "views", "authorId"],
    Array.from({ length: 1000 }, (_, index) => [
      `post_${index}`,
      `Post ${index}`,
      `Content ${index}`,
      booleanSeed(dialect, index % 2),
      index,
      `user_${index}`,
    ])
  );
  await insertRows(
    driver,
    dialect,
    "bench_enum_records",
    ["id", "status", "priority", "visibility"],
    Array.from({ length: 1000 }, (_, index) => [
      `enum_${index}`,
      ["draft", "review", "published"][index % 3],
      ["low", "medium", "high"][index % 3],
      ["private", "team", "public"][index % 3],
    ])
  );
  await baseClient.user.create({
    data: {
      id: "update_target",
      name: "Update",
      email: "update@example.com",
      age: 1,
    },
  });
  await baseClient.user.create({
    data: {
      id: "relation_update_target",
      name: "Relation update",
      email: "relation-update@example.com",
      age: 1,
    },
  });
  return { client: applyExtensionArm(baseClient, extensionArm), driver };
}

async function setupVariantFixture(substrate, providerName) {
  const dialect = PROVIDER_DIALECTS[providerName];
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
  const schema = { article, clip, shelf, comment };
  const { driver, schemaDriver } = await createDriver(substrate, providerName);
  const client = createClient({ schema, driver });
  await buildSchema(schema, driver, schemaDriver);
  await insertRows(
    driver,
    dialect,
    "bench_variant_articles",
    ["id", "title"],
    Array.from({ length: 1000 }, (_, index) => [
      `article_${index}`,
      `Article ${index}`,
    ])
  );
  await insertRows(
    driver,
    dialect,
    "bench_variant_clips",
    ["id", "title"],
    Array.from({ length: 1000 }, (_, index) => [
      `clip_${index}`,
      `Clip ${index}`,
    ])
  );
  await insertRows(
    driver,
    dialect,
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
    dialect,
    "bench_variant_shelves",
    ["id"],
    Array.from({ length: 2000 }, (_, index) => [`shelf_${index}`])
  );
  await insertRows(
    driver,
    dialect,
    "bench_shelf_articles",
    ["shelf_id", "article_id"],
    Array.from({ length: 1000 }, (_, index) => [
      `shelf_${index}`,
      `article_${index}`,
    ])
  );
  await insertRows(
    driver,
    dialect,
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

async function setupWideFixture(substrate, providerName) {
  const dialect = PROVIDER_DIALECTS[providerName];
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
  const schema = { levelRoot, levelOne, levelTwo, levelThree, wideWrite };
  const { driver, schemaDriver } = await createDriver(substrate, providerName);
  const client = createClient({ schema, driver });
  await buildSchema(schema, driver, schemaDriver);
  const scalarColumns = wideScalarColumns(100);
  await insertRows(
    driver,
    dialect,
    "bench_wide_roots",
    ["id"],
    [["wide_root"]]
  );
  await insertRows(
    driver,
    dialect,
    "bench_wide_level_one",
    ["id", ...scalarColumns, "rootId"],
    [["wide_level_one", ...wideScalarValues(100, "value"), "wide_root"]]
  );
  await insertRows(
    driver,
    dialect,
    "bench_wide_level_two",
    ["id", ...scalarColumns, "parentId"],
    [["wide_level_two", ...wideScalarValues(100, "value"), "wide_level_one"]]
  );
  await insertRows(
    driver,
    dialect,
    "bench_wide_level_three",
    ["id", ...scalarColumns, "parentId"],
    [["wide_level_three", ...wideScalarValues(100, "value"), "wide_level_two"]]
  );
  await insertRows(
    driver,
    dialect,
    "bench_wide_writes",
    ["id", ...wideScalarColumns(20)],
    [[1, ...wideScalarValues(20, "initial")]]
  );
  return { client, driver };
}

export async function createBenchmarkFixture(
  fixtureName,
  substrate,
  extensionArm = "unextended",
  providerName = "sqlite3"
) {
  if (!PROVIDER_DIALECTS[providerName]) {
    throw new Error(`The core fixture is not defined for ${providerName}`);
  }
  if (fixtureName === "variant") {
    return setupVariantFixture(substrate, providerName);
  }
  if (fixtureName === "wide") return setupWideFixture(substrate, providerName);
  return setupCoreFixture(substrate, extensionArm, providerName);
}
