/**
 * The core options a provider entry passes through: `skipSchemaValidation`
 * and `findUniqueBatching` given to a provider's `createClient` reach the
 * client.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
});
const schema = { post };

type Row = Record<string, unknown>;
interface Loose {
  post: {
    create(args: object): Promise<Row>;
    findMany(args?: object): Promise<Row[]>;
    findUnique(args: object): Promise<Row | null>;
  };
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(options: object = {}): Promise<Loose> {
  const client = createClient({
    schema,
    dataDir: ":memory:",
    ...options,
  } as never) as never as Loose;
  opened.push(client);
  await syncLiveSchema(client as never);
  await client.post.create({ data: { id: "p1", title: "a", secret: "s" } });
  return client;
}

describe("core options through a provider's createClient", () => {
  test("skipSchemaValidation and findUniqueBatching reach the client", async () => {
    const db = await seeded({
      skipSchemaValidation: true,
      findUniqueBatching: true,
    });
    const [one, two] = await Promise.all([
      db.post.findUnique({ where: { id: "p1" } }),
      db.post.findUnique({ where: { id: "nope" } }),
    ]);
    expect(one).toEqual({ id: "p1", title: "a", secret: "s" });
    expect(two).toBeNull();
  });
});
