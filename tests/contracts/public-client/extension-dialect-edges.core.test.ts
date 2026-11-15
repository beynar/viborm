/**
 * Extension paths a SQLite suite does not reach, over a driver that sends
 * nothing (`tests/fixtures/drivers/scripted.ts`): the PostgreSQL row lock a
 * kept delete takes, a rule's argument tested by an operator with no operand
 * form, and read-gated fields where the gate is the layer's read or the
 * provider's document is malformed. Each statement golden pins what a
 * PostgreSQL database receives; the live suites name what it does there.
 */

import {
  arg,
  args,
  check,
  createClient,
  extension,
  fields,
  gate,
  oneOf,
  only,
  QueryError,
  rule,
  s,
} from "@src/index";
import { on } from "@src/on";
import { softDelete } from "@src/soft-delete";
import {
  ScriptedDriver,
  type SentStatement,
} from "@tests/fixtures/drivers/scripted";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  tags: s.string().array(),
  deletedAt: s.dateTime().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  comments: s.toMany(() => comment),
});
/** A comment restricts its post's delete. */
const comment = s.model({
  id: s.string().id(),
  postId: s.string(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id")
    .onDelete("restrict"),
});
const schema = { user, post, comment };

type Row = Readonly<Record<string, unknown>>;
type Answer =
  | readonly Row[]
  | { readonly rows: readonly Row[]; readonly rowCount: number };

/** A PostgreSQL client whose n-th statement gets the n-th answer. */
function scripted(answers: readonly Answer[]) {
  const driver = new ScriptedDriver(
    "postgresql",
    (_, sent) => answers[sent.length - 1] ?? []
  );
  return { base: createClient({ schema, driver }), sent: driver.sent };
}

/** The statements, as a golden holds them: text, then parameters. */
const transcript = (sent: readonly SentStatement[]) =>
  `${sent.map(({ sql, params }) => `${sql};\n-- ${JSON.stringify(params)}`).join("\n\n")}\n`;

/** What a call rejects with (an error carries the instant it was made). */
const failureOf = (call: PromiseLike<unknown>) =>
  Promise.resolve(call).then(
    () => undefined,
    (caught: unknown) => caught
  );

describe("kept rows on PostgreSQL", () => {
  test("a soft delete of many rows a relation restricts locks them, counted as one row, before it checks and keeps them", async () => {
    const { base, sent } = scripted([
      [{ _count: 2 }],
      [],
      { rows: [], rowCount: 2 },
    ]);
    const db = base.$extends(
      softDelete({ models: { post: { deletedAt: "deletedAt" } } })
    );
    await expect(
      db.post.deleteMany({ where: { id: { in: ["a", "b"] } } })
    ).resolves.toEqual({ count: 2 });
    expect(sent[0]!.sql).toContain("FOR UPDATE");
    expect(sent[0]!.sql.startsWith('SELECT COUNT(*) AS "_count" FROM (')).toBe(
      true
    );
    // The instant the rows are kept at varies: the golden holds its place.
    const [instant] = sent[2]!.params;
    expect(typeof instant).toBe("string");
    await expect(
      transcript(
        sent.map((statement, index) =>
          index === 2
            ? { ...statement, params: ["<now>", ...statement.params.slice(1)] }
            : statement
        )
      )
    ).toMatchFileSnapshot("./__golden__/extension-dialect-edges/kept-lock.sql");
  });
});

describe("a rule's argument under an operator with no operand form", () => {
  const ruled = () => {
    const { base, sent } = scripted([]);
    const db = base.$extends(
      extension(
        "tagged",
        args({ tag: oneOf("a", "b") }),
        rule({ post: { read: { where: { tags: { has: arg("tag") } } } } })
      )
    );
    return { db, sent };
  };

  test("is bound where the call passes it", async () => {
    const { db, sent } = ruled();
    await db.post.findMany({ select: { id: true }, tag: "a" });
    expect(sent).toEqual([
      {
        sql: 'SELECT "q0"."id" FROM "public"."post" AS "q0" WHERE $1 = ANY("q0"."tags") ORDER BY "q0"."id" ASC',
        params: ["a"],
      },
    ]);
  });

  test("drops its filter where the call leaves it out", async () => {
    const { db, sent } = ruled();
    await db.post.findMany({ select: { id: true } });
    expect(sent).toEqual([
      {
        sql: 'SELECT "q0"."id" FROM "public"."post" AS "q0" ORDER BY "q0"."id" ASC',
        params: [],
      },
    ]);
  });
});

describe("read-gated fields", () => {
  test("a gate that is its layer's own read holds wherever the row is read: an operand on the field reads the column", async () => {
    const visible = { id: { not: "u0" } };
    const { base, sent } = scripted([
      [{ id: "u2", name: "n", "0viborm_gate:0": true }],
    ]);
    const db = base.$extends(
      extension(
        "named",
        rule({
          user: { read: { where: visible, fields: { name: gate(visible) } } },
        })
      )
    );
    await expect(db.user.findMany({ where: { name: "n" } })).resolves.toEqual([
      { id: "u2", name: "n" },
    ]);
    expect(sent).toEqual([
      {
        sql: 'SELECT "q0"."id", "q0"."name", TRUE AS "0viborm_gate:0" FROM "public"."user" AS "q0" WHERE ("q0"."name" = $1 AND NOT ("q0"."id" = $2)) ORDER BY "q0"."id" ASC',
        params: ["n", "u0"],
      },
    ]);
  });

  test("a related document the provider answers as no document is refused", async () => {
    const { base } = scripted([
      [{ id: "p", title: "t", tags: [], authorId: "u1", author: [] }],
    ]);
    const db = base.$extends(
      extension(
        "named",
        rule({
          user: { read: { where: {}, fields: { name: gate({ id: "u1" }) } } },
        })
      )
    );
    const error = await failureOf(
      db.post.findMany({
        select: { id: true, author: { select: { id: true, name: true } } },
      })
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toHaveProperty(
      "message",
      'The "findMany" result is incompatible with the row scalar domain: a requested document is not a provider row.'
    );
  });
});

describe("a governed raw read", () => {
  test("$rows() of a model where the extension places no argument takes the model's domain alone", async () => {
    const member = s.model({ id: s.string().id(), name: s.string() });
    const page = s.model({ id: s.string().id(), owner: s.string() });
    const driver = new ScriptedDriver("postgresql");
    const db = createClient({ schema: { member, page }, driver }).$extends(
      extension(
        "owned",
        args({ who: oneOf("a", "b").on(["findMany"]).models(["page"]) }),
        rule({
          page: { read: { where: { owner: arg("who") } } },
          member: { read: { where: { name: "x" } } },
        })
      )
    );
    await expect(
      db.$queryRaw`SELECT u.id FROM ${db.member.$rows("u")}`
    ).resolves.toEqual([]);
    expect(driver.sent).toEqual([
      {
        sql: 'SELECT u.id FROM (SELECT * FROM "public"."member" AS "q0" WHERE "q0"."name" = $1) AS "u"',
        params: ["x"],
      },
    ]);
  });
});

describe("a judged update on MySQL", () => {
  /** A tree whose new parent is judged acyclic, and whose owner is checked. */
  const node = s.model({
    id: s.int().id(),
    ownerId: s.string(),
    tags: s.string().array(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
  });
  const judged = () => {
    const driver = new ScriptedDriver("mysql", () => ({
      rows: [],
      rowCount: 1,
    }));
    const db = createClient({ schema: { node }, driver }).$extends(
      extension(
        "owned",
        args({ user: oneOf("u1", "u2") }),
        rule({
          node: {
            update: {
              where: only({}),
              check: check({ ownerId: arg("user") }),
            },
            acyclic: ["parent"],
          },
        })
      )
    );
    return { db, sent: driver.sent };
  };

  test("judges the first `limit` candidates through a derived table, read before the write", async () => {
    const { db, sent } = judged();
    await expect(
      db.node.updateMany({
        where: { ownerId: "u1" },
        data: { ownerId: "u2" },
        limit: 2,
        user: "u2",
      })
    ).resolves.toEqual({ count: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toContain(" IN (SELECT * FROM (SELECT ");
    expect(sent[0]!.sql).toContain(" LIMIT ");
    await expect(transcript(sent)).toMatchFileSnapshot(
      "./__golden__/extension-dialect-edges/mysql-judged-limit.sql"
    );
  });

  test("a new parent is judged acyclic; a list the judgement does not read is assigned as the provider does", async () => {
    const { db, sent } = judged();
    await expect(
      db.node.updateMany({
        where: { id: 1 },
        data: { parentId: 2, tags: { push: "t" } },
        user: "u1",
      })
    ).resolves.toEqual({ count: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toContain("WITH RECURSIVE");
    expect(sent[0]!.sql).toContain("JSON_MERGE_PRESERVE");
    await expect(transcript(sent)).toMatchFileSnapshot(
      "./__golden__/extension-dialect-edges/mysql-judged-acyclic.sql"
    );
  });
});

describe("a polymorphic relation", () => {
  const alpha = s.model({ id: s.string().id(), secret: s.string() });
  const beta = s.model({ id: s.string().id(), label: s.string() });
  const holder = s.model({
    id: s.string().id(),
    label: s.string(),
    subject: s.toOne({ alpha: () => alpha, beta: () => beta }),
  });
  const variants = { holder, alpha, beta };

  test("a connect through it writes no variant row: an on() hook of a variant is not called", async () => {
    const driver = new ScriptedDriver("postgresql", ({ sql }) =>
      sql.startsWith("UPDATE") ? [{ id: "h", label: "x" }] : [{ id: "a" }]
    );
    const updated: unknown[] = [];
    const db = createClient({ schema: variants, driver }).$extends(
      on({
        alpha: {
          update: (rows) => {
            updated.push(rows);
          },
        },
      })
    );
    await expect(
      db.holder.update({
        where: { id: "h" },
        data: {
          label: "x",
          subject: { connect: { type: "alpha", where: { id: "a" } } },
        },
      })
    ).resolves.toEqual({ id: "h", label: "x" });
    expect(driver.sent.map(({ sql }) => sql.split(" ")[0])).toEqual([
      "SELECT",
      "SELECT",
      "UPDATE",
    ]);
    expect(driver.sent[2]!.params).toEqual(["x", "alpha", "a", '{"h"}']);
    expect(updated).toEqual([]);
  });

  test("a variant's gated field omitted is neither read nor its gate", async () => {
    const driver = new ScriptedDriver("postgresql", () => [{ id: "a" }]);
    const db = createClient({ schema: variants, driver }).$extends(
      extension(
        "secret",
        rule({
          alpha: { read: { where: {}, fields: { secret: gate({ id: "a" }) } } },
        })
      )
    );
    await expect(
      db.alpha.findMany({ omit: { secret: true } })
    ).resolves.toEqual([{ id: "a" }]);
    expect(driver.sent).toEqual([
      {
        sql: 'SELECT "q0"."id" FROM "public"."alpha" AS "q0" WHERE TRUE ORDER BY "q0"."id" ASC',
        params: [],
      },
    ]);
  });
});

describe("a computed field", () => {
  const author = s.model({
    id: s.string().id(),
    name: s.string(),
    books: s.toMany(() => book),
  });
  const book = s.model({
    id: s.string().id(),
    price: s.decimal({ precision: 10, scale: 2 }),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  });
  const priced = (answers: readonly Row[][]) => {
    const driver = new ScriptedDriver(
      "postgresql",
      (_, sent) => answers[sent.length - 1] ?? []
    );
    const needed: unknown[] = [];
    const db = createClient({ schema: { author, book }, driver }).$extends(
      extension(
        "priced",
        fields({
          book: {
            label: {
              needs: { price: true },
              compute: (row: { price: unknown }) => {
                needed.push(row.price);
                return String(row.price);
              },
            },
          },
        })
      )
    );
    return { db, needed };
  };

  test("reads a decimal it needs as the shared immutable value, beside a relation with no field of its own", async () => {
    const { db, needed } = priced([
      [
        {
          id: "b",
          price: "1.50",
          authorId: "a",
          author: { id: "a", name: "n" },
        },
      ],
    ]);
    const [row] = await db.book.findMany({ include: { author: true } });
    expect(row?.author).toEqual({ id: "a", name: "n" });
    expect(row?.label).toBe("1.5");
    expect(String(row?.price)).toBe("1.5");
    expect(needed).toHaveLength(1);
    expect(needed[0]?.constructor.name).toBe("ExactDecimal");
  });

  test("a relation selected false is no node of the plan", async () => {
    const { db } = priced([[{ id: "b", price: "2.00" }]]);
    await expect(
      db.book.findMany({ select: { id: true, author: false, label: true } })
    ).resolves.toEqual([{ id: "b", label: "2" }]);
  });
});
