import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const duplicateTables = () => {
  const user = s.model({ id: s.string().id() }).map("people");
  const member = s.model({ id: s.string().id() }).map("people");
  return { user, member };
};

describe("skipSchemaValidation", () => {
  test("a skipping client still resolves relations and runs queries", async () => {
    const author = s.model({
      id: s.int().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.int().id(),
      authorId: s.int(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    });
    const driver = new SQLite3Driver();
    const client = createClient({
      schema: { author, post },
      driver,
      skipSchemaValidation: true,
    });
    try {
      await driver._executeRaw(
        'CREATE TABLE "author" ("id" INTEGER PRIMARY KEY)'
      );
      await driver._executeRaw(
        'CREATE TABLE "post" ("id" INTEGER PRIMARY KEY, "authorId" INTEGER)'
      );
      await client.author.create({ data: { id: 1 } });
      await client.post.create({ data: { id: 2, authorId: 1 } });
      await expect(
        client.post.findMany({ include: { author: true } })
      ).resolves.toEqual([{ id: 2, authorId: 1, author: { id: 1 } }]);
    } finally {
      await driver.disconnect();
    }
  });

  test("skips the checks, and a validating client of the same schema still runs them", () => {
    const schema = duplicateTables();
    expect(() => createClient({ schema, driver: new SQLite3Driver() })).toThrow(
      /M004|people/
    );
    expect(() =>
      createClient({
        schema,
        driver: new SQLite3Driver(),
        skipSchemaValidation: true,
      })
    ).not.toThrow();
    expect(() => createClient({ schema, driver: new SQLite3Driver() })).toThrow(
      /M004|people/
    );
  });
});
