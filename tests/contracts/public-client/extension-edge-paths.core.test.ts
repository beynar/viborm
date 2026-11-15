/**
 * Extension paths no other contract reaches. Most run over a driver that
 * sends nothing (`tests/fixtures/drivers/scripted.ts`) and pin what a
 * database receives; those whose answer needs rows a script cannot write (a
 * recursive read, a native batch) run on an in-memory SQLite database.
 */

import {
  arg,
  args,
  around,
  ClientInitializationError,
  check,
  createClient,
  exists,
  extension,
  fields,
  gate,
  oneOf,
  provided,
  QueryError,
  rule,
  run,
  s,
  sql,
  statements,
  target,
  UnsupportedOperationError,
  unit,
  ValidationError,
  via,
  within,
} from "@src/index";
import { on } from "@src/on";
import { softDelete } from "@src/soft-delete";
import {
  ScriptedDriver,
  type SentStatement,
} from "@tests/fixtures/drivers/scripted";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createBatchOnlySQLite3Driver } from "@tests/providers/local/sqlite3-fixtures";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  tenant: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const schema = { user, post };

type Row = Readonly<Record<string, unknown>>;

/** A PostgreSQL client whose statements each get what `answer` gives. */
function scripted(
  answer: (statement: SentStatement) => readonly Row[] = () => []
) {
  const driver = new ScriptedDriver("postgresql", answer);
  return { base: createClient({ schema, driver }), sent: driver.sent };
}

/** What a call rejects with. */
const failureOf = (call: PromiseLike<unknown>) =>
  Promise.resolve(call).then(
    () => undefined,
    (caught: unknown) => caught
  );

describe("around parts", () => {
  test("a member of $transaction([...]) no around part wraps runs as it is beside one that is wrapped", async () => {
    const { base, sent } = scripted();
    const wrapped: string[] = [];
    const db = base.$extends(
      extension(
        "posts-only",
        around(
          (c) => async (run) => {
            wrapped.push(`${c.model}.${c.operation}`);
            return await run();
          },
          target("post", "findMany")
        )
      )
    );
    await expect(
      db.$transaction([
        db.post.findMany({ select: { id: true } }),
        db.user.findMany({ select: { id: true } }),
      ])
    ).resolves.toEqual([[], []]);
    expect(wrapped).toEqual(["post.findMany"]);
    expect(sent.map(({ sql: text }) => text)).toEqual([
      'SELECT "q0"."id" FROM "public"."post" AS "q0" ORDER BY "q0"."id" ASC',
      'SELECT "q0"."id" FROM "public"."user" AS "q0" ORDER BY "q0"."id" ASC',
    ]);
  });

  test("via() after the second moment returned is refused, and the call keeps the value it was answered with", async () => {
    const { base, sent } = scripted();
    const elsewhere = new ScriptedDriver("postgresql");
    let late: (() => unknown) | undefined;
    const db = base.$extends(
      extension(
        "served",
        around(
          () => async (run) => {
            late = () => via(run, elsewhere);
            return [];
          },
          target("post", "findMany")
        )
      )
    );
    await expect(db.post.findMany()).resolves.toEqual([]);
    expect(late).toThrow(QueryError);
    expect(late).toThrow(
      'Extension "served" around() for post.findMany called run() after its second moment returned.'
    );
    expect(sent).toEqual([]);
    expect(elsewhere.sent).toEqual([]);
  });
});

describe("unit parts", () => {
  /** A driver whose transactions open a turn of the event loop late. */
  class SlowOpening extends ScriptedDriver {
    protected override async transaction<T>(
      client: object,
      body: (transaction: object) => Promise<T>
    ): Promise<T> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return body(client);
    }
  }

  test("a transaction unit that starts run() and fails before the transaction opened never lets the body run: its statement runs in the transaction, which rolls back", async () => {
    const driver = new SlowOpening("postgresql");
    const refusal = new Error("refused before the transaction opened");
    let started: Promise<unknown> | undefined;
    let bodyRan = false;
    const db = createClient({ schema, driver }).$extends(
      extension(
        "opening",
        unit(
          (u) => {
            started = run(u, sql`SELECT 1`);
            started.catch(() => undefined);
            throw refusal;
          },
          ["transaction"]
        )
      )
    );
    const failure = await failureOf(
      db.$transaction(async () => {
        bodyRan = true;
      })
    );
    expect(failure).toBe(refusal);
    await expect(started).resolves.toEqual([]);
    expect(bodyRan).toBe(false);
    expect(driver.sent).toEqual([{ sql: "SELECT 1", params: [] }]);
  });
});

/** The statements, as a golden holds them: text, then parameters. */
const transcript = (sent: readonly SentStatement[]) =>
  `${sent.map(({ sql: text, params }) => `${text};\n-- ${JSON.stringify(params)}`).join("\n\n")}\n`;

/** A tree of nodes, each in a tenant. */
const node = s.model({
  id: s.string().id(),
  tenant: s.string(),
  flag: s.boolean(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree")
    .onDelete("restrict"),
  children: s.toMany(() => node).name("tree"),
});

describe("rules", () => {
  test("two layers that walk one model, one of them confining it, read one reaching set computed over the whole table", async () => {
    const driver = new ScriptedDriver("postgresql");
    // Shared relation bodies, so the walk is one set over the table.
    driver.adapter.capabilities.sharesRelationBodies = true;
    driver.adapter.capabilities.relationsPerStatement = 1;
    const walk = {
      children: { recurse: { depth: false }, some: { flag: true } },
    } as const;
    const db = createClient({ schema: { node }, driver })
      .$extends(extension("walking", rule({ node: { read: { where: walk } } })))
      .$extends(
        extension(
          "tenanted",
          rule({
            node: { read: { where: walk }, confine: within({ tenant: "b" }) },
          })
        )
      );
    await expect(db.node.findMany({ select: { id: true } })).resolves.toEqual(
      []
    );
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]!.sql.startsWith('WITH RECURSIVE "__shared_0"')).toBe(
      true
    );
    await expect(transcript(driver.sent)).toMatchFileSnapshot(
      "./__golden__/extension-edge-paths/confined-reaching-set.sql"
    );
  });

  test("an OR whose provided() arm applies merges its two quantifiers over one relation; where it does not apply, the arm goes", async () => {
    const { base, sent } = scripted();
    const db = base.$extends(
      extension(
        "modes",
        args({ mode: oneOf("a", "b") }),
        rule({
          user: {
            read: {
              where: {
                OR: [
                  { posts: { some: { title: "x" } } },
                  provided(arg("mode"), "a", {
                    posts: { some: { title: "y" } },
                  }),
                ],
              },
            },
          },
        })
      )
    );
    await db.user.findMany({ select: { id: true }, mode: "a" });
    await db.user.findMany({ select: { id: true }, mode: "b" });
    expect(sent).toEqual([
      {
        sql: 'SELECT "q0"."id" FROM "public"."user" AS "q0" WHERE EXISTS (SELECT 1 FROM "public"."post" AS "q1" WHERE ("q0"."id" = "q1"."authorId" AND "q1"."title" = ANY($1))) ORDER BY "q0"."id" ASC',
        params: ['{"x","y"}'],
      },
      {
        sql: 'SELECT "q0"."id" FROM "public"."user" AS "q0" WHERE EXISTS (SELECT 1 FROM "public"."post" AS "q1" WHERE ("q0"."id" = "q1"."authorId" AND "q1"."title" = $1)) ORDER BY "q0"."id" ASC',
        params: ["x"],
      },
    ]);
  });

  test("a filter that reads its call keeps a to-one relation's existence test, which has no condition of its own", async () => {
    const driver = new ScriptedDriver("postgresql");
    const db = createClient({ schema: { node }, driver }).$extends(
      extension(
        "modes",
        args({ mode: oneOf("a", "b") }),
        rule({
          node: {
            read: { where: { parent: { isNot: null }, tenant: arg("mode") } },
          },
        })
      )
    );
    await db.node.findMany({ select: { id: true }, mode: "a" });
    expect(driver.sent).toEqual([
      {
        sql: 'SELECT "q0"."id" FROM "public"."node" AS "q0" WHERE (EXISTS (SELECT 1 FROM "public"."node" AS "q1" WHERE "q0"."parentId" = "q1"."id") AND "q0"."tenant" = $1) ORDER BY "q0"."id" ASC',
        params: ["a"],
      },
    ]);
  });

  test("a gate whose filter reads an optional argument the call leaves out masks nothing", async () => {
    const { base, sent } = scripted(() => [
      { id: "u", name: "n", tenant: "t", "0viborm_gate:0": true },
    ]);
    const db = base.$extends(
      extension(
        "gated",
        args({ mode: oneOf("a", "b") }),
        rule({
          user: { read: { fields: { name: gate({ tenant: arg("mode") }) } } },
        })
      )
    );
    await expect(db.user.findMany()).resolves.toEqual([
      { id: "u", name: "n", tenant: "t" },
    ]);
    expect(sent).toEqual([
      {
        sql: 'SELECT "q0"."id", "q0"."name", TRUE AS "0viborm_gate:0", "q0"."tenant" FROM "public"."user" AS "q0" ORDER BY "q0"."id" ASC',
        params: [],
      },
    ]);
  });

  /** A rule whose checks read an optional argument. */
  const owned = () =>
    extension(
      "owned",
      args({ owner: oneOf("o1", "o2") }),
      rule({
        post: {
          create: { check: check({ ownerId: arg("owner") }) },
          update: { check: check({ ownerId: arg("owner") }) },
        },
      })
    );
  const rows = [
    { id: "p1", title: "x", ownerId: "o1", authorId: "u" },
    { id: "p2", title: "y", ownerId: "o1", authorId: "u" },
  ];

  test("a check that reads an absent optional argument judges nothing: the rows are written as they are", async () => {
    const { base, sent } = scripted();
    const db = base.$extends(owned());
    await expect(
      db.post.updateMany({ where: { id: "p1" }, data: { ownerId: "o9" } })
    ).resolves.toEqual({ count: 0 });
    expect(sent).toEqual([
      {
        sql: 'UPDATE "public"."post" SET "ownerId" = $1 WHERE "post"."id" = $2',
        params: ["o9", "p1"],
      },
    ]);
  });

  test("the values a judged insert binds count against the driver's bind budget only where the check stands", async () => {
    class Bounded extends ScriptedDriver {
      override readonly maxBindParametersPerStatement = 12;
    }
    const inserted = async (owner?: "o1") => {
      const driver = new Bounded("postgresql");
      const db = createClient({ schema, driver }).$extends(owned());
      await db.post.createMany({ data: rows, ...(owner && { owner }) });
      return driver.sent.map(({ params }) => params.length);
    };
    // Eight values and the check's one; without the argument, nothing is judged.
    expect(await inserted("o1")).toEqual([9]);
    expect(await inserted()).toEqual([8]);
  });

  test("a create of a model whose rule checks updates only is not judged", async () => {
    const { base, sent } = scripted(() => [rows[0]!]);
    const db = base.$extends(
      extension(
        "owned",
        rule({ post: { update: { check: check({ ownerId: "o1" }) } } })
      )
    );
    await expect(db.post.create({ data: rows[0]! })).resolves.toEqual(rows[0]);
    expect(sent).toEqual([
      {
        sql: 'INSERT INTO "public"."post" ("id", "title", "ownerId", "authorId") VALUES ($1, $2, $3, $4) RETURNING "id" AS "id", "title" AS "title", "ownerId" AS "ownerId", "authorId" AS "authorId"',
        params: ["p1", "x", "o1", "u"],
      },
    ]);
  });

  test("a check comparing a column with an SQL expression of another judges an update that writes only the other", async () => {
    const { base, sent } = scripted();
    const db = base.$extends(
      extension(
        "matched",
        rule({
          post: {
            update: {
              check: check({
                title: {
                  equals: (ctx: {
                    sql: typeof sql;
                    fields: { ownerId: unknown };
                  }) => ctx.sql`${ctx.fields.ownerId}`,
                },
              } as never),
            },
          },
        })
      )
    );
    await db.post.updateMany({ where: { id: "p1" }, data: { ownerId: "o2" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toContain(
      'CASE WHEN "q1"."title" = ("q1"."ownerId") THEN 1'
    );
    await expect(transcript(sent)).toMatchFileSnapshot(
      "./__golden__/extension-edge-paths/judged-sql-operand.sql"
    );
  });

  test("a check that reads a many-to-many relation, which reaches it through the row's key, does not judge again an update that writes another field", async () => {
    const member = s.model({
      id: s.string().id(),
      name: s.string(),
      groups: s.toMany(() => group),
    });
    const group = s.model({
      id: s.string().id(),
      label: s.string(),
      members: s.toMany(() => member),
    });
    const driver = new ScriptedDriver("postgresql");
    const db = createClient({ schema: { member, group }, driver }).$extends(
      extension(
        "grouped",
        rule({
          member: {
            update: { check: check({ groups: { some: { label: "g" } } }) },
          },
        })
      )
    );
    await db.member.updateMany({ where: { id: "m" }, data: { name: "n" } });
    // The row's answer is its old one, which the candidates already state.
    expect(driver.sent).toEqual([
      {
        sql: 'UPDATE "public"."member" SET "name" = $1 WHERE "member"."id" = $2',
        params: ["n", "m"],
      },
    ]);
  });

  test("exists() whose filter is not an object is refused where the extension is applied, at its place", () => {
    const { base } = scripted();
    const apply = () =>
      base.$extends(
        extension(
          "existing",
          rule({
            user: {
              read: { where: { AND: [exists({ post: "x" as never })] } },
            },
          })
        )
      );
    expect(apply).toThrow(ClientInitializationError);
    expect(apply).toThrow(
      'Extension "existing" rule.user.root: at "AND.0.post": Expected object.'
    );
  });

  test("a $through write to a junction model whose creates are checked is refused", async () => {
    const seat = s
      .model({
        roomId: s.string(),
        guestId: s.string(),
        role: s.string(),
        room: s
          .toOne(() => room)
          .fields("roomId")
          .references("id"),
        guest: s
          .toOne(() => guest)
          .fields("guestId")
          .references("id"),
      })
      .id(["roomId", "guestId"]);
    const room = s.model({
      id: s.string().id(),
      guests: s
        .toMany(() => guest)
        .through(() => seat)
        .source("room")
        .target("guest"),
    });
    const guest = s.model({
      id: s.string().id(),
      rooms: s.toMany(() => room),
    });
    const driver = new ScriptedDriver("postgresql", () => [{ id: "r" }]);
    const db = createClient({ schema: { seat, room, guest }, driver }).$extends(
      extension(
        "judged",
        rule({ seat: { create: { check: check({ role: "owner" }) } } })
      )
    );
    const failure = await failureOf(
      db.room.update({
        where: { id: "r" },
        data: {
          guests: { connect: { id: "g1", $through: { role: "owner" } } },
        },
      })
    );
    expect(failure).toBeInstanceOf(UnsupportedOperationError);
    expect(failure).toHaveProperty(
      "message",
      "Cannot write $through of relation 'guests': this client's extensions judge or observe writes to 'seat'. Write the row through the 'seat' delegate."
    );
    expect(driver.sent).toEqual([]);
  });
});

describe("kept rows", () => {
  test("a nested delete of a child through its own model's self relation keeps it, checking only the relations that restrict it", async () => {
    const driver = new ScriptedDriver("postgresql", ({ sql: text }) => {
      if (text.startsWith("SELECT COUNT")) return [{ _count: 1 }];
      if (text.startsWith("SELECT 1 /")) return [{ __viborm_assert__: 1 }];
      return [
        { id: "a", tenant: "t", flag: false, parentId: null, deletedAt: null },
      ];
    });
    const tomb = s.model({
      id: s.string().id(),
      deletedAt: s.dateTime().nullable(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => tomb)
        .fields("parentId")
        .references("id")
        .name("tree")
        .onDelete("restrict"),
      children: s.toMany(() => tomb).name("tree"),
    });
    const db = createClient({ schema: { tomb }, driver }).$extends(
      softDelete({ models: { tomb: { deletedAt: "deletedAt" } } })
    );
    await db.tomb.update({
      where: { id: "a" },
      data: { children: { delete: { id: "b" } } },
    });
    await expect(
      transcript(
        driver.sent.map((statement) => ({
          ...statement,
          params: statement.params.map((value) =>
            typeof value === "string" && value.includes("T") ? "<now>" : value
          ),
        }))
      )
    ).toMatchFileSnapshot("./__golden__/extension-edge-paths/kept-self.sql");
  });
});

describe("computed fields", () => {
  const tag = s.model({ label: s.string(), id: s.string().id() });
  const hidden = s
    .model({ id: s.string().id(), secret: s.string() })
    .omit({ id: true, secret: true });

  test("two relations whose rows compute a field each read the column it needs", async () => {
    const driver = new ScriptedDriver("postgresql", () => [
      { id: "n", parent: { tenant: "p" }, children: [{ tenant: "c" }] },
    ]);
    const db = createClient({ schema: { node }, driver }).$extends(
      extension(
        "labelled",
        fields({
          node: {
            label: {
              needs: { tenant: true },
              compute: (row: { tenant: unknown }) => `L${String(row.tenant)}`,
            },
          },
        })
      )
    );
    await expect(
      db.node.findMany({
        select: {
          id: true,
          // The client types a computed field where its model is read, not
          // in a relation's selection: the call is written untyped.
          parent: { select: { label: true } },
          children: { select: { label: true } },
        },
      } as never)
    ).resolves.toEqual([
      { id: "n", parent: { label: "Lp" }, children: [{ label: "Lc" }] },
    ]);
    expect(driver.sent).toEqual([
      {
        sql: 'SELECT "q0"."id", (SELECT json_build_object($1::text, "q2"."tenant") FROM (SELECT "q1"."tenant" FROM "public"."node" AS "q1" WHERE "q0"."parentId" = "q1"."id" LIMIT $2) AS "q2") AS "parent", (SELECT COALESCE(json_agg(json_build_object($3::text, "q4"."tenant")), \'[]\'::json) FROM (SELECT "q3"."tenant" FROM "public"."node" AS "q3" WHERE "q0"."id" = "q3"."parentId") AS "q4") AS "children" FROM "public"."node" AS "q0" ORDER BY "q0"."id" ASC',
        params: ["tenant", 1, "tenant"],
      },
    ]);
  });

  test("a field computed over a recursive relation is computed at each depth, the deepest rows holding no relation", async () => {
    const base = createClient({
      schema: { node },
      driver: createInMemorySQLite3Driver(),
    });
    await syncLiveSchema(base as never);
    await base.node.createMany({
      data: [
        { id: "a", tenant: "t", flag: false, parentId: null },
        { id: "b", tenant: "u", flag: false, parentId: "a" },
        { id: "c", tenant: "v", flag: false, parentId: "b" },
      ],
    });
    const db = base.$extends(
      extension(
        "labelled",
        fields({
          node: {
            label: {
              needs: { tenant: true },
              compute: (row: { tenant: unknown }) => `L${String(row.tenant)}`,
            },
          },
        })
      )
    );
    await expect(
      db.node.findMany({
        where: { id: "a" },
        select: {
          id: true,
          children: {
            recurse: { depth: 1 },
            select: { id: true, label: true },
          },
        },
      } as never)
    ).resolves.toEqual([{ id: "a", children: [{ id: "b", label: "Lu" }] }]);
    await base.$disconnect();
  });

  test("a field named as a model's first column is selected alone by that column, kept in the row it computes", async () => {
    const driver = new ScriptedDriver("postgresql", () => [
      { label: "stored" },
    ]);
    const db = createClient({ schema: { tag }, driver }).$extends(
      extension(
        "shadow",
        fields({ tag: { label: { needs: {}, compute: () => "computed" } } })
      )
    );
    await expect(db.tag.findMany({ select: { label: true } })).resolves.toEqual(
      [{ label: "computed" }]
    );
    expect(driver.sent).toEqual([
      {
        sql: 'SELECT "q0"."label" FROM "public"."tag" AS "q0" ORDER BY "q0"."id" ASC',
        params: [],
      },
    ]);
  });

  test("selecting only a field that needs nothing, on a model that omits every column, is refused: nothing is left to read", async () => {
    const driver = new ScriptedDriver("postgresql");
    const db = createClient({ schema: { hidden }, driver }).$extends(
      extension(
        "shown",
        fields({ hidden: { shown: { needs: {}, compute: () => "shown" } } })
      )
    );
    const failure = await failureOf(
      db.hidden.findMany({ select: { shown: true } })
    );
    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toHaveProperty(
      "message",
      "Validation failed for hidden.findMany: select: select needs at least one truthy value; leave it out to return the default row."
    );
    expect(driver.sent).toEqual([]);
  });
});

describe("watched writes", () => {
  test("a nested write that writes no row calls no on() hook of its model", async () => {
    const { base, sent } = scripted(({ sql: text }) =>
      text.startsWith("SELECT") ? [{ id: "u", name: "n", tenant: "t" }] : []
    );
    const heard: unknown[] = [];
    const db = base.$extends(
      on({
        post: {
          update: (written) => {
            heard.push(written);
          },
        },
      })
    );
    await expect(
      db.user.update({
        where: { id: "u" },
        data: {
          posts: {
            updateMany: { where: { title: "none" }, data: { title: "z" } },
          },
        },
      })
    ).resolves.toEqual({ id: "u", name: "n", tenant: "t" });
    expect(heard).toEqual([]);
    expect(sent.map(({ sql: text }) => text.slice(0, 32))).toEqual([
      'SELECT "q0"."id" FROM "public"."',
      'UPDATE "public"."post" SET "titl',
      'SELECT "q0"."id", "q0"."name", "',
    ]);
  });
});

describe("unit words", () => {
  test("each member of a native batch names its model, operation and call, a guard and a raw statement included", async () => {
    const base = createClient({
      schema,
      driver: createBatchOnlySQLite3Driver(),
    });
    await syncLiveSchema(base as never);
    const members: unknown[] = [];
    const db = base.$extends(
      extension(
        "batch",
        unit(
          (u, next) => {
            for (const member of statements(u) ?? [])
              members.push({
                model: member.model,
                operation: member.operation,
                correlated: typeof member.correlation === "string",
                parameters: member.parameters,
              });
            return next();
          },
          ["statement"]
        )
      )
    );
    await db.$transaction([
      db.user.create({
        data: {
          id: "u",
          name: "n",
          tenant: "t",
          posts: { create: { id: "p", title: "t", ownerId: "o" } },
        },
      }),
      db.post.update({
        where: { id: "p" },
        data: { author: { connect: { id: "u" } } },
      }),
      db.$executeRawUnsafe("UPDATE post SET title = 'x'"),
    ]);
    const member = (
      model: string,
      operation: string,
      parameters: unknown[]
    ) => ({
      model,
      operation,
      correlated: true,
      parameters,
    });
    expect(members).toEqual([
      member("user", "create", ["u", "n", "t"]),
      member("post", "create", ["p", "t", "o", "u"]),
      member("post", "update", ["p", 1]),
      member("user", "update", ["u", 1]),
      member("post", "update", ["u", "p", "p"]),
      member("$raw", "$executeRawUnsafe", []),
    ]);
    await base.$disconnect();
  });
});
