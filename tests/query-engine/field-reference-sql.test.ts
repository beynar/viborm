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

/** `{ not: { not: … { <leaf> } } }`, `depth` levels of `not` deep. */
function nestNot(depth: number, leaf: Record<string, unknown>) {
  let out: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i++) out = { not: out };
  return out;
}

type DialectCase = {
  name: string;
  dialect: Dialect;
  quote: '"' | "`";
  createAdapter: () => DatabaseAdapter;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    quote: '"',
    createAdapter: () => new PostgresAdapter(),
  },
  {
    name: "MySQL",
    dialect: "mysql",
    quote: "`",
    createAdapter: () => new MySQLAdapter(),
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    quote: '"',
    createAdapter: () => new SQLiteAdapter(),
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
  test.each([0, 1, 2, 3, 4, 5, 6, 12, 64])(
    "groupBy having refuses a reference nested %i `not` levels deep",
    (depth) => {
      expect(() =>
        engine().build(Post, "groupBy", {
          by: ["views"],
          having: { views: nestNot(depth, { gt: fields().Post.likes }) },
        })
      ).toThrow(HAVING_REFUSAL);
    }
  );

  test.each(["AND", "OR", "NOT"])(
    "groupBy having refuses a deeply nested reference under %s",
    (combinator) => {
      expect(() =>
        engine().build(Post, "groupBy", {
          by: ["views"],
          having: {
            [combinator]: [{ views: nestNot(6, { gt: fields().Post.likes }) }],
          },
        })
      ).toThrow(HAVING_REFUSAL);
    }
  );

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

  test("a reference is refused in create data", () => {
    expect(() =>
      engine().build(Post, "create", {
        data: {
          id: "p1",
          title: "t",
          views: fields().Post.likes,
          likes: 1,
          tags: [],
          authorId: "u1",
        },
      })
    ).toThrow();
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
