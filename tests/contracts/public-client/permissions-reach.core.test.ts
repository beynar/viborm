/**
 * viborm/permissions at the edges of what a policy reaches: a rule that
 * reads another model's rows (`$exists`), a field write grant on a model
 * that grants no update, a raw statement on a governed client, and a
 * declaration the compiler refuses.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError, ForbiddenError } from "@errors";
import { s } from "@schema";
import { sql } from "@src/index";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
});
const member = s.model({ id: s.string().id(), userId: s.string() });
const schema = { post, member };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
}
interface Loose {
  post: Delegate;
  member: Delegate;
  $extends(definition: unknown): Loose;
  $as(actor: unknown): Loose;
  $queryRaw(query: unknown): Promise<Row[]>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(): Promise<Loose> {
  const client = createClient({
    schema,
    dataDir: ":memory:",
  }) as never as Loose;
  opened.push(client);
  await syncLiveSchema(client as never);
  await client.post.create({ data: { id: "p1", title: "one", ownerId: "u1" } });
  await client.post.create({ data: { id: "p2", title: "two", ownerId: "u2" } });
  await client.member.create({ data: { id: "m1", userId: "u1" } });
  return client;
}

const actor = v.object({ userId: v.string() });

describe("a rule that reads another model's rows", () => {
  test("$exists grants a read while some row of the named model matches", async () => {
    const base = await seeded();
    const governed = base.$extends(
      permissions({
        actor,
        models: {
          post: {
            read: { $exists: { member: { userId: { actor: "userId" } } } },
          },
          member: { read: {} },
        },
      } as never)
    );
    const ids = async (userId: string) =>
      (await governed.$as({ userId }).post.findMany({})).map((row) => row.id);
    expect(await ids("u1")).toEqual(["p1", "p2"]);
    expect(await ids("u2")).toEqual([]);
    await base.member.create({ data: { id: "m2", userId: "u2" } });
    expect(await ids("u2")).toEqual(["p1", "p2"]);
  });
});

describe("a field write grant narrows the update grant", () => {
  test("on a model that grants no update, a field's own write grant writes nothing", async () => {
    const governed = (await seeded())
      .$extends(
        permissions({
          actor,
          models: {
            post: {
              actions: { read: [], full: ["read"] },
              full: {},
              fields: { title: { write: "full" } },
            },
          },
        } as never)
      )
      .$as({ userId: "u1" });
    // The model compiles with the field's grant, and still reads.
    expect((await governed.post.findMany({})).length).toBe(2);
    const refused = await governed.post
      .update({ where: { id: "p1" }, data: { title: "changed" } })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForbiddenError);
  });
});

describe("what the policy does not judge", () => {
  test("a raw statement on a governed client is not refused as a model call", async () => {
    const governed = (await seeded())
      .$extends(permissions({ actor, models: { post: { read: {} } } } as never))
      .$as({ userId: "u1" });
    expect(await governed.$queryRaw(sql`SELECT 1 AS one`)).toEqual([
      { one: 1 },
    ]);
    // A model the policy does not list is still refused.
    await expect(governed.member.findMany({})).rejects.toThrow(ForbiddenError);
  });

  test("a declaration the compiler refuses is refused where it is applied, not where it is written", async () => {
    const declaration = {
      actor,
      models: { post: { read: {}, actions: { "read,write": [] } } },
    };
    const policy = permissions(declaration as never);
    const base = await seeded();
    let refused: unknown;
    try {
      base.$extends(policy);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ClientInitializationError);
    expect((refused as Error).message).toContain(
      '"read,write" is not an individual action'
    );
  });
});
