/**
 * Review of the third extension wave (2026-11-15, `f656c7aa5..ca4ecfeea`):
 * the permissions compiler that writes the public words itself, `$bind`
 * restricted to `bound` arguments, and the per-schema memo moved from the
 * extension value to the parts.
 *
 * - `tenant`: since a048769b1 the shape check is gone ("the checks after it
 *   refuse every bad shape"). They do not: some shapes are accepted, others
 *   fail with a `TypeError` of the compiler. On f656c7aa5 each is a
 *   `ClientInitializationError` that says the shape.
 * - `{ $row, up }` whose `up` is not a count: accepted (null as 0, "1" as 1)
 *   or a `TypeError` at the first call. Red on f656c7aa5 too.
 * - The rest pins what held: an actor bound by `$as` cannot be replaced by
 *   a call argument, another extension's `$bind` or `c.set`; one part value
 *   in two extensions, and one extension over two schemas taken in turn,
 *   read each client's own tables; a JSON literal under `equals` reads as
 *   on f656c7aa5.
 *
 * Runs on SQLite, in memory or one file two clients share.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { call, extension, methods, rule } from "@src/index";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  createMany(args: object): Promise<unknown>;
}
interface Loose {
  [model: string]: unknown;
  post: Delegate;
  user: Delegate;
  member: Delegate;
  $extends(definition: unknown): Loose;
  $as(actor: object, scopes?: readonly string[]): Loose;
  $evil(): Loose;
  $executeRawUnsafe(query: string): Promise<number>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

const ids = async (delegate: Delegate, args: object = {}) =>
  (await delegate.findMany({ ...args, select: { id: true } }))
    .map((row) => Number(row.id))
    .sort((a, b) => a - b);

// ---------------------------------------------------------------- policies

const user = s.model({ id: s.int().id(), orgId: s.int() });
const member = s.model({
  id: s.int().id(),
  orgId: s.int(),
  userId: s.int(),
});
const post = s.model({
  id: s.int().id(),
  orgId: s.int(),
  authorId: s.int(),
  data: s.json().nullable(),
});
const Actor = v.object({ userId: v.number(), orgId: v.number() });

async function governed(
  policy: Record<string, unknown>,
  post_: Record<string, unknown> = { read: true }
): Promise<Loose> {
  const base = createClient({
    schema: { user, member, post },
    dataDir: ":memory:",
  }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  await base.user.createMany({
    data: [
      { id: 1, orgId: 1 },
      { id: 3, orgId: 2 },
    ],
  });
  await base.member.createMany({
    data: [
      { id: 1, orgId: 1, userId: 1 },
      { id: 3, orgId: 2, userId: 3 },
    ],
  });
  await base.post.createMany({
    data: [
      { id: 1, orgId: 1, authorId: 1, data: { actor: "userId" } },
      { id: 2, orgId: 1, authorId: 1, data: 3 },
      { id: 3, orgId: 2, authorId: 3, data: { $row: "orgId", up: 0 } },
      { id: 4, orgId: 2, authorId: 3, data: 1 },
    ],
  });
  return base.$extends(
    permissions({
      actor: Actor,
      models: { user: { read: true }, member: { read: true }, post: post_ },
      ...policy,
    } as never)
  );
}

/** What applying `policy` throws, if anything. */
const applying = async (policy: Record<string, unknown>) => {
  try {
    await governed(policy);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("permissions tenant: a declaration of another shape is refused as such (f656c7aa5)", () => {
  for (const [label, tenant] of [
    ["tenant: null", null],
    ["a field given as a list", { field: ["orgId"], actor: "orgId" }],
    ["an actor path given as a list", { field: "orgId", actor: ["orgId"] }],
    [
      "a key tenant does not take (a misspelt except)",
      { field: "orgId", actor: "orgId", exept: ["member"] },
    ],
    [
      "except given as an object",
      { field: "orgId", actor: "orgId", except: { member: true } },
    ],
    [
      "a field that is an object with a toString",
      { field: { toString: () => "orgId" }, actor: "orgId" },
    ],
  ] as const)
    test(label, async () => {
      const caught = await applying({ tenant });
      expect(caught).toBeInstanceOf(ClientInitializationError);
      expect(String((caught as Error).message)).toContain("tenant");
    });
});

describe("{ $row, up }: an up that is not a count of bodies is refused (red on f656c7aa5 too)", () => {
  // `orgId` of the member compared with the post's: up 1. Anything else that
  // is not a non-negative integer names no body.
  const reading = (up: unknown) => ({
    read: {
      $exists: {
        member: {
          orgId: { $row: "orgId", up },
          userId: { actor: "userId" },
        },
      },
    },
  });
  test("up 1 reads the actor's organisation only", async () => {
    const db = await governed({}, reading(1));
    expect(await ids(db.$as({ userId: 3, orgId: 2 }).post)).toEqual([3, 4]);
  });
  for (const [label, up] of [
    ["null, read as 0: every member matches itself", null],
    ['the string "1"', "1"],
    ["-1", -1],
    ["0.5", 0.5],
    ["NaN", Number.NaN],
  ] as const)
    test(`up ${label}`, async () => {
      const db = await governed({}, reading(up));
      await expect(
        ids(db.$as({ userId: 3, orgId: 2 }).post)
      ).rejects.toBeInstanceOf(ClientInitializationError);
    });
});

describe("a JSON literal under equals reads as on f656c7aa5", () => {
  test("{ actor } directly under equals is the actor's value; nested, a literal", async () => {
    const as3 = { userId: 3, orgId: 2 };
    const direct = await governed(
      {},
      {
        read: { data: { equals: { actor: "userId" } } },
      }
    );
    expect(await ids(direct.$as(as3).post)).toEqual([2]);
    const nested = await governed(
      {},
      {
        read: { data: { equals: { $row: "orgId", up: 0 } } },
      }
    );
    expect(await ids(nested.$as(as3).post)).toEqual([3]);
    const listed = await governed(
      {},
      {
        read: { data: { equals: [{ actor: "userId" }] } },
      }
    );
    expect(await ids(listed.$as(as3).post)).toEqual([]);
  });
});

// ---------------------------------------------------------------- binding

describe("an actor bound by $as is the actor every call reads", () => {
  const own = { read: { authorId: { actor: "userId" } } };
  const evil = (part: unknown) => extension("evil", part as never);
  const set = (key: string) =>
    evil(
      call((c) => {
        (c as never as { set(k: string, v: unknown): void }).set(key, {
          userId: 1,
          orgId: 1,
        });
      })
    );

  test("a call argument named actor is refused", async () => {
    const db = await governed({}, own);
    await expect(
      db.$as({ userId: 3, orgId: 2 }).post.findMany({ actor: { userId: 1 } })
    ).rejects.toThrow("actor");
  });
  test("another extension's $bind of actor is refused, before or after", async () => {
    const binder = evil(
      methods((scope) => ({
        $evil: () =>
          (scope as never as { $bind(v: object): unknown }).$bind({
            actor: { userId: 1, orgId: 1 },
          }),
      }))
    );
    const after = (await governed({}, own)).$extends(binder);
    expect(() => after.$as({ userId: 3, orgId: 2 }).$evil()).toThrow(
      ClientInitializationError
    );
  });
  test("c.set of actor or scopes in another extension fails the call", async () => {
    for (const key of ["actor", "scopes"]) {
      const db = (await governed({}, own)).$extends(set(key));
      await expect(ids(db.$as({ userId: 3, orgId: 2 }).post)).rejects.toThrow(
        "set no model call's arguments"
      );
    }
  });
  test("$as inside a transaction, and on a view of a view", async () => {
    const db = await governed({}, own);
    const view = db.$as({ userId: 1, orgId: 1 });
    expect(
      await (
        view as never as {
          $transaction(fn: (tx: Loose) => Promise<unknown>): Promise<unknown>;
        }
      ).$transaction((tx) => ids(tx.post))
    ).toEqual([1, 2]);
    expect(await ids(view.$as({ userId: 3, orgId: 2 }).post)).toEqual([3, 4]);
  });
});

// ---------------------------------------------------------------- memo per schema

/** Two schemas of the same model names over different tables of one file. */
async function twoSchemas() {
  const make = (suffix: string) =>
    s.model({ id: s.int().id(), title: s.string() }).map(`post_${suffix}`);
  const a = { post: make("a") };
  const b = { post: make("b") };
  const file = join(mkdtempSync(join(tmpdir(), "viborm-wave3-")), "db.sqlite");
  const clientA = createClient({ schema: a, dataDir: file }) as never as Loose;
  const clientB = createClient({ schema: b, dataDir: file }) as never as Loose;
  opened.push(clientA, clientB);
  for (const suffix of ["a", "b"])
    await clientA.$executeRawUnsafe(
      `CREATE TABLE post_${suffix} (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`
    );
  await clientA.$executeRawUnsafe(
    "INSERT INTO post_a (id, title) VALUES (1, 'keep'), (2, 'drop')"
  );
  await clientA.$executeRawUnsafe(
    "INSERT INTO post_b (id, title) VALUES (3, 'keep'), (4, 'drop')"
  );
  return { clientA, clientB };
}

describe("the memo moved to the parts stays per extension and per schema", () => {
  test("one rule part in two extensions, each over the two schemas", async () => {
    const { clientA, clientB } = await twoSchemas();
    const part = rule({ post: { read: { where: { title: "keep" } } } });
    const one = extension("one", part);
    const two = extension("two", part);
    for (const [ext, other] of [
      [one, two],
      [two, one],
    ] as const) {
      expect(await ids(clientA.$extends(ext).post)).toEqual([1]);
      expect(await ids(clientB.$extends(other).post)).toEqual([3]);
      expect(await ids(clientB.$extends(ext).$extends(other).post)).toEqual([
        3,
      ]);
    }
  });
  test("one extension over two schemas taken in turn, three times", async () => {
    const { clientA, clientB } = await twoSchemas();
    const ext = extension(
      "kept-titles",
      rule({ post: { read: { where: { title: "keep" } } } })
    );
    for (let round = 0; round < 3; round++) {
      expect(await ids(clientA.$extends(ext).post)).toEqual([1]);
      expect(await ids(clientB.$extends(ext).post)).toEqual([3]);
    }
  });
});
