/**
 * N5 — one named EXCLUSIVE target membership, applied to many captured rows.
 *
 * A target whose membership is stored once — a junction row unique on the
 * target side, or a reference the TARGET row holds — belongs to exactly one of
 * the rows an `updateMany` captured, so `connect` / `set` / `connectOrCreate`
 * across more than one of them is not executable by any owner: applied in
 * sequence the last row takes the target from the others. This re-expresses
 * the retired engine's two registered sentences
 * (`query-engine/relation-key-legality.ts:145` and `:149` at `e8114ed9d^`) at
 * the one site that holds the observed count, because D-52 keeps a refusal
 * naming an execution fact — cardinality — no owner can execute around.
 *
 * WHERE it is stated is where that count is first known, which is not ahead of
 * every write: a capture flushes, and on the batch route a flush commits what
 * is queued before it, so an enclosing parent's OWN segment is durable when
 * the refusal fires. Both routes answer with the same sentence and write
 * nothing of the member it names; they differ only in what stands committed
 * behind it (D-51's succession of segments), which the last refusal cell pins.
 *
 * At the base every refusal cell here resolved `{ count: 2 }`, wrote the
 * scalar to BOTH rows and left the membership on whichever ran last.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

const warehouse = s
  .model({
    id: s.string().id(),
    /** The enclosing parent's OWN scalar: what its segment commits. */
    tag: s.string().default("before"),
    shelves: s.toMany(() => shelf),
  })
  .map("n5x_warehouses");
const shelf = s
  .model({
    id: s.string().id(),
    label: s.string(),
    warehouseId: s.string().nullable(),
    warehouse: s
      .toOne(() => warehouse)
      .fields("warehouseId")
      .references("id"),
    // A junction whose TARGET side is unique exists only as a variant
    // carrier's arm: an ordinary to-one against a to-many is a foreign key
    // (FK004), so the singular-junction sentence is reached through a
    // polymorphic collection whose `book` arm has a to-one inverse.
    items: s
      .toMany(
        { book: () => book, video: () => video },
        { values: { book: "n5x.book.v1", video: "n5x.video.v1" } }
      )
      .through({
        book: { table: "n5x_shelf_books", source: "holder", target: "entry" },
        video: { table: "n5x_shelf_videos", source: "holder", target: "entry" },
      }),
    // CHILD-HELD: the membership is stored on the page row.
    pages: s.toMany(() => page),
  })
  .map("n5x_shelves");
const book = s
  .model({
    id: s.string().id(),
    title: s.string(),
    // SINGULAR inverse: at most one shelf holds a book.
    shelf: s.toOne(() => shelf),
  })
  .map("n5x_books");
const video = s
  .model({
    id: s.string().id(),
    // PLURAL inverse: an ordinary membership, many shelves per video.
    shelves: s.toMany(() => shelf),
  })
  .map("n5x_videos");
const page = s
  .model({
    id: s.string().id(),
    shelfId: s.string().nullable(),
    shelf: s
      .toOne(() => shelf)
      .fields("shelfId")
      .references("id"),
  })
  .map("n5x_pages");
const schema = { book, page, shelf, video, warehouse };

const junctionHeld = (verb: string, relation: string) =>
  `UnsupportedOperationError: updateMany matched 2 rows, so it cannot apply '${verb}' to relation '${relation}': that target's member-junction slot can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`;
const targetRowHeld = (verb: string, relation: string) =>
  `UnsupportedOperationError: updateMany matched 2 rows, so it cannot apply '${verb}' to relation '${relation}': that membership is stored on the target row, which can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`;

const labels = async (client: any) =>
  (await client.shelf.findMany({ orderBy: { id: "asc" } })).map(
    (row: { label: string }) => row.label
  );
/** Every shelf's collection, as `<shelf>/<arm>:<target id>`. */
const memberships = async (client: any) =>
  (
    await client.shelf.findMany({
      orderBy: { id: "asc" },
      include: { items: true },
    })
  ).flatMap((row: any) =>
    row.items.map(
      (item: { type: string; data: { id: string } }) =>
        `${row.id}/${item.type}:${item.data.id}`
    )
  );
/** The scalar and the memberships together: what "nothing was written" reads. */
const state = async (client: any) => ({
  items: await memberships(client),
  labels: await labels(client),
});
const UNTOUCHED = { items: [], labels: ["left", "right"] };
/** What an operation answered, as `<class>: <message>` or its resolved value. */
const answer = async (operation: PromiseLike<unknown>) => {
  const outcome = await Promise.resolve(operation).catch(
    (error: unknown) => error
  );
  return outcome instanceof Error
    ? `${outcome.name}: ${outcome.message}`
    : `resolved ${JSON.stringify(outcome)}`;
};

for (const [route, make] of [
  ["live", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchOnlyDriver()],
] as const) {
  describe(`N5: an exclusive member across two matched rows, ${route}`, () => {
    let driver: RecordingSQLiteDriver | undefined;
    afterEach(async () => {
      await driver?.disconnect();
      driver = undefined;
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.warehouse.create({ data: { id: "w1" } });
      for (const id of ["left", "right"])
        await client.shelf.create({
          data: { id, label: id, warehouseId: "w1" },
        });
      await client.book.create({ data: { id: "b1", title: "Book one" } });
      await client.video.create({ data: { id: "v1" } });
      await client.page.create({ data: { id: "p1" } });
      return client;
    }
    it("a root updateMany refuses a singular junction member before writing", async () => {
      const client = await world();
      assert.equal(
        await answer(
          client.shelf.updateMany({
            where: { warehouseId: "w1" },
            data: {
              label: "must not write",
              items: { connect: [{ type: "book", where: { id: "b1" } }] },
            },
          })
        ),
        junctionHeld("connect", "items")
      );
      assert.deepEqual(await state(client), UNTOUCHED);
    });

    it("a NESTED updateMany reaches the same refusal", async () => {
      const client = await world();
      assert.equal(
        await answer(
          client.warehouse.update({
            where: { id: "w1" },
            data: {
              shelves: {
                updateMany: [
                  {
                    where: {},
                    data: {
                      label: "must not write",
                      items: {
                        connect: [{ type: "book", where: { id: "b1" } }],
                      },
                    },
                  },
                ],
              },
            },
          })
        ),
        junctionHeld("connect", "items")
      );
      assert.deepEqual(await state(client), UNTOUCHED);
    });

    it("`set` and `connectOrCreate` reach it with their own verb, and create nothing", async () => {
      const client = await world();
      assert.equal(
        await answer(
          client.shelf.updateMany({
            where: { warehouseId: "w1" },
            data: {
              label: "must not write",
              items: { set: [{ type: "book", where: { id: "b1" } }] },
            },
          })
        ),
        junctionHeld("set", "items")
      );
      assert.equal(
        await answer(
          client.shelf.updateMany({
            where: { warehouseId: "w1" },
            data: {
              label: "must not write",
              items: {
                connectOrCreate: [
                  {
                    type: "book",
                    where: { id: "b2" },
                    create: { id: "b2", title: "never" },
                  },
                ],
              },
            },
          })
        ),
        junctionHeld("connectOrCreate", "items")
      );
      assert.deepEqual(await state(client), UNTOUCHED);
      assert.deepEqual(
        (await client.book.findMany({ orderBy: { id: "asc" } })).map(
          (row: { id: string }) => row.id
        ),
        ["b1"]
      );
    });

    it("a CHILD-HELD membership is refused in its own words", async () => {
      const client = await world();
      assert.equal(
        await answer(
          client.shelf.updateMany({
            where: { warehouseId: "w1" },
            data: {
              label: "must not write",
              pages: { connect: [{ id: "p1" }] },
            },
          })
        ),
        targetRowHeld("connect", "pages")
      );
      assert.deepEqual(await state(client), UNTOUCHED);
      assert.equal(
        (await client.page.findUnique({ where: { id: "p1" } }))?.shelfId,
        null
      );
    });

    it("an enclosing parent's own SET is durable on the batch route when the refusal fires, and rolled back on the live one", async () => {
      const client = await world();
      assert.equal(
        await answer(
          client.warehouse.update({
            where: { id: "w1" },
            data: {
              tag: "must-not-write",
              shelves: {
                updateMany: [
                  {
                    where: {},
                    data: {
                      items: {
                        connect: [{ type: "book", where: { id: "b1" } }],
                      },
                    },
                  },
                ],
              },
            },
          })
        ),
        junctionHeld("connect", "items")
      );
      // The refusal is stated where the observed count is FIRST KNOWN — the
      // capture that reads it — and a capture FLUSHES: on the batch route that
      // flush has already committed the enclosing parent's own segment, so the
      // parent's SET stands and no refusal can take it back. The two routes
      // answer with the SAME sentence and differ only in what is committed
      // behind it (D-51's succession of segments); the live route holds one
      // transaction and rolls the SET back. Neither route writes anything of
      // the member the refusal names.
      assert.equal(
        (await client.warehouse.findUnique({ where: { id: "w1" } }))?.tag,
        route === "live" ? "before" : "must-not-write"
      );
      assert.deepEqual(await state(client), UNTOUCHED);
    });

    it("ONE matched row takes the same member, and a PLURAL member takes two", async () => {
      const client = await world();
      assert.deepEqual(
        await client.shelf.updateMany({
          where: { id: "left" },
          data: { items: { connect: [{ type: "book", where: { id: "b1" } }] } },
        }),
        { count: 1 }
      );
      assert.deepEqual(await memberships(client), ["left/book:b1"]);
      assert.deepEqual(
        await client.shelf.updateMany({
          where: { warehouseId: "w1" },
          data: {
            items: { connect: [{ type: "video", where: { id: "v1" } }] },
          },
        }),
        { count: 2 }
      );
      assert.deepEqual(await memberships(client), [
        "left/book:b1",
        "left/video:v1",
        "right/video:v1",
      ]);
    });

    it("an EMPTY connect, connectOrCreate or set names no target and is written", async () => {
      const client = await world();
      assert.deepEqual(
        await client.shelf.updateMany({
          where: { warehouseId: "w1" },
          data: {
            label: "written",
            items: { connect: [], connectOrCreate: [], set: [] },
          },
        }),
        { count: 2 }
      );
      assert.deepEqual(await labels(client), ["written", "written"]);
      assert.deepEqual(await memberships(client), []);
    });
  });
}
