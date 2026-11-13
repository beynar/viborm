import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * A call that already knows a row is asked for it again, by a value it holds.
 * What the call knows is the row as it was read; what the question says is
 * the value as the caller spelled it. Two spellings of one value are one
 * value: where the call cannot tell, the database answers.
 */
const schema = (() => {
  const shelf = s
    .model({
      id: s.string().id(),
      books: s.toMany(() => book),
    })
    .map("krv_shelves");
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      at: s.dateTime(),
      day: s.date(),
      price: s.decimal({ precision: 10, scale: 2 }),
      rating: s.number(),
      shelfId: s.string().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id"),
    })
    .map("krv_books");
  return { shelf, book };
})();

const AT = "2026-01-02T03:04:05.000Z";

const drivers = {
  SQLite: () => new SQLite3Driver({ dataDir: ":memory:" }),
  PGlite: () => new PGliteDriver({ client: new PGlite() }),
};

for (const [name, makeDriver] of Object.entries(drivers))
  describe(`a known row asked again by a value it holds (${name})`, () => {
    const spellings: [string, Record<string, unknown>][] = [
      ["an instant as a Date", { at: new Date(AT) }],
      ["an instant without its milliseconds", { at: "2026-01-02T03:04:05Z" }],
      ["an instant at another offset", { at: "2026-01-02T04:04:05+01:00" }],
      ["a day as text", { day: "2026-01-02" }],
      ["a day as a Date", { day: new Date("2026-01-02T00:00:00.000Z") }],
      ["a decimal with a trailing zero", { price: "12.50" }],
      ["a decimal without one", { price: "12.5" }],
      ["a number", { rating: 4.5 }],
      ["a string", { title: "Draft" }],
    ];
    for (const [label, held] of spellings)
      test(`finds it by ${label}`, async () => {
        const client = createClient({ schema, driver: makeDriver() });
        try {
          await push(client, { force: true });
          await client.shelf.create({
            data: {
              id: "s1",
              books: {
                create: {
                  id: "b1",
                  title: "Draft",
                  at: AT,
                  day: "2026-01-02",
                  price: "12.50",
                  rating: 4.5,
                },
              },
            },
          });
          await client.shelf.update({
            where: { id: "s1" },
            data: {
              books: {
                update: [
                  // Read whole: its filter is no key.
                  {
                    where: { id: "b1", NOT: { title: "Other" } },
                    data: { title: "Draft" },
                  },
                  { where: { id: "b1", ...held }, data: { title: "Found" } },
                ],
              },
            },
          });
          const book = await client.book.findUnique({ where: { id: "b1" } });
          expect(book?.title).toBe("Found");
        } finally {
          await client.$disconnect();
        }
      });

    test("does not find it by a value it does not hold", async () => {
      const client = createClient({ schema, driver: makeDriver() });
      try {
        await push(client, { force: true });
        await client.shelf.create({
          data: {
            id: "s1",
            books: {
              create: {
                id: "b1",
                title: "Draft",
                at: AT,
                day: "2026-01-02",
                price: "12.50",
                rating: 4.5,
              },
            },
          },
        });
        for (const held of [
          { at: "2026-01-02T03:04:06.000Z" },
          { day: "2026-01-03" },
          { price: "12.51" },
          { title: "draft" },
        ])
          await expect(
            client.shelf.update({
              where: { id: "s1" },
              data: {
                books: {
                  update: [
                    {
                      where: { id: "b1", NOT: { title: "Other" } },
                      data: { title: "Draft" },
                    },
                    { where: { id: "b1", ...held }, data: { title: "Found" } },
                  ],
                },
              },
            })
          ).rejects.toThrow("target record was not found");
      } finally {
        await client.$disconnect();
      }
    });
  });
