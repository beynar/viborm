/**
 * A unique `where` holding a `null` names no row in particular: a unique index
 * admits any number of NULLs, so `{ code: null }`, or a compound selector with
 * a `null` member, matches every row whose value is NULL. Before 1.4.1 a root
 * `update` or `delete` wrote all of them, and 1.4.0's nested `update` (its
 * root UPDATE locating its own row) did too. Every such call is now refused
 * as invalid, before any statement runs, in every unique position, and the
 * types refuse `null` there too, as Prisma's do.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { ValidationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeAll, describe, expect, test } from "vitest";

const box = s
  .model({
    id: s.int().id(),
    code: s.string().nullable().unique(),
    a: s.int(),
    b: s.string().nullable(),
    label: s.string(),
    notes: s.toMany(() => note),
  })
  .unique(["a", "b"])
  .map("nus_boxes");
const note = s
  .model({
    id: s.int().id(),
    boxId: s.int().nullable(),
    box: s
      .toOne(() => box)
      .fields("boxId")
      .references("id"),
  })
  .map("nus_notes");
const schema = { box, note };

beforeAll(() => hydrateSchemaNames(schema));
const getFamily = usePGliteSchemaFamily(schema);

/** One loose client over both substrates. */
type Client = any;

const SUBSTRATES = [
  [
    "PGlite",
    async (): Promise<Client> => {
      const family = getFamily();
      await family.reset();
      return createClient({
        schema,
        driver: new PGliteDriver({
          client: family.database,
          namespace: family.namespace,
        }),
      });
    },
  ],
  [
    "SQLite3",
    async (): Promise<Client> => {
      const client = createClient({
        schema,
        driver: new SQLite3Driver({ dataDir: ":memory:" }),
      });
      await syncLiveSchema(client);
      return client;
    },
  ],
] as const;

async function boot(make: () => Promise<Client>): Promise<Client> {
  const client = await make();
  await client.box.createMany({
    data: [
      { id: 1, code: null, a: 1, b: null, label: "one" },
      { id: 2, code: null, a: 1, b: null, label: "two" },
    ],
  });
  await client.note.create({ data: { id: 9 } });
  return client;
}

const labels = async (client: Client) =>
  (await client.box.findMany({ orderBy: { id: "asc" } })).map(
    (row: { label: string }) => row.label
  );

describe.each(SUBSTRATES)("%s", (_, make) => {
  test.each([
    ["update", { where: { code: null }, data: { label: "x" } }],
    ["update", { where: { a_b: { a: 1, b: null } }, data: { label: "x" } }],
    [
      "update",
      {
        where: { a_b: { a: 1, b: null } },
        data: { label: "x", notes: { create: { id: 5 } } },
      },
    ],
    ["delete", { where: { code: null } }],
    ["delete", { where: { a_b: { a: 1, b: null } } }],
    [
      "upsert",
      {
        where: { code: null },
        create: { id: 3, a: 2, label: "c" },
        update: { label: "x" },
      },
    ],
    ["findUnique", { where: { code: null } }],
  ])("%s %j is refused and writes nothing", async (verb, args) => {
    const client = await boot(make);
    await expect(client.box[verb](args)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(await labels(client)).toEqual(["one", "two"]);
    expect(await client.note.count()).toBe(1);
  });

  test("a nested connect by a null unique is refused and links nothing", async () => {
    const client = await boot(make);
    await expect(
      client.note.update({
        where: { id: 9 },
        data: { box: { connect: { code: null } } },
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await client.note.findUnique({ where: { id: 9 } })).toMatchObject({
      boxId: null,
    });
  });

  test("a null beside a selector that names the row is refused too", async () => {
    const client = await boot(make);
    await expect(
      client.box.update({ where: { id: 2, code: null }, data: { label: "x" } })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await labels(client)).toEqual(["one", "two"]);
  });
});
