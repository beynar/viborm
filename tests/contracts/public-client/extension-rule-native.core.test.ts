/**
 * `rule` read as it is written: an argument a filter tests keeps the
 * placement its own declaration gives, and a key an entry leaves out adds
 * no restriction, so an action a rule refuses is an explicit `nothing`
 * (spec, correction 4), for a hand-written rule as for `permissions`.
 */
import { createClient } from "@drivers/sqlite3";
import { ForbiddenError, VibORMError } from "@errors";
import { s } from "@schema";
import { arg, args, extension, nothing, oneOf, rule, when } from "@src/index";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  owner: s
    .toOne(() => user)
    .fields("ownerId")
    .references("id"),
});
const schema = { user, post };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  update(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ count: number }>;
  delete(args: object): Promise<Row>;
  deleteMany(args: object): Promise<{ count: number }>;
}
interface Loose {
  user: Delegate;
  post: Delegate;
  $extends(extension: unknown): Loose;
  $as(actor: object): Loose;
}

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
});

async function seeded(): Promise<Loose> {
  const base = createClient({ schema, dataDir: ":memory:" });
  clients.push(base);
  await syncLiveSchema(base);
  await base.user.create({ data: { id: "u1" } });
  await base.post.create({ data: { id: "p1", title: "one", ownerId: "u1" } });
  return base as unknown as Loose;
}

const rejection = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => error
  );

describe("an argument a filter tests is placed as it is declared", () => {
  test("a mode argument keeps .models: another model does not accept it", async () => {
    const db = (await seeded()).$extends(
      extension(
        "moded",
        args({ view: oneOf("mine", "all").default("all").models(["post"]) }),
        rule({
          post: {
            read: { where: when(arg("view"), "mine", { ownerId: "u2" }) },
          },
        } as never)
      )
    );
    expect(await db.post.findMany({ view: "mine" })).toEqual([]);
    expect(await db.post.findMany({})).toHaveLength(1);
    expect(await rejection(db.user.findMany({ view: "mine" }))).toBeInstanceOf(
      VibORMError
    );
  });
});

describe("an action a rule does not grant is an explicit nothing", () => {
  test("a hand-written rule listing only read refuses update and delete", async () => {
    const base = await seeded();
    const db = base.$extends(
      extension(
        "read-only",
        rule({
          post: {
            read: { where: { ownerId: "u1" } },
            update: { where: nothing },
            delete: { where: nothing },
          },
        } as never)
      )
    );
    expect(await db.post.findMany({})).toHaveLength(1);
    expect(
      await rejection(
        db.post.update({ where: { id: "p1" }, data: { title: "x" } })
      )
    ).toBeInstanceOf(VibORMError);
    expect(
      await rejection(db.post.delete({ where: { id: "p1" } }))
    ).toBeInstanceOf(VibORMError);
    expect(
      await db.post.updateMany({ where: {}, data: { title: "x" } })
    ).toEqual({ count: 0 });
    expect(await db.post.deleteMany({ where: {} })).toEqual({ count: 0 });
    expect(await base.post.findMany({})).toEqual([
      { id: "p1", title: "one", ownerId: "u1" },
    ]);
  });

  test("permissions: a model listed with only read refuses update and delete", async () => {
    const base = await seeded();
    const db = base
      .$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: { post: { read: true }, user: { read: true } },
        } as never)
      )
      .$as({ userId: "u1" });
    expect(await db.post.findMany({})).toHaveLength(1);
    expect(
      await rejection(
        db.post.update({ where: { id: "p1" }, data: { title: "x" } })
      )
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await rejection(db.post.delete({ where: { id: "p1" } }))
    ).toBeInstanceOf(ForbiddenError);
    expect(await base.post.findMany({})).toEqual([
      { id: "p1", title: "one", ownerId: "u1" },
    ]);
  });
});
