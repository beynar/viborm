import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import {
  createSchemaFieldRefs,
  FIELD_REF_BRAND,
  type FieldRef,
  isFieldRef,
} from "@schema/field-ref";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Field references (Prisma `FieldRef` parity) — the parts a live database
 * cannot show: the emitted SQL shape, the surfaces that stay closed, and the
 * laziness of the `$fields` surface.
 *
 * Behavior against real databases lives in
 * {@link file://../drivers/field-reference-behavior.ts} (all three local dialects).
 */

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `field-ref-sql-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // No external client is allocated by this SQL-only driver.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const User = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => Post),
  })
  .map("fieldref_sql_users");

const Post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    views: s.int(),
    likes: s.int().map("like_count"),
    // A second, .map()ed string column: the operand of a text comparison, so
    // the collation/folding wrappers can be pinned on BOTH sides.
    slug: s.string().map("slug_col"),
    tags: s.string().array(),
    // Two JSON columns: JSON is the only operand position that accepts an
    // arbitrary object, so it is the only one where a reference token is a
    // structurally VALID value and has to be refused on purpose.
    meta: s.json().nullable(),
    meta2: s.json().nullable(),
    authorId: s.string(),
    author: s
      .manyToOne(() => User)
      .fields("authorId")
      .references("id"),
  })
  .map("fieldref_sql_posts");

const schema = { User, Post };

const CROSS_MODEL_REFUSAL =
  /Field reference 'User\.name' cannot be used while filtering 'Post'/;
const WRONG_TYPE_REFUSAL =
  /is of type 'int', but a 'string' operand is required/;
const LIST_REFUSAL = /is a list field/;
const HAVING_REFUSAL = /is not supported in 'having'/;
const JSON_FILTER_REFUSAL =
  /Field reference 'Post\.meta2' is not supported in a JSON filter operand/;
const JSON_DATA_REFUSAL =
  /Field reference 'Post\.meta2' is not supported in JSON write data/;
const UNKNOWN_MODEL_REFUSAL = /Unknown model "Nope"/;
const UNKNOWN_FIELD_REFUSAL = /Unknown scalar field "nope"/;

beforeAll(() => hydrateSchemaNames(schema));

const fields = () => createSchemaFieldRefs(schema);

type Refusal = { name?: string; issues?: { path?: string }[] };

/** Runs `build`, requiring it to throw, and hands back the thrown refusal. */
function refusalOf(build: () => unknown): Refusal {
  try {
    build();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error("expected the build to be refused, but it succeeded");
}

/** `{ not: { not: … { <leaf> } } }`, `depth` levels of `not` deep. */
function nestNot(depth: number, leaf: Record<string, unknown>) {
  let out: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i++) out = { not: out };
  return out;
}

const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

type DialectCase = {
  name: string;
  dialect: Dialect;
  quote: '"' | "`";
  createAdapter: () => DatabaseAdapter;
  /** The dialect's case-SENSITIVE text wrapper, spelled as it lands in SQL. */
  exactText: (expr: string) => string;
  /** The dialect's ASCII A-Z fold, spelled as it lands in SQL. */
  asciiFold: (expr: string) => string;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    quote: '"',
    createAdapter: () => new PostgresAdapter(),
    // Postgres needs no wrapper: `=` on text is already byte-exact there.
    exactText: (expr) => expr,
    asciiFold: (expr) =>
      `TRANSLATE(${expr}, '${ASCII_UPPERCASE}', '${ASCII_LOWERCASE}')`,
  },
  {
    name: "MySQL",
    dialect: "mysql",
    quote: "`",
    createAdapter: () => new MySQLAdapter(),
    exactText: (expr) => `BINARY ${expr}`,
    asciiFold: (expr) => {
      let folded = expr;
      for (let i = 0; i < ASCII_UPPERCASE.length; i++) {
        folded = `REPLACE(${folded}, '${ASCII_UPPERCASE[i]}', '${ASCII_LOWERCASE[i]}')`;
      }
      return folded;
    },
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    quote: '"',
    createAdapter: () => new SQLiteAdapter(),
    exactText: (expr) => `${expr} COLLATE BINARY`,
    asciiFold: (expr) => `lower(${expr})`,
  },
];

function createEngine(dialectCase: DialectCase): QueryEngine {
  const adapter = dialectCase.createAdapter();
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return new QueryEngine(
    new MockDriver(adapter, dialectCase.dialect),
    registry
  );
}

function buildPostQuery(
  dialectCase: DialectCase,
  args: Record<string, unknown>
): { statement: string; values: unknown[] } {
  const query = createEngine(dialectCase).build(Post, "findMany", args);
  return { statement: query.toStatement("$n"), values: query.values };
}

describe.each(dialectCases)("$name field-reference SQL", (dialectCase) => {
  const q = (identifier: string) =>
    `${dialectCase.quote}${identifier}${dialectCase.quote}`;

  test("a reference becomes a qualified column, not a bound parameter", () => {
    const query = buildPostQuery(dialectCase, {
      where: { views: { gt: fields().Post.likes } },
    });

    // The referenced column is emitted under the SAME alias as the filtered
    // one — that is what makes it a same-row comparison.
    const alias = query.statement.match(
      new RegExp(
        `${q("fieldref_sql_posts")} AS (${dialectCase.quote}\\w+${dialectCase.quote})`
      )
    )?.[1];
    expect(alias).toBeDefined();
    expect(query.statement).toContain(`${alias}.${q("views")}`);
    expect(query.statement).toContain(`${alias}.${q("like_count")}`);
    // Nothing was bound for the operand.
    expect(query.values).toHaveLength(0);
  });

  test("the reference resolves through .map(), not the field key", () => {
    const query = buildPostQuery(dialectCase, {
      where: { views: { equals: fields().Post.likes } },
    });
    // Only the predicate matters: the SELECT list legitimately aliases the
    // mapped column back to the field key (`"like_count" AS "likes"`).
    const predicate = query.statement.slice(query.statement.indexOf("WHERE"));
    expect(predicate).toContain(q("like_count"));
    expect(predicate).not.toContain(q("likes"));
  });

  test("a literal beside a reference is still bound", () => {
    const query = buildPostQuery(dialectCase, {
      where: { views: { gt: fields().Post.likes, lt: 500 } },
    });
    expect(query.values).toEqual([500]);
    expect(query.statement).toContain(q("like_count"));
  });

  test("a nested relation where resolves the reference on the relation's alias", () => {
    const query = createEngine(dialectCase).build(User, "findMany", {
      where: { posts: { some: { views: { gt: fields().Post.likes } } } },
    });
    const statement = query.toStatement("$n");
    // Both operands sit inside the correlated subquery over posts.
    const subquery = statement.slice(statement.indexOf("EXISTS"));
    expect(subquery).toContain(q("views"));
    expect(subquery).toContain(q("like_count"));
    expect(query.values).toHaveLength(0);
  });

  /**
   * Collation and case folding on a REFERENCED operand.
   *
   * A column operand has to be wrapped exactly like the literal it replaces, or
   * `mode` means different things on the two sides of the same `=`. These pin
   * the emitted expression on both sides, per dialect, because behaviour cannot
   * see all of it: MySQL's `BINARY` and SQLite's `COLLATE BINARY` govern the
   * WHOLE comparison from either side, so once the left side carries the
   * wrapper no query result can distinguish an operand that also carries it
   * from one that does not. The fold is the opposite — dropping it on the
   * operand really does change which rows come back, and
   * {@link file://../drivers/field-reference-behavior.ts} discriminates that
   * against live databases on every dialect.
   */
  describe("collation and folding of a referenced operand", () => {
    const predicateOf = (args: Record<string, unknown>) => {
      const { statement } = buildPostQuery(dialectCase, args);
      return statement.slice(statement.indexOf("WHERE ") + "WHERE ".length);
    };
    const titleCol = () => `${q("t0")}.${q("title")}`;
    const slugCol = () => `${q("t0")}.${q("slug_col")}`;
    const exact = (expr: string) => dialectCase.exactText(expr);
    const folded = (expr: string) =>
      dialectCase.exactText(dialectCase.asciiFold(expr));

    test("default mode compares both sides under the case-sensitive collation", () => {
      expect(
        predicateOf({ where: { title: { equals: fields().Post.slug } } })
      ).toBe(`${exact(titleCol())} = ${exact(slugCol())}`);
    });

    test("insensitive mode folds AND collates both sides", () => {
      expect(
        predicateOf({
          where: { title: { equals: fields().Post.slug, mode: "insensitive" } },
        })
      ).toBe(`${folded(titleCol())} = ${folded(slugCol())}`);
    });

    test("insensitive `not` negates the folded comparison", () => {
      expect(
        predicateOf({
          where: { title: { not: fields().Post.slug, mode: "insensitive" } },
        })
      ).toBe(`NOT (${folded(titleCol())} = ${folded(slugCol())})`);
    });

    test.each([
      "contains",
      "startsWith",
      "endsWith",
    ])("insensitive %s carries the fold onto the referenced operand", (operator) => {
      const predicate = predicateOf({
        where: {
          title: { [operator]: fields().Post.slug, mode: "insensitive" },
        },
      });
      // The substring/prefix/suffix templates differ per dialect, so assert
      // the two operand expressions rather than the whole predicate.
      expect(predicate).toContain(folded(titleCol()));
      expect(predicate).toContain(folded(slugCol()));
    });

    test("default mode leaves the string predicates unwrapped on both sides", () => {
      // The complement of the case above: in default mode neither side is
      // folded, so a fold appearing here would mean `mode` had leaked.
      const predicate = predicateOf({
        where: { title: { contains: fields().Post.slug } },
      });
      expect(predicate).toContain(titleCol());
      expect(predicate).toContain(slugCol());
      expect(predicate).not.toContain(dialectCase.asciiFold(titleCol()));
    });

    test("a literal operand is folded but not collation-wrapped", () => {
      // Documents the one asymmetry between the literal and reference paths,
      // and why it is inert: a one-sided wrapper already governs the whole
      // comparison in every dialect here, so the extra wrapper the reference
      // path emits cannot change a result — which is exactly why the tests
      // above pin it as SQL and not as behaviour.
      expect(
        predicateOf({
          where: { title: { equals: "x", mode: "insensitive" } },
        })
      ).toBe(`${folded(titleCol())} = ${dialectCase.asciiFold("$1")}`);
    });
  });

  test("a cross-model reference is refused at build time", () => {
    expect(() =>
      buildPostQuery(dialectCase, {
        where: { title: { equals: fields().User.name } },
      })
    ).toThrow(CROSS_MODEL_REFUSAL);
  });

  test("a reference to a scalar of another type is refused by validation", () => {
    expect(() =>
      buildPostQuery(dialectCase, {
        where: { title: { equals: fields().Post.views } },
      })
    ).toThrow(WRONG_TYPE_REFUSAL);
  });

  test("a list-scalar reference is refused", () => {
    expect(() =>
      buildPostQuery(dialectCase, {
        where: { title: { equals: fields().Post.tags } },
      })
    ).toThrow(LIST_REFUSAL);
  });
});

describe("surfaces that stay closed to field references", () => {
  const engine = () => createEngine(dialectCases[0] as DialectCase);

  test("groupBy having refuses a reference (Prisma excludes it too)", () => {
    expect(() =>
      engine().build(Post, "groupBy", {
        by: ["views"],
        having: { views: { gt: fields().Post.likes } },
      })
    ).toThrow(HAVING_REFUSAL);
  });

  /**
   * The `having` closure must hold at EVERY `not` nesting depth. Scalar `not`
   * nests arbitrarily (see `buildNegatableFilterSchema`), so this is a
   * reachable payload, not a hypothetical — and the guard that closes the
   * surface shipped with a four-level cap: a five-deep chain emitted
   * `HAVING NOT (NOT (NOT (NOT ("t0"."views" > "t0"."like_count"))))`, an
   * ungrouped column inside a group predicate, which Postgres rejects and
   * SQLite/LibSQL silently answer with a wrong row. Depths below and above the
   * old cap are both pinned so a re-introduced bound fails here.
   */
  test.each([
    0, 1, 2, 3, 4, 5, 6, 12, 64,
  ])("groupBy having refuses a reference nested %i `not` levels deep", (depth) => {
    expect(() =>
      engine().build(Post, "groupBy", {
        by: ["views"],
        having: { views: nestNot(depth, { gt: fields().Post.likes }) },
      })
    ).toThrow(HAVING_REFUSAL);
  });

  test.each([
    "AND",
    "OR",
    "NOT",
  ])("groupBy having refuses a deeply nested reference under %s", (combinator) => {
    expect(() =>
      engine().build(Post, "groupBy", {
        by: ["views"],
        having: {
          [combinator]: [{ views: nestNot(6, { gt: fields().Post.likes }) }],
        },
      })
    ).toThrow(HAVING_REFUSAL);
  });

  /**
   * The complement of the sweep above: the refusal is scoped to `having`, not a
   * blanket rejection of deep filters. The same chain in `where` still compiles
   * to a same-row column comparison with nothing bound.
   */
  test("the same deep chain is still legal in `where`", () => {
    const query = engine().build(Post, "findMany", {
      where: { views: nestNot(6, { gt: fields().Post.likes }) },
    });
    const statement = query.toStatement("$n");
    expect(statement).toContain('"like_count"');
    expect(statement).toContain("NOT (NOT (NOT (NOT (NOT (NOT (");
    expect(query.values).toHaveLength(0);
  });

  test("having still accepts ordinary scalar and aggregate filters", () => {
    expect(() =>
      engine().build(Post, "groupBy", {
        by: ["views"],
        having: { views: { gt: 3 } },
      })
    ).not.toThrow();
    expect(() =>
      engine().build(Post, "groupBy", {
        by: ["views"],
        having: { views: { _count: { gt: 1 } } },
      })
    ).not.toThrow();
    // …including a deep `not` chain, as long as no reference hides in it: the
    // scan refuses references, not depth.
    expect(() =>
      engine().build(Post, "groupBy", {
        by: ["views"],
        having: { views: nestNot(6, { gt: 3 }) },
      })
    ).not.toThrow();
  });

  test("a reference is refused in set-membership operands", () => {
    expect(() =>
      engine().build(Post, "findMany", {
        where: { views: { in: [fields().Post.likes] } },
      })
    ).toThrow();
  });

  test("a reference is refused in whereUnique", () => {
    expect(() =>
      engine().build(Post, "findUnique", {
        where: { id: fields().Post.title },
      })
    ).toThrow();
  });

  /**
   * The payload is COMPLETE apart from the reference — the first version of
   * this test omitted the required `slug`, so it threw whether or not a
   * reference was there and proved nothing. The complement below is what makes
   * the refusal attributable: swap the token for a literal and the very same
   * payload compiles.
   *
   * Unlike JSON (which must refuse a token deliberately, and does so by name —
   * see the JSON suite below), an `int` column refuses one for free: a
   * reference token is simply not an integer. So the assertion pins the SLOT
   * the refusal is reported against rather than a bespoke message.
   */
  test("a reference is refused in create data", () => {
    const create = (views: unknown) =>
      engine().build(Post, "create", {
        data: {
          id: "p1",
          title: "t",
          slug: "s",
          views,
          likes: 1,
          tags: [],
          authorId: "u1",
        } as never,
      });

    // Otherwise valid: with a literal in that one slot, the payload compiles.
    expect(() => create(1)).not.toThrow();

    const refusal = refusalOf(() => create(fields().Post.likes));
    expect(refusal.name).toBe("ValidationError");
    // …and the refusal is reported against the slot holding the reference.
    expect(refusal.issues?.[0]?.path).toBe("data.views");
  });

  test("a reference is refused in update data", () => {
    expect(() =>
      engine().build(Post, "update", {
        where: { id: "p1" },
        data: { views: { set: fields().Post.likes } },
      })
    ).toThrow();
  });

  test("a reference is refused in orderBy", () => {
    expect(() =>
      engine().build(Post, "findMany", {
        orderBy: { views: fields().Post.likes },
      })
    ).toThrow();
  });
});

/**
 * JSON is the one operand position that accepts an ARBITRARY object, so it is
 * the only place where a reference token is a structurally valid value: to
 * `v.json` the token is just `{ model, field, type, list }`, a perfectly
 * ordinary document. Every other closed surface refuses a reference for free,
 * because a token is not a string/number/date/blob — JSON has to refuse it
 * deliberately, and until it did, the token was silently BOUND as a parameter
 * in filters and silently PERSISTED as user data in create/update.
 *
 * TypeScript rejects all of these spellings, so they are only reachable through
 * an untyped boundary (a dynamic query builder, an HTTP payload) — which is
 * exactly the traffic the runtime parse boundary exists to police, and exactly
 * why `as never` appears below.
 */
describe("JSON operands stay closed to field references", () => {
  const engine = () => createEngine(dialectCases[0] as DialectCase);
  const ref = () => fields().Post.meta2 as never;

  test.each([
    ["equals", () => ({ meta: { equals: ref() } })],
    ["array_contains", () => ({ meta: { array_contains: ref() } })],
    ["array_starts_with", () => ({ meta: { array_starts_with: ref() } })],
    ["array_ends_with", () => ({ meta: { array_ends_with: ref() } })],
    ["equals under a path", () => ({ meta: { path: ["k"], equals: ref() } })],
    ["equals under not", () => ({ meta: { not: { equals: ref() } } })],
    // The scan is exhaustive, not top-level: a token buried inside an
    // otherwise-legal document is the same leak with a longer path to it.
    ["buried inside a document", () => ({ meta: { equals: { a: [ref()] } } })],
  ])("a JSON filter refuses a reference in %s", (_name, where) => {
    expect(() =>
      engine().build(Post, "findMany", { where: where() as never })
    ).toThrow(JSON_FILTER_REFUSAL);
  });

  test.each([
    ["a create data slot", () => ref()],
    ["a create data slot, buried", () => ({ deep: { r: ref() } })],
  ])("JSON write data refuses a reference in %s", (_name, value) => {
    expect(() =>
      engine().build(Post, "create", {
        data: {
          id: "p1",
          title: "t",
          slug: "s",
          views: 1,
          likes: 1,
          tags: [],
          meta: value() as never,
          authorId: "u1",
        },
      })
    ).toThrow(JSON_DATA_REFUSAL);
  });

  test.each([
    ["the shorthand form", () => ref()],
    ["the { set } form", () => ({ set: ref() })],
    ["a buried position", () => ({ deep: [ref()] })],
  ])("JSON update data refuses a reference in %s", (_name, value) => {
    expect(() =>
      engine().build(Post, "update", {
        where: { id: "p1" },
        data: { meta: value() as never },
      })
    ).toThrow(JSON_DATA_REFUSAL);
  });

  /**
   * The complement: the closure refuses TOKENS, not objects. Every ordinary
   * JSON document — including ones whose keys spell a reference's own fields —
   * still compiles, so the guard cannot be satisfied by rejecting JSON wholesale.
   */
  test("ordinary JSON documents still compile in filters and writes", () => {
    const lookalike = { model: "Post", field: "meta2", type: "json" };
    expect(() =>
      engine().build(Post, "findMany", {
        where: { meta: { equals: lookalike } },
      })
    ).not.toThrow();
    expect(() =>
      engine().build(Post, "findMany", {
        where: { meta: { path: ["a", "b"], array_contains: [1, 2] } },
      })
    ).not.toThrow();
    expect(() =>
      engine().build(Post, "create", {
        data: {
          id: "p1",
          title: "t",
          slug: "s",
          views: 1,
          likes: 1,
          tags: [],
          meta: lookalike,
          authorId: "u1",
        },
      })
    ).not.toThrow();
    expect(() =>
      engine().build(Post, "update", {
        where: { id: "p1" },
        data: { meta: { set: lookalike } },
      })
    ).not.toThrow();
  });
});

describe("the $fields surface", () => {
  test("is branded, frozen, and identity-stable per field", () => {
    const refs = createSchemaFieldRefs(schema);
    const first = refs.Post.likes;
    const second = refs.Post.likes;

    expect(isFieldRef(first)).toBe(true);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      model: "Post",
      field: "likes",
      type: "int",
      list: false,
    });
    expect((first as unknown as Record<symbol, unknown>)[FIELD_REF_BRAND]).toBe(
      true
    );
  });

  test("names an unknown model or field loudly", () => {
    const refs = createSchemaFieldRefs(schema);
    expect(() => (refs as Record<string, unknown>).Nope).toThrow(
      UNKNOWN_MODEL_REFUSAL
    );
    expect(
      () => (refs.Post as unknown as Record<string, unknown>).nope
    ).toThrow(UNKNOWN_FIELD_REFUSAL);
  });

  test("walks nothing until a field is actually read", () => {
    // A getter on the schema record would fire during any eager walk of the
    // models; a getter on the model's scalars would fire during any eager walk
    // of its fields. Neither may fire just from building the surface.
    let modelReads = 0;
    const probeSchema = {} as { Post: typeof Post };
    Object.defineProperty(probeSchema, "Post", {
      enumerable: true,
      get() {
        modelReads++;
        return Post;
      },
    });

    const refs = createSchemaFieldRefs(probeSchema);
    expect(modelReads).toBe(0);

    const postRefs = refs.Post;
    expect(modelReads).toBe(1);

    // Second touch of the same model reuses the memoized table.
    expect(refs.Post).toBe(postRefs);
    expect(modelReads).toBe(1);

    expect(postRefs.likes.field).toBe("likes");
  });

  test("client construction does not build the surface", () => {
    const client = createClient({
      schema,
      driver: new MockDriver(new PostgresAdapter(), "postgresql"),
    });
    // Accessing it twice returns the same memoized proxy — proof it is built
    // on demand and then cached, not rebuilt per access.
    expect(client.$fields).toBe(client.$fields);
    expect(client.$fields.Post.likes.model).toBe("Post");
  });
});

describe("field-reference typing", () => {
  const typedClient = () =>
    createClient({
      schema,
      driver: new MockDriver(new PostgresAdapter(), "postgresql"),
    });

  test("an Int reference is not assignable to a String filter operand", () => {
    const client = typedClient();

    // Same-type operand: accepted.
    const ok = client.Post.findMany({
      where: { views: { gt: client.$fields.Post.likes } },
    });

    const bad = client.Post.findMany({
      where: {
        title: {
          // @ts-expect-error an int reference cannot stand in for a string operand
          equals: client.$fields.Post.views,
        },
      },
    });

    expect(ok).toBeDefined();
    expect(bad).toBeDefined();
  });

  test("$fields exposes scalar fields only, typed per model", () => {
    const refs = createSchemaFieldRefs(schema);
    const likes: FieldRef<"Post", "int"> = refs.Post.likes;
    const name: FieldRef<"User", "string"> = refs.User.name;

    // Relations are absent from the surface — asserted at the type level so no
    // runtime access is needed (reading one throws).
    const relationIsAbsent: "author" extends keyof typeof refs.Post
      ? false
      : true = true;

    // @ts-expect-error the owning model is part of the reference's type
    const misattributed: FieldRef<"User", "int"> = refs.Post.likes;

    expect(likes.model).toBe("Post");
    expect(name.model).toBe("User");
    expect(relationIsAbsent).toBe(true);
    expect(misattributed.model).toBe("Post");
  });
});
