/**
 * The last adversarial read of the extension rewrite (step 10): what no
 * earlier review probed, each test stating what an application relies on.
 *
 * - a rule that reads `now` and an argument, under a recursive read;
 * - two `around` parts placed nearest the core, beside one that is not;
 * - `again` after a nested write that failed between its statements;
 * - "a mode is an argument with a default" (spec, section 6): in the relation
 *   reads another extension's filter makes, an argument with a default reads
 *   as its default whether it was declared `oneOf(...)` or `accepts(schema)`.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import {
  accepts,
  again,
  arg,
  around,
  args as extArgs,
  extension,
  now,
  oneOf,
  rule,
  target,
  text,
  unit,
  when,
} from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const node = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  rank: s.string(),
  publishAt: s.dateTime(),
  deletedAt: s.dateTime().nullable(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});
const schema = { node };

type Row = Record<string, unknown> & { id: string; children?: Row[] };
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  count(args?: object): Promise<number>;
}
type Loose = { node: Delegate } & {
  $extends(definition: unknown): Loose;
  $disconnect(): Promise<void>;
};

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

const INSERT = /^insert/i;
const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2999-01-01T00:00:00.000Z");

/**
 * a (alice) ─┬─ b (alice) ── e (alice)
 *            ├─ c (alice, published in the future) ── f (alice)
 *            └─ d (bob)
 */
async function seeded(): Promise<Loose> {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  const rows: Record<string, unknown>[] = [
    { id: "a", ownerId: "alice", rank: "2", parentId: null },
    { id: "b", ownerId: "alice", rank: "1", parentId: "a" },
    { id: "c", ownerId: "alice", rank: "3", parentId: "a", publishAt: FUTURE },
    { id: "d", ownerId: "bob", rank: "4", parentId: "a" },
    { id: "e", ownerId: "alice", rank: "5", parentId: "b" },
    { id: "f", ownerId: "alice", rank: "6", parentId: "c" },
  ];
  for (const data of rows)
    await base.node.create({ data: { publishAt: PAST, ...data } });
  return base;
}

/** Every id of a recursive read, depth first. */
const tree = (rows: readonly Row[]): string[] =>
  rows.flatMap((row) => [row.id, ...tree(row.children ?? [])]);

describe("a rule that reads now and an argument, under recursion", () => {
  const published = extension(
    "published",
    extArgs({ user: v.string() }),
    rule({
      node: {
        read: { where: { publishAt: { lte: now }, ownerId: arg("user") } },
      },
    })
  );

  test("every depth of a recursive include holds the rule, with the call's values", async () => {
    const db = (await seeded()).$extends(published);
    const rows = await db.node.findMany({
      user: "alice",
      where: { parentId: null },
      include: { children: { recurse: { depth: false } } },
      orderBy: { rank: "asc" },
    });
    // c is not published yet (and f is reached only through it); d is bob's.
    expect(tree(rows).sort()).toEqual(["a", "b", "e"]);
  });

  test("another caller's value reads another tree", async () => {
    const db = (await seeded()).$extends(published);
    const recursive = { include: { children: { recurse: { depth: false } } } };
    const alice = await db.node.findMany({ user: "alice", ...recursive });
    const bob = await db.node.findMany({ user: "bob", ...recursive });
    // f is a root row of alice's: its parent c is hidden, f itself is not.
    expect(tree(alice).sort()).toEqual(["a", "b", "b", "e", "e", "e", "f"]);
    // Bob's only row is d, whose parent is alice's: no child of his.
    expect(tree(bob)).toEqual(["d"]);
  });
});

describe("two around parts nearest the core, and one that is not", () => {
  test("the outer part sees the call an inner part answers; the second inner does not", async () => {
    const log: string[] = [];
    const answer = extension(
      "answer",
      around(
        (c) =>
          c.args && "where" in c.args
            ? () => {
                log.push("answer");
                return Promise.resolve([]);
              }
            : (run) => {
                log.push("answer:run");
                return run();
              },
        target(["node"], ["findMany"]),
        { inner: true }
      )
    );
    const second = extension(
      "second",
      around(
        () => (run) => {
          log.push("second");
          return run();
        },
        target(["node"], ["findMany"]),
        { inner: true }
      )
    );
    const outer = extension(
      "outer",
      around(
        () => (run) => {
          log.push("outer");
          return run();
        },
        target(["node"], ["findMany"])
      )
    );
    const db = (await seeded())
      .$extends(answer)
      .$extends(second)
      .$extends(outer);
    expect(await db.node.findMany({ where: { id: "a" } })).toEqual([]);
    expect(log).toEqual(["outer", "answer"]);
    log.length = 0;
    expect(await db.node.count()).toBe(6);
    expect(log).toEqual([]);
    expect((await db.node.findMany()).length).toBe(6);
    // Two inner parts: the one applied first is the outer of the two.
    expect(log).toEqual(["outer", "answer:run", "second"]);
  });
});

describe("again after a nested write that failed between its statements", () => {
  test("nothing of the first attempt stays, and the second writes each row once", async () => {
    let inserts = 0;
    let failed = false;
    let retried = false;
    const flaky = extension(
      "flaky",
      unit(
        (u, next) => {
          const sql = text(u) ?? "";
          if (!failed && INSERT.test(sql.trim())) {
            inserts += 1;
            // The second INSERT of the first attempt: its parent row is
            // already written inside the call's transaction.
            if (inserts === 2) {
              failed = true;
              throw new Error("the child's insert fails once");
            }
          }
          return next();
        },
        ["statement"]
      )
    );
    const retry = extension(
      "retry",
      around(
        () => async (run) => {
          try {
            return await run();
          } catch (error) {
            if (!again(run)) throw error;
            retried = true;
            return run();
          }
        },
        target(["node"], ["create"])
      )
    );
    const db = (await seeded()).$extends(retry).$extends(flaky);
    await db.node.create({
      data: {
        id: "p",
        ownerId: "carol",
        rank: "7",
        publishAt: PAST,
        children: {
          create: [{ id: "q", ownerId: "carol", rank: "8", publishAt: PAST }],
        },
      },
    });
    expect(failed).toBe(true);
    expect(retried).toBe(true);
    expect(await db.node.count({ where: { ownerId: "carol" } })).toBe(2);
  });
});

describe("a mode is an argument with a default (spec, section 6)", () => {
  // `a` (rank 2) is deleted: every other row is a child of it.
  async function withDeletedRoot(): Promise<Loose> {
    const base = await seeded();
    const raw = base as unknown as {
      node: { update(args: object): Promise<unknown> };
    };
    await raw.node.update({ where: { id: "a" }, data: { deletedAt: PAST } });
    return base;
  }
  const hiding = (declared: unknown) =>
    extension(
      "hiding",
      extArgs({ deleted: declared as never }),
      rule({
        node: {
          root: when(arg("deleted"), "without", { deletedAt: null }),
          related: when(arg("deleted"), "without", { deletedAt: null }),
        },
      })
    );
  // Another extension's filter reads each row's parent through a relation.
  const underRankTwo = extension(
    "under-rank-two",
    rule({ node: { root: { parent: { is: { rank: "2" } } } } })
  );

  const declarations = {
    "oneOf(...).default(...)": oneOf("without", "with").default("without"),
    "accepts(schema).default(...)": accepts(v.string()).default("without"),
  };

  test.each(
    Object.entries(declarations)
  )("declared %s: the parent read by another extension's filter reads the argument at its default", async (_label, declared) => {
    const db = (await withDeletedRoot())
      .$extends(hiding(declared))
      .$extends(underRankTwo);
    // The call shows deleted rows; the other extension's relation read
    // still hides them, so no row's parent is `a`.
    const rows = await db.node.findMany({ deleted: "with" });
    expect(rows.map((row) => row.id).sort()).toEqual([]);
  });
});
