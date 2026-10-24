/**
 * On the batch route (D1, Neon HTTP) a nested write's lookups read outside
 * the queue, so a lookup that may see an earlier write of the same call must
 * wait for it (`Commands.#readTarget`, the dependency pass). A `connect`
 * whose target holds the key or sits behind a junction was exempt: its lookup
 * read the rows as they were before the call, and linked a row an earlier
 * nested update had renamed away, or failed on the foreign key instead of the
 * missing target (1.0 to 1.4.1). Every case runs on both routes and must
 * answer alike.
 */

import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { beforeAll, describe, expect, test } from "vitest";

const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    items: s.toMany(() => item).name("owned"),
    liked: s.toMany(() => item).name("liked"),
  })
  .map("brd_owners");
const item = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => owner)
      .name("owned")
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    likers: s.toMany(() => owner).name("liked"),
  })
  .map("brd_items");
const schema = { owner, item };

beforeAll(() => hydrateSchemaNames(schema));

class RecordingSQLite3 extends SQLite3Driver {
  statements: string[] | undefined;
  constructor() {
    super({ dataDir: ":memory:" });
  }
  protected override execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements?.push(sql);
    return super.execute<T>(client, sql, params, context);
  }
}
class BatchRecordingSQLite3 extends RecordingSQLite3 {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    client.exec("BEGIN");
    try {
      const results = await super.executeBatch<T>(client, queries);
      client.exec("COMMIT");
      return results;
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    }
  }
}

type Client = any;
async function boot(driver: RecordingSQLite3): Promise<Client> {
  const client = createClient({ schema, driver });
  await syncLiveSchema(client);
  await client.owner.createMany({
    data: [
      { id: 1, name: "o1" },
      { id: 2, name: "o2" },
    ],
  });
  await client.item.createMany({
    data: [
      { id: 1, code: "x", ownerId: 1 },
      { id: 2, code: "w", ownerId: 1 },
      { id: 3, code: "y" },
      { id: 4, code: "v" },
    ],
  });
  return client;
}
const liked = async (client: Client, id = 1) =>
  (
    await client.owner.findUnique({
      where: { id },
      select: { liked: { select: { id: true }, orderBy: { id: "asc" } } },
    })
  ).liked.map((row: { id: number }) => row.id);

const SUBSTRATES = [
  ["interactive", () => new RecordingSQLite3()],
  ["batch", () => new BatchRecordingSQLite3()],
] as const;

/** The call's rejection, as `NestedWriteError` or the unexpected value. */
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => "resolved",
    (error: unknown) => (error instanceof NestedWriteError ? "nested" : error)
  );

describe.each(SUBSTRATES)("%s", (_name, make) => {
  test("a connect by a unique an earlier nested update rewrote links the row holding it now", async () => {
    const client = await boot(make());
    await client.owner.update({
      where: { id: 1 },
      data: {
        items: {
          update: [
            { where: { id: 1 }, data: { code: "z" } },
            { where: { id: 2 }, data: { code: "x" } },
          ],
        },
        liked: { connect: [{ code: "x" }, { code: "y" }] },
      },
    });
    expect(await liked(client)).toEqual([2, 3]);
  });

  test("a single connect by a rewritten unique links the row holding it now", async () => {
    const client = await boot(make());
    await client.owner.update({
      where: { id: 1 },
      data: {
        items: {
          update: [
            { where: { id: 1 }, data: { code: "z" } },
            { where: { id: 2 }, data: { code: "x" } },
          ],
        },
        liked: { connect: { code: "x" } },
      },
    });
    expect(await liked(client)).toEqual([2]);
  });

  test("a child-held connect by a rewritten unique, on the same relation", async () => {
    const client = await boot(make());
    await client.owner.update({
      where: { id: 2 },
      data: { items: { connect: [{ code: "y" }] } },
    });
    await client.owner.update({
      where: { id: 1 },
      data: {
        items: {
          update: [
            { where: { id: 1 }, data: { code: "z" } },
            { where: { id: 2 }, data: { code: "x" } },
          ],
          connect: [{ code: "x" }, { code: "v" }],
        },
      },
    });
    const rows = await client.item.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row: any) => [row.id, row.code, row.ownerId])).toEqual([
      [1, "z", 1],
      [2, "x", 1],
      [3, "y", 2],
      [4, "v", 1],
    ]);
  });

  test("a junction connect of a row an earlier nested delete removed fails as a missing target", async () => {
    const client = await boot(make());
    await client.owner.update({
      where: { id: 1 },
      data: { liked: { connect: [{ id: 1 }] } },
    });
    expect(
      await refusal(
        client.owner.update({
          where: { id: 1 },
          data: {
            liked: { delete: [{ id: 1 }], connect: [{ id: 1 }, { id: 3 }] },
          },
        })
      )
    ).toBe("nested");
    expect(await liked(client)).toEqual([1]);
  });

  test("a junction connect of a key an earlier nested update renamed fails as a missing target", async () => {
    const client = await boot(make());
    await client.owner.update({
      where: { id: 1 },
      data: { liked: { connect: [{ id: 1 }] } },
    });
    expect(
      await refusal(
        client.owner.update({
          where: { id: 1 },
          data: {
            liked: {
              update: { where: { id: 1 }, data: { id: 50 } },
              connect: [{ id: 1 }, { id: 3 }],
            },
          },
        })
      )
    ).toBe("nested");
    expect(await liked(client)).toEqual([1]);
  });

  test("a junction connect of a row another relation's delete removed fails as a missing target", async () => {
    const client = await boot(make());
    expect(
      await refusal(
        client.owner.update({
          where: { id: 1 },
          data: {
            items: { delete: [{ id: 1 }] },
            liked: { connect: [{ id: 1 }, { id: 3 }] },
          },
        })
      )
    ).toBe("nested");
    expect(await liked(client)).toEqual([]);
  });
});
