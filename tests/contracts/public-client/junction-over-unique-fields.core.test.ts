import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, expect, test } from "vitest";

const reader = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  books: s.toMany(() => book),
});
const link = s
  .model({
    email: s.string(),
    isbn: s.string(),
    reader: s
      .toOne(() => reader)
      .fields("email")
      .references("email"),
    book: s
      .toOne(() => book)
      .fields("isbn")
      .references("isbn"),
  })
  .id(["email", "isbn"]);
const book = s.model({
  id: s.string().id(),
  isbn: s.string().unique(),
  readers: s
    .toMany(() => reader)
    .through(() => link)
    .source("book")
    .target("reader"),
});
const schema = { reader, book, link };

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

// A junction row holds the fields its relations reference: here a unique
// field of each side, not its key.
test("a member connected by its key joins a junction that references a unique field", async () => {
  const db = createClient({ schema, driver: createInMemorySQLite3Driver() });
  clients.push(db);
  await syncLiveSchema(db);
  await db.reader.create({ data: { id: "r", email: "e" } });
  await db.book.create({
    data: { id: "b", isbn: "i", readers: { connect: { id: "r" } } },
  });
  expect(await db.link.findMany()).toEqual([{ email: "e", isbn: "i" }]);
  expect(
    await db.book.findUnique({ where: { id: "b" }, include: { readers: true } })
  ).toEqual({ id: "b", isbn: "i", readers: [{ id: "r", email: "e" }] });
  await db.book.update({ where: { id: "b" }, data: { readers: { set: [] } } });
  expect(await db.link.count()).toBe(0);
});
