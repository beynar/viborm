import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema";
import { createModelFieldRefs, isFieldRef } from "@schema/field-ref";
import { sql } from "@sql";
import { createSchemaRegistry } from "@validation";
import type { OperandCtx } from "@validation/primitives/operand";
import { beforeAll, describe, expect, test } from "vitest";
import { createModelFieldRefs as rootCreateModelFieldRefs } from "../../src/index";
import { fieldRefSchema } from "../fixtures/field-ref-schema";

/**
 * Per-field operand callbacks (W8-A) and SQL fragments as filter operands.
 *
 * Three claims live here, none of which a live database can show:
 *
 *  - the callback is resolved DURING VALIDATION, so the callback form and the
 *    direct-token form compile to byte-identical SQL and the engine never sees
 *    a function;
 *  - a fragment operand is spliced PARENTHESIZED with its interpolations still
 *    BOUND — the injection witness reads the compiled statement to prove it;
 *  - `ctx.fields` is scoped to the model being filtered at every depth, and the
 *    surfaces that stay closed to a reference stay closed to a fragment too.
 *
 * Behaviour against real databases lives in
 * {@link file://../drivers/field-reference-behavior.ts}.
 */

const schema = fieldRefSchema;
const { post: Post, user: User } = schema;

/** The operand callback context of each model — `ctx.fields` keyed to it. */
type PostCtx = OperandCtx<typeof Post>;
type UserCtx = OperandCtx<typeof User>;

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `operand-callback-${dialect}`);
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

beforeAll(() => hydrateSchemaNames(schema));

const tokens = {
  post: createModelFieldRefs("post", schema.post),
  user: createModelFieldRefs("user", schema.user),
};

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

type Compiled = { statement: string; values: unknown[] };

function build(
  dialectCase: DialectCase,
  model: typeof Post | typeof User,
  operation: string,
  args: Record<string, unknown>
): Compiled {
  const query = createEngine(dialectCase).build(
    model as never,
    operation as never,
    args
  );
  return { statement: query.toStatement("$n"), values: query.values };
}

const buildPost = (dialectCase: DialectCase, args: Record<string, unknown>) =>
  build(dialectCase, Post, "findMany", args);

type Refusal = {
  name?: string;
  issues?: { path?: string; message?: string }[];
};

/** Runs `run`, requiring it to throw, and hands back the thrown refusal. */
function refusalOf(run: () => unknown): Refusal {
  try {
    run();
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

describe.each(dialectCases)("$name operand callbacks", (dialectCase) => {
  const q = (identifier: string) =>
    `${dialectCase.quote}${identifier}${dialectCase.quote}`;

  test("the callback form and the token form compile identically", () => {
    const viaCallback = buildPost(dialectCase, {
      where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    const viaToken = buildPost(dialectCase, {
      where: { views: { gt: tokens.post.likes } },
    });

    expect(viaCallback.statement).toBe(viaToken.statement);
    expect(viaCallback.values).toEqual(viaToken.values);
    // …and it really is the referenced COLUMN, not a bound token.
    expect(viaCallback.statement).toContain(q("likes"));
    expect(viaCallback.values).toHaveLength(0);
  });

  test("every comparison operator takes the callback", () => {
    for (const operator of ["equals", "not", "lt", "lte", "gt", "gte"]) {
      const viaCallback = buildPost(dialectCase, {
        where: { views: { [operator]: (ctx: PostCtx) => ctx.fields.likes } },
      });
      const viaToken = buildPost(dialectCase, {
        where: { views: { [operator]: tokens.post.likes } },
      });
      expect(viaCallback.statement).toBe(viaToken.statement);
    }
  });

  test("the bare shorthand takes the callback too", () => {
    const viaCallback = buildPost(dialectCase, {
      where: { views: (ctx: PostCtx) => ctx.fields.likes },
    });
    const viaToken = buildPost(dialectCase, {
      where: { views: tokens.post.likes },
    });
    expect(viaCallback.statement).toBe(viaToken.statement);
  });

  test("the callback resolves through .map(), like the token", () => {
    const query = buildPost(dialectCase, {
      where: { title: { equals: (ctx: PostCtx) => ctx.fields.slug } },
    });
    const predicate = query.statement.slice(query.statement.indexOf("WHERE"));
    expect(predicate).toContain(q("slug_column"));
    expect(predicate).not.toContain(q("slug"));
  });

  test("a fragment operand is spliced parenthesized, its values bound", () => {
    const query = buildPost(dialectCase, {
      where: { views: { gt: (ctx: PostCtx) => ctx.sql`${10} + ${20}` } },
    });

    // THE INJECTION WITNESS: the interpolated values are placeholders in the
    // compiled statement and parameters beside it — never concatenated text.
    expect(query.values).toEqual([10, 20]);
    expect(query.statement).toContain("($1 + $2)");
    expect(query.statement).not.toContain("10 + 20");
  });

  test("a fragment operand that carries a hostile string stays a parameter", () => {
    const hostile = "'); DROP TABLE fieldref_posts; --";
    const query = buildPost(dialectCase, {
      where: { title: { equals: (ctx: PostCtx) => ctx.sql`${hostile}` } },
    });
    expect(query.values).toEqual([hostile]);
    expect(query.statement).not.toContain("DROP TABLE");
  });

  test("a fragment, a reference and a literal mix in one where", () => {
    const query = buildPost(dialectCase, {
      where: {
        views: {
          gt: (ctx: PostCtx) => ctx.fields.likes,
          lt: (ctx: PostCtx) => ctx.sql`${1000} - ${1}`,
          gte: 0,
        },
      },
    });
    expect(query.statement).toContain(q("likes"));
    expect(query.statement).toContain("($1 - $2)");
    expect(query.values).toEqual([1000, 1, 0]);
  });

  test("a bare Sql fragment is accepted without the callback", () => {
    const viaCallback = buildPost(dialectCase, {
      where: { views: { gt: (ctx: PostCtx) => ctx.sql`${7}` } },
    });
    const viaValue = buildPost(dialectCase, {
      where: { views: { gt: sql`${7}` } },
    });
    expect(viaCallback.statement).toBe(viaValue.statement);
    expect(viaCallback.values).toEqual(viaValue.values);
  });

  test("a subquery fragment compiles as an operand", () => {
    const query = buildPost(dialectCase, {
      where: {
        views: {
          gt: (ctx: PostCtx) =>
            ctx.sql`SELECT MAX(v) FROM (SELECT ${5} AS v) AS m`,
        },
      },
    });
    expect(query.statement).toContain("(SELECT MAX(v) FROM");
    expect(query.values).toEqual([5]);
  });

  test("`ctx.fields` at depth 2 names the nested model's columns", () => {
    const viaCallback = build(dialectCase, User, "findMany", {
      where: {
        posts: { some: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } } },
      },
    });
    const viaToken = build(dialectCase, User, "findMany", {
      where: { posts: { some: { views: { gt: tokens.post.likes } } } },
    });
    expect(viaCallback.statement).toBe(viaToken.statement);

    // Both operands sit inside the correlated subquery over posts.
    const subquery = viaCallback.statement.slice(
      viaCallback.statement.indexOf("EXISTS")
    );
    expect(subquery).toContain(q("views"));
    expect(subquery).toContain(q("likes"));
  });

  test("a nested `ctx.fields` cannot reach the enclosing model's columns", () => {
    // `nickname` is a column of user, the model being filtered at the ROOT.
    // Inside `posts.some` the scope is post, and post has no such column — the
    // type level says so first (the `@ts-expect-error` below IS the assertion),
    // and the runtime says the same thing to an untyped caller.
    const refusal = refusalOf(() =>
      build(dialectCase, User, "findMany", {
        where: {
          posts: {
            some: {
              title: {
                // @ts-expect-error post has no `nickname` — the nested ctx is post's
                equals: (ctx: PostCtx) => ctx.fields.nickname,
              },
            },
          },
        },
      })
    );
    expect(refusal.name).toBe("ValidationError");
    expect(refusal.issues?.[0]?.message).toContain(
      `Unknown scalar field "nickname" on model 'post'`
    );
  });

  test("the scope pops back out of a nested relation filter", () => {
    // Root operand AFTER a nested relation filter: if the nested scope leaked,
    // `nickname` would no longer resolve here.
    const query = build(dialectCase, User, "findMany", {
      where: {
        posts: { some: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } } },
        name: { equals: (ctx: UserCtx) => ctx.fields.nickname },
      },
    });
    expect(query.statement).toContain(q("nickname"));
    expect(query.statement).toContain(q("likes"));
  });

  test("an extended unique where takes a callback in its filter portion", () => {
    const viaCallback = build(dialectCase, Post, "findUnique", {
      where: { id: "p1", views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
    });
    const viaToken = build(dialectCase, Post, "findUnique", {
      where: { id: "p1", views: { gt: tokens.post.likes } },
    });
    expect(viaCallback.statement).toBe(viaToken.statement);
    expect(viaCallback.values).toEqual(["p1"]);
  });
});

describe("what a callback may return", () => {
  const dialectCase = dialectCases[0]!;

  test("a plain value is refused, naming the operation and the path", () => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, { where: { views: { gt: () => 42 } } })
    );
    expect(refusal.name).toBe("ValidationError");
    const [issue] = refusal.issues ?? [];
    // The scalar filter is a union (shorthand value | filter object), and a
    // union reports at the key it was handed — `where.views` — with each arm's
    // message inside. That is the existing shape for every filter refusal on
    // this branch (a wrong-typed reference reads the same way).
    expect(issue?.path).toBe("where.views");
    expect(issue?.message).toContain("must return a field reference");
    expect(issue?.message).toContain("'number'");
  });

  test("an async callback is refused as a promise, not awaited", () => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: { views: { gt: async (ctx: PostCtx) => ctx.fields.likes } },
      })
    );
    expect(refusal.issues?.[0]?.message).toContain("returned a promise");
    expect(refusal.issues?.[0]?.message).toContain("cannot be async");
  });

  test("a throwing callback surfaces as a validation issue at its path", () => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: {
          views: {
            gt: () => {
              throw new Error("boom");
            },
          },
        },
      })
    );
    expect(refusal.name).toBe("ValidationError");
    expect(refusal.issues?.[0]?.path).toBe("where.views");
    expect(refusal.issues?.[0]?.message).toContain(
      "Filter callback threw: boom"
    );
  });

  test("a mistyped `ctx.fields` key throws, naming the field and the model", () => {
    // THE TYPO PROBE: the `@ts-expect-error` is the primary assertion — a
    // mistyped field is a compile error through the public surface. The runtime
    // refusal below is what an untyped caller gets.
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: {
          views: {
            // @ts-expect-error `likez` is not a scalar of post
            gt: (ctx: PostCtx) => ctx.fields.likez,
          },
        },
      })
    );
    expect(refusal.issues?.[0]?.message).toContain(
      'Unknown scalar field "likez"'
    );
    expect(refusal.issues?.[0]?.message).toContain("likes");
  });

  test("a reference of the wrong scalar type is refused", () => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: { title: { equals: (ctx: PostCtx) => ctx.fields.views } },
      })
    );
    expect(refusal.issues?.[0]?.message).toContain(
      "is of type 'int', but a 'string' operand is required"
    );
  });

  test("another model's token, smuggled in, is still refused", () => {
    // The callback is sugar; the token is the mechanism, so a token captured
    // from a DIFFERENT model still has to meet the same-model rule.
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: { title: { equals: () => tokens.user.name } },
      })
    );
    expect(refusal.name).toBe("QueryEngineError");
    expect(String((refusal as unknown as Error).message)).toContain(
      "may only compare columns of the same model"
    );
  });
});

describe("surfaces that stay closed", () => {
  const dialectCase = dialectCases[0]!;

  test("`in` takes values, not fragments", () => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: { views: { in: [sql`1`] } },
      })
    );
    expect(refusal.name).toBe("ValidationError");
  });

  test("a fragment is refused in `having`", () => {
    const refusal = refusalOf(() =>
      build(dialectCase, Post, "groupBy", {
        by: ["authorId"],
        having: { views: { gt: sql`${1}` } },
      })
    );
    expect(refusal.name).toBe("ValidationError");
    expect(JSON.stringify(refusal.issues)).toContain(
      "An SQL fragment is not supported in 'having'"
    );
  });

  test("a fragment is refused in `having` at any `not` depth", () => {
    // The depth-cap bug the W2 review found, re-run for the fragment: a guard
    // that stops looking would emit the fragment into HAVING, where Postgres
    // errors and SQLite answers a silently different question.
    for (const depth of [1, 3, 5, 8]) {
      const refusal = refusalOf(() =>
        build(dialectCase, Post, "groupBy", {
          by: ["authorId"],
          having: { views: nestNot(depth, { gt: sql`${1}` }) },
        })
      );
      expect(JSON.stringify(refusal.issues)).toContain(
        "An SQL fragment is not supported in 'having'"
      );
    }
  });

  test("a callback cannot smuggle a fragment into `having` either", () => {
    const refusal = refusalOf(() =>
      build(dialectCase, Post, "groupBy", {
        by: ["authorId"],
        having: { views: { gt: (ctx: PostCtx) => ctx.sql`${1}` } },
      })
    );
    expect(JSON.stringify(refusal.issues)).toContain(
      "An SQL fragment is not supported in 'having'"
    );
  });

  /**
   * JSON needs no fragment-specific guard, and deliberately does not get one.
   *
   * A real `Sql` is a class instance, and `v.json` already refuses any value
   * whose prototype is not `Object.prototype`. Adding a STRUCTURAL fragment
   * check here would be worse than useless: `isSql` recognizes a fragment by
   * the presence of `strings` and `values` arrays, and a JSON document may
   * honestly have both — that document must keep working.
   */
  test("a fragment is refused in a JSON filter operand, as non-JSON", () => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: { payload: { equals: sql`'{}'` } },
      })
    );
    expect(refusal.name).toBe("ValidationError");
    expect(JSON.stringify(refusal.issues)).toContain(
      "Expected JSON-compatible value"
    );
  });

  test("a fragment is refused in JSON write data, as non-JSON", () => {
    const refusal = refusalOf(() =>
      build(dialectCase, Post, "updateMany", {
        where: { id: "p1" },
        data: { payload: { set: sql`'{}'` } },
      })
    );
    expect(refusal.name).toBe("ValidationError");
    expect(JSON.stringify(refusal.issues)).toContain(
      "Expected JSON-compatible value"
    );
  });

  test("a JSON document that looks like a fragment still writes", () => {
    // `{ strings: [...], values: [...] }` is what `isSql` recognizes
    // structurally — and it is also perfectly ordinary user data.
    expect(() =>
      build(dialectCase, Post, "updateMany", {
        where: { id: "p1" },
        data: { payload: { set: { strings: ["a"], values: [1] } } },
      })
    ).not.toThrow();
  });

  test("a JSON document that looks like a fragment FILTERS as a value", () => {
    // The read-side half of the pair above, and the one that would bite: if a
    // JSON operand ever reached the fragment splice, this document's `strings`
    // would land in the statement as TEXT instead of being bound. JSON filters
    // are dispatched to the JSON filter language before the operand path is
    // reached, so the document stays a parameter — read the statement, not the
    // absence of a throw.
    const query = buildPost(dialectCase, {
      where: {
        payload: { equals: { strings: ["INJECTED_TEXT"], values: [] } },
      },
    });
    expect(query.statement).not.toContain("INJECTED_TEXT");
    expect(JSON.stringify(query.values)).toContain("INJECTED_TEXT");
  });

  test("write data takes no callback", () => {
    const refusal = refusalOf(() =>
      build(dialectCase, Post, "updateMany", {
        where: { id: "p1" },
        data: { views: { set: (ctx: PostCtx) => ctx.fields.likes } },
      })
    );
    expect(refusal.name).toBe("ValidationError");
  });

  test("a text predicate keeps the token but takes no fragment", () => {
    // `contains` compiles a referenced column; the fragment surface is drawn at
    // the comparison operators only.
    expect(() =>
      buildPost(dialectCase, {
        where: { title: { contains: tokens.post.slug } },
      })
    ).not.toThrow();

    const refusal = refusalOf(() =>
      buildPost(dialectCase, {
        where: { title: { contains: sql`'x'` } },
      })
    );
    expect(refusal.name).toBe("ValidationError");
  });
});

/**
 * The documented escape route to a token, executed.
 *
 * The filtering page teaches `import { createModelFieldRefs } from "viborm"` as the way
 * to hold a token without a callback — and with `client.$fields` removed (D-8) it is the
 * ONLY way. That makes the package ENTRY POINT part of the contract: importing it from
 * `@schema/field-ref`, as every test above does, would keep passing while the published
 * example failed to resolve. So this one goes through `src/index` on purpose.
 */
describe("the public entry point", () => {
  test("exports the token factory the docs teach, and it filters", () => {
    expect(typeof rootCreateModelFieldRefs).toBe("function");
    const postFields = rootCreateModelFieldRefs("post", Post);
    const query = build(dialectCases[0]!, Post, "findMany", {
      where: { views: { gt: postFields.likes } },
    });
    expect(query.statement).toContain('"likes"');
  });
});

/**
 * The scope reaches every filter position, and stops at every non-filter one.
 *
 * The model a callback resolves against is pushed by the `where` schema that
 * contains it, so the claim "`ctx.fields` is the model being filtered" is only
 * as good as the set of positions that actually push. The block above walks the
 * ones a top-level `where` reaches; these are the OTHER doors into a filter —
 * a nested write's own `where`, a relation `where` under `include`, one under
 * `_count`, and the aggregate families — each of which reaches a `where` by a
 * different route and could have been missed one at a time.
 *
 * The refusals at the end are the complement: a selector that is not a filter
 * (`cursor`, a nested `connect`) and an `orderBy` take no callback, so a typo'd
 * one cannot be quietly accepted and dropped.
 */
describe("every filter position the scope has to reach", () => {
  const dialectCase = dialectCases[0]!;
  const parseArgs = (
    model: "post" | "user",
    operation: string,
    args: Record<string, unknown>
  ) =>
    createSchemaRegistry(schema).validate(
      model,
      operation as never,
      args
    ) as Record<string, any>;

  test("a nested write's own `where` scopes to the relation TARGET", () => {
    const parsed = parseArgs("user", "update", {
      where: { id: "u1" },
      data: {
        posts: {
          updateMany: {
            where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
            data: { views: 5 },
          },
          deleteMany: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
        },
      },
    });
    const updateMany = parsed.data.posts.updateMany;
    const deleteMany = parsed.data.posts.deleteMany;
    const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
    for (const operand of [
      first(updateMany).where.views.gt,
      first(deleteMany).views.gt,
    ]) {
      expect(isFieldRef(operand)).toBe(true);
      expect(operand.model).toBe("post");
      expect(operand.field).toBe("likes");
    }
  });

  test("a nested write's `where` cannot reach the PARENT's columns", () => {
    const refusal = refusalOf(() =>
      parseArgs("user", "update", {
        where: { id: "u1" },
        data: {
          posts: {
            updateMany: {
              where: {
                views: {
                  // @ts-expect-error post has no `nickname` — the scope is post's
                  gt: (ctx: PostCtx) => ctx.fields.nickname,
                },
              },
              data: { views: 5 },
            },
          },
        },
      })
    );
    expect(refusal.name).toBe("ValidationError");
    expect(JSON.stringify(refusal.issues)).toContain("nickname");
  });

  test("a relation `where` under `include` and under `_count` both scope", () => {
    const included = build(dialectCase, User, "findMany", {
      include: {
        posts: { where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } } },
      },
    });
    expect(included.statement).toContain('"likes"');

    const counted = build(dialectCase, User, "findMany", {
      select: {
        id: true,
        _count: {
          select: {
            posts: {
              where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
            },
          },
        },
      },
    });
    expect(counted.statement).toContain('"likes"');
  });

  test("the aggregate families take the callback in their `where`", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["count", {}],
      ["aggregate", { _count: true }],
      ["groupBy", { by: ["status"] }],
    ];
    for (const [operation, extra] of cases) {
      const query = build(dialectCase, Post, operation, {
        ...extra,
        where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
      });
      expect(query.statement, operation).toContain('"likes"');
    }
  });

  test("a selector that is not a filter takes no callback", () => {
    // `cursor` and a nested `connect` are strict unique selectors: they name a
    // ROW, not a comparison, so there is no operand position to open.
    //
    // RUNTIME is what these assert, and only that: `build()` takes the payload
    // as `Record<string, unknown>`, so no `@ts-expect-error` here would fire
    // whatever the public types say. The compile-time half of the same claim is
    // asserted through the client in "operand typing" below.
    const cursorRefusal = refusalOf(() =>
      buildPost(dialectCase, {
        cursor: { id: (ctx: PostCtx) => ctx.fields.title },
      })
    );
    expect(cursorRefusal.name).toBe("ValidationError");

    const connectRefusal = refusalOf(() =>
      parseArgs("user", "update", {
        where: { id: "u1" },
        data: {
          posts: { connect: { id: (ctx: PostCtx) => ctx.fields.title } },
        },
      })
    );
    expect(connectRefusal.name).toBe("ValidationError");

    const orderByRefusal = refusalOf(() =>
      buildPost(dialectCase, {
        orderBy: { views: (ctx: PostCtx) => ctx.fields.likes },
      })
    );
    expect(orderByRefusal.name).toBe("ValidationError");
  });
});

/**
 * The type-level half, probed through the PUBLIC client surface — the only
 * place a claim about the surface can honestly be made.
 *
 * Each `@ts-expect-error` IS the assertion; the runtime expectations exist only
 * so the calls are evaluated.
 */
describe("operand typing", () => {
  const typedClient = () =>
    createClient({
      schema,
      driver: new MockDriver(new PostgresAdapter(), "postgresql"),
    });

  test("`ctx` is inferred — the model in scope needs no annotation", () => {
    const client = typedClient();
    const ok = client.post.findMany({
      where: { views: { gt: (ctx) => ctx.fields.likes } },
    });
    expect(ok).toBeDefined();
  });

  test("a mistyped `ctx.fields` key is a compile error", () => {
    const client = typedClient();
    const bad = client.post.findMany({
      where: {
        views: {
          // @ts-expect-error `likez` is not a scalar of post
          gt: (ctx) => ctx.fields.likez,
        },
      },
    });
    expect(bad).toBeDefined();
  });

  test("the callback's return carries the operand's scalar type", () => {
    const client = typedClient();
    const bad = client.post.findMany({
      where: {
        title: {
          // @ts-expect-error an int reference is not a string operand
          equals: (ctx) => ctx.fields.views,
        },
      },
    });
    expect(bad).toBeDefined();
  });

  test("a nested `ctx` is the target model's, at the type level", () => {
    const client = typedClient();
    const bad = client.user.findMany({
      where: {
        posts: {
          some: {
            title: {
              // @ts-expect-error inside `posts.some` the ctx is post, which has no `nickname`
              equals: (ctx) => ctx.fields.nickname,
            },
          },
        },
      },
    });
    expect(bad).toBeDefined();
  });

  /**
   * The operand union did not leak into the neighbouring keys.
   *
   * `comparisonOperand` is attached in the scalar filter schemas and nowhere
   * else, so a `cursor` (which names a ROW) and an `orderBy` (which names a
   * DIRECTION) should still refuse a callback at COMPILE time — the runtime
   * refusals pinned above go through the untyped engine builder, so they cannot
   * say this. Each `@ts-expect-error` is the assertion; if a future widening
   * lets a function into either position, its directive goes unused and
   * `pnpm test:types` fails. (The two sit at different depths because that is
   * where TypeScript reports each: the cursor key is checked against its own
   * scalar type, while the `orderBy` object mismatches as a whole.)
   */
  test("a callback is a compile error in `cursor` and in `orderBy`", () => {
    const client = typedClient();
    const badCursor = client.post.findMany({
      cursor: {
        // @ts-expect-error a cursor names a row: it takes a value, not a callback
        id: (ctx: PostCtx) => ctx.fields.title,
      },
    });
    const badOrderBy = client.post.findMany({
      // @ts-expect-error orderBy takes a sort direction, not a callback
      orderBy: { views: (ctx: PostCtx) => ctx.fields.likes },
    });
    expect(badCursor).toBeDefined();
    expect(badOrderBy).toBeDefined();
  });
});

/**
 * PRE-EXISTING GAP, measured rather than assumed: `where` gets no
 * excess-property checking, so an unknown operator or field key is not a
 * compile error. This is NOT something the operand union introduced — the
 * plain-value form below behaves identically, and did before W8-A.
 *
 * What this pins is the property that matters and that W8-A must not break:
 * whatever the type level lets through, the strict object schemas still refuse
 * at runtime, IDENTICALLY beside a callback, beside a fragment and beside a
 * value. If the type level is tightened later, these still pass; if a future
 * change makes one of the three spellings silently accept an unknown key while
 * the others refuse it, this fails.
 */
describe("an unknown key is refused the same way beside every operand kind", () => {
  const dialectCase = dialectCases[0]!;

  const unknownOperator = (operand: unknown) => ({
    where: { views: { gt: operand, ltt: 100 } },
  });
  const unknownField = (operand: unknown) => ({
    where: { views: { gt: operand }, viewz: 1 },
  });

  const operands: [string, unknown][] = [
    ["a value", 1],
    ["a token", tokens.post.likes],
    ["a fragment", sql`${1}`],
    ["a callback", (ctx: PostCtx) => ctx.fields.likes],
  ];

  test.each(operands)("unknown operator beside %s", (_name, operand) => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, unknownOperator(operand))
    );
    expect(refusal.name).toBe("ValidationError");
    expect(JSON.stringify(refusal.issues)).toContain("Unknown key: ltt");
  });

  test.each(operands)("unknown field beside %s", (_name, operand) => {
    const refusal = refusalOf(() =>
      buildPost(dialectCase, unknownField(operand))
    );
    expect(refusal.name).toBe("ValidationError");
    expect(JSON.stringify(refusal.issues)).toContain("Unknown key: viewz");
  });
});
