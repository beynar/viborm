import assert from "node:assert/strict";
import type { Schema } from "@client/types";
import type { AnyDriver } from "@drivers";
import { ForeignKeyError, QueryError, UniqueConstraintError } from "@errors";
import { MySQLMigrationDriver } from "@migrations/drivers/mysql";
import { PostgresMigrationDriver } from "@migrations/drivers/postgres";
import { serializeModels } from "@migrations/serializer";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it, vi } from "vitest";
import type { CandidateEngineFactory } from "../harness/protocol";
import {
  type LiveFixture,
  type LiveNames,
  liveProvider,
  runLiveWorld,
} from "../transitions/live-world";

interface PhysicalConstraint {
  readonly name: string;
  readonly kind: "primary" | "unique" | "foreign";
  readonly columns: readonly string[];
}

function assertObservedRow(
  row: unknown
): asserts row is Record<string, unknown> {
  assert(row !== null && typeof row === "object");
}

function observedRows(rows: readonly unknown[] | undefined) {
  return (rows ?? []).map((row) => {
    assertObservedRow(row);
    return row;
  });
}

const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";
const generatedInteger =
  liveProvider === "pg" ? "SERIAL" : "INTEGER AUTO_INCREMENT";

function migrationUniqueName(
  schema: Schema,
  tableName: string,
  columns: readonly string[]
) {
  const migrationDriver =
    liveProvider === "pg"
      ? new PostgresMigrationDriver()
      : new MySQLMigrationDriver();
  const table = serializeModels(schema, { migrationDriver }).tables.find(
    (candidate) => candidate.name === tableName
  );
  assert(table, `Migration snapshot must contain ${tableName}`);
  const constraints = [
    ...table.uniqueConstraints,
    ...table.indexes
      .filter((index) => index.unique && index.where === undefined)
      .map((index) => ({ name: index.name, columns: index.columns })),
  ].filter(
    (candidate) =>
      candidate.columns.length === columns.length &&
      candidate.columns.every((column, index) => column === columns[index])
  );
  assert.equal(constraints.length, 1);
  const constraint = constraints[0];
  assert(constraint);
  return constraint.name;
}

async function readPhysicalConstraints(
  driver: AnyDriver,
  namespace: string,
  tableName: string
): Promise<PhysicalConstraint[]> {
  const query =
    liveProvider === "pg"
      ? `
SELECT
  constraint_record.conname AS constraint_name,
  constraint_record.contype AS constraint_kind,
  column_record.attname AS column_name,
  key_column.position AS ordinal_position
FROM pg_catalog.pg_constraint AS constraint_record
JOIN pg_catalog.pg_class AS table_record
  ON table_record.oid = constraint_record.conrelid
JOIN pg_catalog.pg_namespace AS namespace_record
  ON namespace_record.oid = table_record.relnamespace
JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY
  AS key_column(attribute_number, position) ON true
JOIN pg_catalog.pg_attribute AS column_record
  ON column_record.attrelid = table_record.oid
 AND column_record.attnum = key_column.attribute_number
WHERE namespace_record.nspname = $1
  AND table_record.relname = $2
  AND constraint_record.contype IN ('p', 'u', 'f')
ORDER BY constraint_record.conname, key_column.position`
      : `
SELECT
  table_constraint.CONSTRAINT_NAME AS constraint_name,
  table_constraint.CONSTRAINT_TYPE AS constraint_kind,
  key_column.COLUMN_NAME AS column_name,
  key_column.ORDINAL_POSITION AS ordinal_position
FROM information_schema.TABLE_CONSTRAINTS AS table_constraint
JOIN information_schema.KEY_COLUMN_USAGE AS key_column
  ON key_column.CONSTRAINT_SCHEMA = table_constraint.CONSTRAINT_SCHEMA
 AND key_column.TABLE_NAME = table_constraint.TABLE_NAME
 AND key_column.CONSTRAINT_NAME = table_constraint.CONSTRAINT_NAME
WHERE table_constraint.CONSTRAINT_SCHEMA = ?
  AND table_constraint.TABLE_NAME = ?
  AND table_constraint.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
ORDER BY table_constraint.CONSTRAINT_NAME, key_column.ORDINAL_POSITION`;
  const rows = await driver._executeRaw<Record<string, unknown>>(query, [
    namespace,
    tableName,
  ]);
  const constraints = new Map<string, PhysicalConstraint>();
  for (const row of rows.rows) {
    const name = row.constraint_name;
    const providerKind = row.constraint_kind;
    const column = row.column_name;
    assert(typeof name === "string");
    assert(typeof providerKind === "string");
    assert(typeof column === "string");
    const kind =
      providerKind === "p" || providerKind === "PRIMARY KEY"
        ? "primary"
        : providerKind === "f" || providerKind === "FOREIGN KEY"
          ? "foreign"
          : "unique";
    const existing = constraints.get(name);
    constraints.set(
      name,
      existing
        ? { ...existing, columns: [...existing.columns, column] }
        : { name, kind, columns: [column] }
    );
  }
  return [...constraints.values()];
}

async function attestConstraint(
  driver: AnyDriver,
  namespace: string,
  tableName: string,
  kind: PhysicalConstraint["kind"],
  columns: readonly string[],
  expectedName?: string
) {
  const matches = (
    await readPhysicalConstraints(driver, namespace, tableName)
  ).filter(
    (constraint) =>
      constraint.kind === kind &&
      constraint.columns.length === columns.length &&
      constraint.columns.every((column, index) => column === columns[index])
  );
  assert.equal(matches.length, 1);
  const constraint = matches[0];
  assert(constraint);
  if (expectedName !== undefined) assert.equal(constraint.name, expectedName);
  return constraint;
}

function uniqueDefinition(
  name: string,
  columns: readonly string[],
  names: LiveNames
) {
  return `CONSTRAINT ${names.quote(name)} UNIQUE(${columns
    .map(names.quote)
    .join(",")})`;
}

function assertUniqueFailure(
  failure: unknown,
  tableName: string,
  constraint: PhysicalConstraint
) {
  assert(failure instanceof UniqueConstraintError);
  assert.equal(failure.code, "V3001");
  assert.equal(
    failure.meta.providerCode,
    liveProvider === "pg" ? "23505" : "ER_DUP_ENTRY"
  );
  if (liveProvider === "mysql") assert.equal(failure.meta.providerErrno, 1062);
  assert.equal(failure.meta.table, tableName);
  assert.equal(failure.meta.constraint, constraint.name);
}

function assertForeignKeyFailure(
  failure: unknown,
  tableName: string,
  constraint: PhysicalConstraint
) {
  assert(failure instanceof ForeignKeyError);
  assert.equal(failure.code, "V3002");
  assert.equal(
    failure.meta.providerCode,
    liveProvider === "pg" ? "23503" : "ER_NO_REFERENCED_ROW_2"
  );
  if (liveProvider === "mysql") assert.equal(failure.meta.providerErrno, 1452);
  if (liveProvider === "pg") {
    assert.equal(failure.meta.table, tableName);
    assert.equal(failure.meta.constraint, constraint.name);
  }
}

function throwTerminalFailure(world: Awaited<ReturnType<typeof runLiveWorld>>) {
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
}

async function runRootSuppression(factory: CandidateEngineFactory) {
  const authorTable = "g3p04_native_root_authors";
  const postTable = "g3p04_native_root_posts";
  const author = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map(authorTable);
  const post = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      authorId: s.int(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map(postTable);
  const schema = { author, post };
  const slugConstraintName = migrationUniqueName(schema, postTable, ["slug"]);
  const initial = {
    authors: [{ id: 100, name: "existing-author" }],
    posts: [{ id: 100, slug: "occupied", authorId: 100 }],
  };
  let physicalSlug: PhysicalConstraint | undefined;
  let normalizedRootFailure: unknown;
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const namespace = driver.adapter.namespace;
      assert(typeof namespace === "string");
      physicalSlug = await attestConstraint(
        driver,
        namespace,
        postTable,
        "unique",
        ["slug"],
        slugConstraintName
      );
      const candidate = candidateFactory({ schema, driver });
      const selected = await candidate.execute("post", "createMany", {
        data: [
          { slug: "prefix", author: { create: { name: "prefix-author" } } },
          { slug: "occupied", author: { create: { name: "ghost-author" } } },
          { slug: "suffix", author: { create: { name: "suffix-author" } } },
        ],
        skipDuplicates: true,
        select: { id: true, slug: true, authorId: true },
      });
      await assert.rejects(
        () =>
          candidate.execute("post", "create", {
            data: {
              slug: "occupied",
              author: { connect: { id: 100 } },
            },
          }),
        (failure) => {
          normalizedRootFailure = failure;
          return true;
        }
      );
      return selected;
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      if (observation.outcome.kind !== "success") return;
      const selected = observation.outcome.value;
      assert(Array.isArray(selected));
      assert.equal(selected.length, 2);
      assert.deepEqual(
        selected.map((row) => {
          assert(row !== null && typeof row === "object" && "slug" in row);
          return row.slug;
        }),
        ["prefix", "suffix"]
      );
      for (const selectedPost of selected) {
        assert(
          selectedPost !== null &&
            typeof selectedPost === "object" &&
            "id" in selectedPost &&
            "slug" in selectedPost &&
            "authorId" in selectedPost
        );
        assert(typeof selectedPost.id === "number");
        assert(typeof selectedPost.slug === "string");
        assert(typeof selectedPost.authorId === "number");
        const storedPost = observedRows(observation.final.posts).find(
          (row) => row.slug === selectedPost.slug
        );
        assert(storedPost);
        assert.equal(selectedPost.id, storedPost.id);
        assert.equal(selectedPost.authorId, storedPost.authorId);
      }
      assert.deepEqual(
        observedRows(observation.final.authors)
          .map((row) => row.name)
          .sort(),
        ["existing-author", "prefix-author", "suffix-author"]
      );
      assert.deepEqual(
        observedRows(observation.final.posts)
          .map((row) => row.slug)
          .sort(),
        ["occupied", "prefix", "suffix"]
      );
      const authorsByName = new Map(
        observedRows(observation.final.authors).map((row) => [row.name, row.id])
      );
      for (const row of observedRows(observation.final.posts)) {
        if (row.slug === "prefix")
          assert.equal(row.authorId, authorsByName.get("prefix-author"));
        if (row.slug === "suffix")
          assert.equal(row.authorId, authorsByName.get("suffix-author"));
      }
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [authorTable]: `${names.quote("id")} ${generatedInteger} PRIMARY KEY NOT NULL,${names.quote("name")} ${textType} NOT NULL`,
      [postTable]: `${names.quote("id")} ${generatedInteger} PRIMARY KEY NOT NULL,${names.quote("slug")} ${textType} NOT NULL,${names.quote("authorId")} INTEGER NOT NULL,${uniqueDefinition(slugConstraintName, ["slug"], names)},FOREIGN KEY(${names.quote("authorId")}) REFERENCES ${names.table(authorTable)}(${names.quote("id")})`,
    }),
    factory,
    "interactive"
  );
  throwTerminalFailure(world);
  assert(physicalSlug);
  assertUniqueFailure(normalizedRootFailure, postTable, physicalSlug);
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runJunctionSuppression(factory: CandidateEngineFactory) {
  const shelfTable = "g3p04_native_shelves";
  const publisherTable = "g3p04_native_publishers";
  const bookTable = "g3p04_native_books";
  const junctionTable = "g3p04_native_shelf_books";
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      books: s
        .toMany(() => book)
        .through(junctionTable)
        .source("shelfId")
        .target("bookId"),
    })
    .map(shelfTable);
  const publisher = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      books: s.toMany(() => book),
    })
    .map(publisherTable);
  const book = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      slug: s.string().unique(),
      publisherId: s.int(),
      publisher: s
        .toOne(() => publisher)
        .fields("publisherId")
        .references("id"),
      shelves: s.toMany(() => shelf),
    })
    .map(bookTable);
  const schema = { shelf, publisher, book };
  const codeConstraintName = migrationUniqueName(schema, bookTable, ["code"]);
  const slugConstraintName = migrationUniqueName(schema, bookTable, ["slug"]);
  const initial = {
    shelves: [{ id: "s1", label: "main" }],
    publishers: [{ id: 100, name: "existing-publisher" }],
    books: [
      {
        id: 100,
        code: "occupied-code",
        slug: "existing-slug",
        publisherId: 100,
      },
    ],
    memberships: [],
  };
  let codeConstraint: PhysicalConstraint | undefined;
  let slugConstraint: PhysicalConstraint | undefined;
  const fixture: LiveFixture = {
    initial,
    tables: {
      shelves: { name: shelfTable, order: ["id"] },
      publishers: { name: publisherTable, order: ["id"] },
      books: { name: bookTable, order: ["id"] },
      memberships: { name: junctionTable, order: ["shelfId", "bookId"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const namespace = driver.adapter.namespace;
      assert(typeof namespace === "string");
      codeConstraint = await attestConstraint(
        driver,
        namespace,
        bookTable,
        "unique",
        ["code"],
        codeConstraintName
      );
      slugConstraint = await attestConstraint(
        driver,
        namespace,
        bookTable,
        "unique",
        ["slug"],
        slugConstraintName
      );
      return candidateFactory({ schema, driver }).execute("shelf", "update", {
        where: { id: "s1" },
        data: {
          books: {
            createMany: {
              data: [
                {
                  code: "prefix-code",
                  slug: "prefix-slug",
                  publisher: { create: { name: "prefix-publisher" } },
                },
                {
                  code: "occupied-code",
                  slug: "attempted-distinct-slug",
                  publisher: { create: { name: "ghost-publisher" } },
                },
                {
                  code: "suffix-code",
                  slug: "suffix-slug",
                  publisher: { create: { name: "suffix-publisher" } },
                },
              ],
              skipDuplicates: true,
            },
          },
        },
        select: { id: true, label: true },
      });
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: { id: "s1", label: "main" },
      });
      const publishers = observedRows(observation.final.publishers);
      assert.deepEqual(publishers.map((row) => row.name).sort(), [
        "existing-publisher",
        "prefix-publisher",
        "suffix-publisher",
      ]);
      const books = observedRows(observation.final.books);
      assert.deepEqual(books.map((row) => row.code).sort(), [
        "occupied-code",
        "prefix-code",
        "suffix-code",
      ]);
      assert.equal(
        books.some((row) => row.slug === "attempted-distinct-slug"),
        false,
        "The conflicting member must not be adopted through its other unique key"
      );
      const linkedBookIds = books
        .filter(
          (row) => row.code === "prefix-code" || row.code === "suffix-code"
        )
        .map((row) => row.id)
        .sort();
      const memberships = observedRows(observation.final.memberships);
      assert.equal(memberships.length, 2);
      for (const membership of memberships) {
        assert.deepEqual(Object.keys(membership).sort(), ["bookId", "shelfId"]);
        assert.equal(membership.shelfId, "s1");
      }
      assert.deepEqual(
        memberships.map((row) => row.bookId).sort(),
        linkedBookIds
      );
    },
  };
  const definitions = (names: LiveNames) => ({
    [shelfTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("label")} ${textType} NOT NULL`,
    [publisherTable]: `${names.quote("id")} ${generatedInteger} PRIMARY KEY NOT NULL,${names.quote("name")} ${textType} NOT NULL`,
    [bookTable]: `${names.quote("id")} ${generatedInteger} PRIMARY KEY NOT NULL,${names.quote("code")} ${textType} NOT NULL,${names.quote("slug")} ${textType} NOT NULL,${names.quote("publisherId")} INTEGER NOT NULL,${uniqueDefinition(codeConstraintName, ["code"], names)},${uniqueDefinition(slugConstraintName, ["slug"], names)},FOREIGN KEY(${names.quote("publisherId")}) REFERENCES ${names.table(publisherTable)}(${names.quote("id")})`,
    [junctionTable]: `${names.quote("shelfId")} ${textType} NOT NULL,${names.quote("bookId")} INTEGER NOT NULL,PRIMARY KEY(${names.quote("shelfId")},${names.quote("bookId")}),FOREIGN KEY(${names.quote("shelfId")}) REFERENCES ${names.table(shelfTable)}(${names.quote("id")}),FOREIGN KEY(${names.quote("bookId")}) REFERENCES ${names.table(bookTable)}(${names.quote("id")})`,
  });
  const world = await runLiveWorld(
    fixture,
    definitions,
    factory,
    "interactive"
  );
  throwTerminalFailure(world);
  assert(codeConstraint);
  assert(slugConstraint);
  fixture.assert(world.observation);
  world.assertHealthy();

  // Owner decision 2026-09-24 ("Warn, drop skipDuplicates"): a borrowed
  // operation holds no member rollback region, so the nested skip is dropped
  // with one warning and the member runs plainly — its row and membership are
  // written, and a real duplicate fails with the ordinary unique error.
  let duplicateFailure: unknown;
  let borrowedDriver: AnyDriver | undefined;
  let factoryDriver: AnyDriver | undefined;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const shelfUpdate = (label: string, code: string, slug: string) => ({
    where: { id: "s1" },
    data: {
      label,
      books: {
        createMany: {
          data: [{ code, slug, publisherId: 100 }],
          skipDuplicates: true,
        },
      },
    },
  });
  const borrowedFixture: LiveFixture = {
    initial,
    tables: fixture.tables,
    expectedExecutions: 2,
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      factoryDriver = driver;
      const candidate = candidateFactory({ schema, driver });
      await driver.withTransaction(async (transactionDriver) => {
        borrowedDriver = transactionDriver;
        await candidate.execute(
          "shelf",
          "update",
          shelfUpdate("after", "borrowed-code", "borrowed-slug"),
          { kind: "borrowed-transaction", driver: transactionDriver }
        );
      });
      await driver
        .withTransaction((transactionDriver) =>
          candidate.execute(
            "shelf",
            "update",
            shelfUpdate("rolled-back", "occupied-code", "duplicate-slug"),
            { kind: "borrowed-transaction", driver: transactionDriver }
          )
        )
        .catch((failure: unknown) => {
          duplicateFailure = failure;
        });
      return "borrowed-dropped";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "borrowed-dropped",
      });
      assert.deepEqual(
        observedRows(observation.final.shelves).map((row) => row.label),
        ["after"]
      );
      const books = observedRows(observation.final.books);
      assert.deepEqual(books.map((row) => row.slug).sort(), [
        "borrowed-slug",
        "existing-slug",
      ]);
      const borrowedBook = books.find((row) => row.code === "borrowed-code");
      assert(borrowedBook);
      assert.deepEqual(
        observedRows(observation.final.memberships).map((row) => ({
          ...row,
        })),
        [{ shelfId: "s1", bookId: borrowedBook.id }]
      );
    },
  };
  try {
    const borrowedWorld = await runLiveWorld(
      borrowedFixture,
      definitions,
      factory,
      "interactive"
    );
    throwTerminalFailure(borrowedWorld);
    assert(factoryDriver);
    assert(borrowedDriver);
    assert.notEqual(borrowedDriver, factoryDriver);
    assert(duplicateFailure instanceof UniqueConstraintError);
    assert.deepEqual(warn.mock.calls, [
      [
        `[viborm] createMany skipDuplicates cannot skip rows involving nested writes on driver "${factoryDriver.driverName}" (no savepoint available) in shelf.update; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`,
      ],
    ]);
    borrowedFixture.assert(borrowedWorld.observation);
    borrowedWorld.assertHealthy();
  } finally {
    warn.mockRestore();
  }
}

function fatalSchema() {
  const authorTable = "g3p04_native_fatal_authors";
  const postTable = "g3p04_native_fatal_posts";
  const author = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map(authorTable);
  const post = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      authorId: s.int(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map(postTable);
  return { authorTable, postTable, schema: { author, post } };
}

function fatalDefinitions(
  schema: ReturnType<typeof fatalSchema>["schema"],
  authorTable: string,
  postTable: string,
  foreignName: string
) {
  const authorName = migrationUniqueName(schema, authorTable, ["name"]);
  const slugName = migrationUniqueName(schema, postTable, ["slug"]);
  return {
    authorName,
    definitions(names: LiveNames) {
      return {
        [authorTable]: `${names.quote("id")} ${generatedInteger} PRIMARY KEY NOT NULL,${names.quote("name")} ${textType} NOT NULL,${uniqueDefinition(authorName, ["name"], names)}`,
        [postTable]: `${names.quote("id")} ${generatedInteger} PRIMARY KEY NOT NULL,${names.quote("slug")} ${textType} NOT NULL,${names.quote("authorId")} INTEGER NOT NULL,${uniqueDefinition(slugName, ["slug"], names)},CONSTRAINT ${names.quote(foreignName)} FOREIGN KEY(${names.quote("authorId")}) REFERENCES ${names.table(authorTable)}(${names.quote("id")})`,
      };
    },
  };
}

async function runDescendantAndRootFatal(factory: CandidateEngineFactory) {
  const { authorTable, postTable, schema } = fatalSchema();
  const foreignName = "g3p04_native_fatal_posts_author_fk";
  const ddl = fatalDefinitions(schema, authorTable, postTable, foreignName);
  const initial = {
    authors: [{ id: 100, name: "occupied-author" }],
    posts: [],
  };
  let descendantFailure: unknown;
  let descendantConstraint: PhysicalConstraint | undefined;
  const descendantFixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const namespace = driver.adapter.namespace;
      assert(typeof namespace === "string");
      descendantConstraint = await attestConstraint(
        driver,
        namespace,
        authorTable,
        "unique",
        ["name"],
        ddl.authorName
      );
      await assert.rejects(
        () =>
          candidateFactory({ schema, driver }).execute("post", "createMany", {
            data: [
              {
                slug: "prefix-descendant",
                author: { create: { name: "prefix-author" } },
              },
              {
                slug: "doomed-descendant",
                author: { create: { name: "occupied-author" } },
              },
            ],
            skipDuplicates: true,
          }),
        (failure) => {
          descendantFailure = failure;
          return true;
        }
      );
      return "descendant-refused";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "descendant-refused",
      });
      assert.deepEqual(observation.final, initial);
    },
  };
  const descendantWorld = await runLiveWorld(
    descendantFixture,
    ddl.definitions,
    factory,
    "interactive"
  );
  throwTerminalFailure(descendantWorld);
  assert(descendantConstraint);
  assertUniqueFailure(descendantFailure, authorTable, descendantConstraint);
  descendantFixture.assert(descendantWorld.observation);
  descendantWorld.assertHealthy();

  let foreignFailure: unknown;
  let foreignConstraint: PhysicalConstraint | undefined;
  const foreignFixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const namespace = driver.adapter.namespace;
      assert(typeof namespace === "string");
      foreignConstraint = await attestConstraint(
        driver,
        namespace,
        postTable,
        "foreign",
        ["authorId"],
        foreignName
      );
      await assert.rejects(
        () =>
          candidateFactory({ schema, driver }).execute("post", "createMany", {
            data: [
              {
                slug: "prefix-foreign",
                author: { create: { name: "prefix-foreign-author" } },
              },
              { slug: "doomed-foreign", authorId: 999_999 },
            ],
            skipDuplicates: true,
          }),
        (failure) => {
          foreignFailure = failure;
          return true;
        }
      );
      return "foreign-refused";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "foreign-refused",
      });
      assert.deepEqual(observation.final, initial);
    },
  };
  const foreignWorld = await runLiveWorld(
    foreignFixture,
    ddl.definitions,
    factory,
    "interactive"
  );
  throwTerminalFailure(foreignWorld);
  assert(foreignConstraint);
  assertForeignKeyFailure(foreignFailure, postTable, foreignConstraint);
  foreignFixture.assert(foreignWorld.observation);
  foreignWorld.assertHealthy();
}

async function runStandaloneAndBorrowedScopes(factory: CandidateEngineFactory) {
  const { authorTable, postTable, schema } = fatalSchema();
  const foreignName = "g3p04_native_fatal_posts_author_fk";
  const ddl = fatalDefinitions(schema, authorTable, postTable, foreignName);
  const initial = {
    authors: [{ id: 100, name: "existing-author" }],
    posts: [{ id: 100, slug: "occupied", authorId: 100 }],
  };
  const standaloneFixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      return candidateFactory({ schema, driver }).execute(
        "post",
        "createMany",
        {
          data: [
            {
              slug: "occupied",
              author: { create: { name: "ghost-author" } },
            },
            {
              slug: "healthy-suffix",
              author: { create: { name: "suffix-author" } },
            },
          ],
          skipDuplicates: true,
          select: { slug: true, authorId: true },
        }
      );
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      if (observation.outcome.kind !== "success") return;
      const storedSuffix = observedRows(observation.final.posts).find(
        (row) => row.slug === "healthy-suffix"
      );
      assert(storedSuffix);
      assert(typeof storedSuffix.authorId === "number");
      assert.deepEqual(observation.outcome.value, [
        { slug: "healthy-suffix", authorId: storedSuffix.authorId },
      ]);
      assert.deepEqual(
        observedRows(observation.final.authors)
          .map((row) => row.name)
          .sort(),
        ["existing-author", "suffix-author"]
      );
      assert.deepEqual(
        observedRows(observation.final.posts)
          .map((row) => row.slug)
          .sort(),
        ["healthy-suffix", "occupied"]
      );
    },
  };
  const standaloneWorld = await runLiveWorld(
    standaloneFixture,
    ddl.definitions,
    factory,
    "interactive"
  );
  throwTerminalFailure(standaloneWorld);
  standaloneFixture.assert(standaloneWorld.observation);
  standaloneWorld.assertHealthy();

  // The borrowed arm drops the skip with one warning (owner decision
  // 2026-09-24): the member runs plainly, and a real duplicate fails with the
  // ordinary unique error that rolls the caller's transaction back.
  let duplicateFailure: unknown;
  let borrowedDriver: AnyDriver | undefined;
  let factoryDriver: AnyDriver | undefined;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const borrowedMember = (slug: string, author: string) => ({
    data: [{ slug, author: { create: { name: author } } }],
    skipDuplicates: true,
  });
  const borrowedFixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    expectedExecutions: 2,
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      factoryDriver = driver;
      const candidate = candidateFactory({ schema, driver });
      await driver.withTransaction(async (transactionDriver) => {
        borrowedDriver = transactionDriver;
        await candidate.execute(
          "post",
          "createMany",
          borrowedMember("borrowed-post", "borrowed-author"),
          { kind: "borrowed-transaction", driver: transactionDriver }
        );
      });
      await driver
        .withTransaction((transactionDriver) =>
          candidate.execute(
            "post",
            "createMany",
            borrowedMember("occupied", "rolled-back-author"),
            { kind: "borrowed-transaction", driver: transactionDriver }
          )
        )
        .catch((failure: unknown) => {
          duplicateFailure = failure;
        });
      return "borrowed-dropped";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "borrowed-dropped",
      });
      assert.deepEqual(
        observedRows(observation.final.authors)
          .map((row) => row.name)
          .sort(),
        ["borrowed-author", "existing-author"]
      );
      assert.deepEqual(
        observedRows(observation.final.posts)
          .map((row) => row.slug)
          .sort(),
        ["borrowed-post", "occupied"]
      );
    },
  };
  try {
    const borrowedWorld = await runLiveWorld(
      borrowedFixture,
      ddl.definitions,
      factory,
      "interactive"
    );
    throwTerminalFailure(borrowedWorld);
    assert(factoryDriver);
    assert(borrowedDriver);
    assert.notEqual(borrowedDriver, factoryDriver);
    assert(duplicateFailure instanceof UniqueConstraintError);
    assert.deepEqual(warn.mock.calls, [
      [
        `[viborm] createMany skipDuplicates cannot skip rows involving nested writes on driver "${factoryDriver.driverName}" (no savepoint available) in post.createMany; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`,
      ],
    ]);
    borrowedFixture.assert(borrowedWorld.observation);
    borrowedWorld.assertHealthy();
  } finally {
    warn.mockRestore();
  }

  // A RELATION-FREE createMany in the same borrowed scope. Postgres skips in
  // SQL (`ON CONFLICT DO NOTHING`), so no member rollback region is needed and
  // the skip holds with no warning. MySQL skips per row under a member
  // rollback region (`recoverableUniqueError`), which a borrowed operation does
  // not own, so there the skip is dropped with one warning and the rows run
  // plainly: a real duplicate fails with the ordinary unique error.
  let scalarFailure: unknown;
  const scalarWarn = vi
    .spyOn(console, "warn")
    .mockImplementation(() => undefined);
  const scalarRows = (slug: string) => ({
    data: [
      { slug: "occupied", authorId: 100 },
      { slug, authorId: 100 },
    ],
    skipDuplicates: true,
  });
  const scalarFixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      factoryDriver = driver;
      const candidate = candidateFactory({ schema, driver });
      return driver
        .withTransaction((transactionDriver) =>
          candidate.execute("post", "createMany", scalarRows("scalar-post"), {
            kind: "borrowed-transaction",
            driver: transactionDriver,
          })
        )
        .catch((failure: unknown) => {
          scalarFailure = failure;
          return "scalar-failed";
        });
    },
    assert(observation) {
      const slugs = observedRows(observation.final.posts)
        .map((row) => row.slug)
        .sort();
      if (liveProvider === "pg") {
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { count: 1 },
        });
        assert.deepEqual(slugs, ["occupied", "scalar-post"]);
      } else {
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: "scalar-failed",
        });
        assert.deepEqual(slugs, ["occupied"]);
      }
    },
  };
  try {
    const scalarWorld = await runLiveWorld(
      scalarFixture,
      ddl.definitions,
      factory,
      "interactive"
    );
    throwTerminalFailure(scalarWorld);
    assert(factoryDriver);
    if (liveProvider === "pg") {
      assert.equal(scalarFailure, undefined);
      assert.deepEqual(scalarWarn.mock.calls, []);
    } else {
      assert(scalarFailure instanceof UniqueConstraintError);
      assert.deepEqual(scalarWarn.mock.calls, [
        [
          `[viborm] createMany skipDuplicates cannot skip duplicate rows on driver "${factoryDriver.driverName}" (no savepoint available) in post.createMany; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`,
        ],
      ]);
    }
    scalarFixture.assert(scalarWorld.observation);
    scalarWorld.assertHealthy();
  } finally {
    scalarWarn.mockRestore();
  }

  if (liveProvider === "pg") {
    const cleanupFailure = new Error("g3p04 outer rollback observation failed");
    const cleanupInitial = {
      authors: [{ id: 100, name: "occupied-author" }],
      posts: [],
    };
    const cleanupFixture: LiveFixture = {
      initial: cleanupInitial,
      tables: {
        authors: { name: authorTable, order: ["id"] },
        posts: { name: postTable, order: ["id"] },
      },
      afterRollback() {
        throw cleanupFailure;
      },
      invoke(driver, candidateFactory) {
        assert(candidateFactory);
        return candidateFactory({ schema, driver }).execute(
          "post",
          "createMany",
          {
            data: [
              {
                slug: "cleanup-prefix",
                author: { create: { name: "cleanup-prefix-author" } },
              },
              {
                slug: "cleanup-doomed",
                author: { create: { name: "occupied-author" } },
              },
            ],
            skipDuplicates: true,
          }
        );
      },
      assert(observation) {
        assert.equal(observation.outcome.kind, "failure");
        assert.deepEqual(observation.final, cleanupInitial);
      },
    };
    const cleanupWorld = await runLiveWorld(
      cleanupFixture,
      ddl.definitions,
      factory,
      "interactive"
    );
    assert(cleanupWorld.terminalFailure instanceof AggregateError);
    const [primaryFailure, reportedCleanup] =
      cleanupWorld.terminalFailure.errors;
    assert(primaryFailure instanceof UniqueConstraintError);
    assert.equal(cleanupWorld.terminalFailure.cause, primaryFailure);
    assert(reportedCleanup instanceof QueryError);
    assert.equal(reportedCleanup.code, "V2001");
    assert.equal(reportedCleanup.message, "Query execution failed");
    assert(reportedCleanup.originalCause instanceof Error);
    assert.equal(
      reportedCleanup.originalCause.message,
      "Underlying error details redacted"
    );
    assert.equal(cleanupWorld.rollbacks.length, 1);
    assert.equal(cleanupWorld.rollbacks[0]?.failure, cleanupFailure);
    cleanupFixture.assert(cleanupWorld.observation);
    cleanupWorld.assertHealthy();
  }
}

describe(`G3P-04 native ${liveProvider} suppression replay`, () => {
  it(
    "g3p04-root-prerequisite-suppression-and-suffix",
    () => runRootSuppression(createCommandEngine),
    30_000
  );
  it(
    "g3p04-junction-root-suppression-and-suffix",
    () => runJunctionSuppression(createCommandEngine),
    30_000
  );
  it(
    "g3p04-descendant-and-root-nonunique-fatal",
    () => runDescendantAndRootFatal(createCommandEngine),
    30_000
  );
  it(
    "g3p04-standalone-savepoint-and-borrowed-dropped-skip",
    () => runStandaloneAndBorrowedScopes(createCommandEngine),
    30_000
  );
});
