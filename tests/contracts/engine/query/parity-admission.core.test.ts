import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { DbNull } from "@schema/json-null";
import type { Model } from "@schema/model";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Lane Q / U1 — the shapes admission must refuse, on every dialect.
 *
 * Each cell here is a FALSIFIER for one fact the parity plan moved to the
 * admission boundary (rule 5: validate once where the payload enters, trust
 * downstream). The witnesses these replace were deleted with
 * `sql-generation.core.test.ts` at `5a37bcd7`; they are restored as one-sided
 * pins — what must be REFUSED — rather than as SQL-text pins of a deleted
 * engine.
 *
 * The field an admission refusal is about is named by the ValidationError's
 * issue PATH, not by its sentence: the per-scalar filter objects are interned
 * per scalar type, so one instance validates `name` on every model. A relation
 * filter's schema IS per relation, so those two sentences keep the slot.
 */

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    category: s.string(),
    metadata: s.json().nullable(),
    posts: s.toMany(() => post),
  })
  .map("parity_admission_authors");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("parity_admission_posts");

const counter = s
  .model({
    id: s.int().id().increment(),
  })
  .map("parity_admission_counters");

/** A parent whose child rows are entirely database-generated. */
const holder = s
  .model({
    id: s.string().id(),
    slots: s.toMany(() => slot),
  })
  .map("parity_admission_holders");

const slot = s
  .model({
    id: s.int().id().increment(),
    holderId: s.string(),
    holder: s
      .toOne(() => holder)
      .fields("holderId")
      .references("id"),
  })
  .map("parity_admission_slots");

/**
 * The third relation surface that spells quantifiers. Its filter is built by
 * `polymorphicCollectionFilterFactory`, not by the to-one/to-many factories,
 * so the emptiness rule has to be asked there too — `{ items: {} }` read as
 * silence is the same `deleteMany` data loss.
 */
const gallery = s
  .model({
    id: s.string().id(),
    items: s.toMany(
      { post: () => post, holder: () => holder, counter: () => counter },
      {
        values: {
          post: "adm.post.v1",
          holder: "adm.holder.v1",
          counter: "adm.counter.v1",
        },
      }
    ),
  })
  .map("parity_admission_galleries");

const schema = { author, post, counter, holder, slot, gallery };

beforeAll(() => hydrateSchemaNames(schema));

type DialectCase = {
  name: string;
  dialect: Dialect;
  createAdapter: () => DatabaseAdapter;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    createAdapter: () => new PostgresAdapter(),
  },
  { name: "MySQL", dialect: "mysql", createAdapter: () => new MySQLAdapter() },
  {
    name: "SQLite",
    dialect: "sqlite",
    createAdapter: () => new SQLiteAdapter(),
  },
];

function build(
  dialectCase: DialectCase,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): string {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new QueryEngine(
    new SqlOnlyDriver(dialectCase.createAdapter(), dialectCase.dialect),
    registry
  );
  return engine
    .build(model, operation as never, args as never)
    .toStatement("?");
}

/**
 * A write verb does not compile to one statement through `build()`, so the
 * write-side cells run the operation on a driver that opens no provider
 * resource: an admission refusal is raised before any statement is dispatched,
 * and a payload that IS admitted resolves against empty rows.
 */
function client(dialectCase: DialectCase) {
  return createClient({
    schema,
    driver: new SqlOnlyDriver(dialectCase.createAdapter(), dialectCase.dialect),
  });
}

describe.each(dialectCases)("$name admission refusals", (dialectCase) => {
  const compile = (
    operation: string,
    args: Record<string, unknown>,
    model: Model<any> = author
  ) => build(dialectCase, model, operation, args);

  test("an empty scalar filter is not a filter", () => {
    expect(() => compile("findMany", { where: { name: {} } })).toThrow(
      "Filter must contain at least one operation."
    );
  });

  test("the same empty filter refuses on the bulk mutations it would have emptied", async () => {
    const c = client(dialectCase);
    await expect(
      c.author.updateMany({ where: { name: {} }, data: { name: "x" } })
    ).rejects.toThrow("must contain at least one operation");
    await expect(c.author.deleteMany({ where: { name: {} } })).rejects.toThrow(
      "must contain at least one operation"
    );
    await c.$disconnect();
  });

  test("an empty WHERE still matches every row", () => {
    const statement = compile("findMany", { where: {} });
    expect(statement).toContain("SELECT");
    expect(statement).not.toContain("0 = 1");
  });

  test("a filter that is empty only after undefined members is empty (D-23)", () => {
    expect(() =>
      compile("findMany", { where: { name: { equals: undefined } } })
    ).toThrow("must contain at least one operation");
  });

  test("`not: {}` is empty too (D-23)", () => {
    expect(() => compile("findMany", { where: { name: { not: {} } } })).toThrow(
      "must contain at least one operation"
    );
  });

  test("a to-many relation filter names its own slot", () => {
    expect(() => compile("findMany", { where: { posts: {} } })).toThrow(
      "Relation filter 'posts' requires one of: some, every, none."
    );
  });

  test("a to-one relation filter names its own slot", () => {
    expect(() =>
      build(dialectCase, post, "findMany", { where: { author: {} } })
    ).toThrow("Relation filter 'author' requires one of: is, isNot.");
  });

  test("a polymorphic collection filter names its own slot", () => {
    expect(() =>
      build(dialectCase, gallery, "findMany", { where: { items: {} } })
    ).toThrow(
      "Polymorphic collection filter 'items' requires one of: some, every, none."
    );
  });

  test("a positive relation filter still compiles", () => {
    expect(
      build(dialectCase, post, "findMany", {
        where: { author: { name: "Alice" } },
      })
    ).toContain("EXISTS");
  });

  test("a JSON filter carrying only a path fails closed", () => {
    expect(() =>
      compile("findMany", { where: { metadata: { path: ["status"] } } })
    ).toThrow("must contain at least one operation");
  });

  test.each([
    ["status", "must start with '$'"],
    ["$.", "an object key may not be empty"],
    ["$.a.", "an object key may not be empty"],
    ["$.*", "wildcards are not supported"],
    ["$[last]", "not a non-negative integer array index"],
    ["$.a[]", "not a non-negative integer array index"],
    ["$.a[-1]", "not a non-negative integer array index"],
    ["$[0", "an unclosed '['"],
    ["$status", "unexpected 's'"],
  ])("the path grammar refuses %s", (path, reason) => {
    expect(() =>
      compile("findMany", { where: { metadata: { path, equals: "x" } } })
    ).toThrow(reason);
  });

  test("a non-portable segment refuses in both spellings, on every dialect", () => {
    expect(() =>
      compile("findMany", {
        where: { metadata: { path: ['quoted"key'], equals: "x" } },
      })
    ).toThrow("portable JSON path");
    expect(() =>
      compile("findMany", {
        where: { metadata: { path: ["back\\slash"], equals: "x" } },
      })
    ).toThrow("portable JSON path");
    expect(() =>
      compile("findMany", {
        where: { metadata: { path: '$."a b"', equals: "x" } },
      })
    ).toThrow("portable JSON path");
  });

  test("the string path form compiles to the array form's statement", () => {
    expect(
      compile("findMany", {
        where: { metadata: { path: "$.pet.toys[0]", equals: "ball" } },
      })
    ).toBe(
      compile("findMany", {
        where: { metadata: { path: ["pet", "toys", "0"], equals: "ball" } },
      })
    );
  });

  test("an inert mode is refused, not ignored", () => {
    expect(() =>
      compile("findMany", {
        where: { metadata: { mode: "insensitive", equals: "x" } },
      })
    ).toThrow("mode: 'insensitive'");
    expect(() =>
      compile("findMany", {
        where: { metadata: { mode: "insensitive", not: DbNull } },
      })
    ).toThrow("mode: 'insensitive'");
    // The positive control: a mode that governs something still compiles.
    expect(
      compile("findMany", {
        where: { metadata: { mode: "insensitive", string_contains: "x" } },
      })
    ).toContain("SELECT");
  });

  test("groupBy admits one column set", () => {
    expect(compile("groupBy", { by: "category" })).toContain("GROUP BY");
    expect(() => compile("groupBy", { by: ["category", "category"] })).toThrow(
      "GroupBy operation does not allow duplicate fields in 'by'"
    );
  });

  test("a default-only row cannot be skipped, at the root or nested", async () => {
    const c = client(dialectCase);
    await expect(
      c.counter.createMany({ data: [{}], skipDuplicates: true })
    ).rejects.toThrow("no portable duplicate-only DEFAULT VALUES primitive");
    // The nested spelling is the one the physical owner never sees: a nested
    // `createMany` is expanded row by row into `create` records long before
    // any set-oriented statement exists.
    await expect(
      c.holder.create({
        data: {
          id: "h1",
          slots: { createMany: { data: [{}], skipDuplicates: true } },
        },
      })
    ).rejects.toThrow("no portable duplicate-only DEFAULT VALUES primitive");
    // Without `skipDuplicates` the same row is a legitimate DEFAULT VALUES row:
    // admission lets it through, and what answers it is then the fixture
    // driver's own window — which acknowledges nothing, and which U5.5 refuses
    // as a shortfall rather than publishing a wrong count. The pin is that the
    // ADMISSION sentence is not the one raised.
    await expect(c.counter.createMany({ data: [{}] })).rejects.toThrow(
      "reported 0 of 1 inserted rows"
    );
    await c.$disconnect();
  });

  test("a default-only row cannot be skipped inside a polymorphic collection createMany either", async () => {
    const c = client(dialectCase);
    // The fourth spelling of the verb: a polymorphic collection GROUP, whose
    // arms are built by `taggedVerb`, not by the model's own mutation args.
    // Inside the tagged union the sentence arrives wrapped, so it is matched by
    // substring — the refusal is the arm's, the wrapper is the union's.
    await expect(
      c.gallery.create({
        data: {
          id: "g1",
          items: {
            createMany: {
              type: "counter",
              data: [{}],
              skipDuplicates: true,
            },
          },
        },
      })
    ).rejects.toThrow("no portable duplicate-only DEFAULT VALUES primitive");
    await expect(
      c.gallery.update({
        where: { id: "g1" },
        data: {
          items: {
            createMany: {
              type: "counter",
              data: [{}],
              skipDuplicates: true,
            },
          },
        },
      })
    ).rejects.toThrow("no portable duplicate-only DEFAULT VALUES primitive");
    await c.$disconnect();
  });
});
