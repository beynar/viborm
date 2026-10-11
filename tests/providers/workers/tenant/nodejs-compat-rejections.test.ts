/**
 * Under `nodejs_compat`, workerd reports a promise that is rejected while it
 * has no handler as an unhandled rejection, even when a handler arrives a
 * microtask later; Node does not. A refusal the engine raises before any I/O
 * must therefore reach its caller on the promise the caller holds, never on a
 * promise an `async` frame adopts later. This project runs with the flag the
 * tenant migrator needs; provider-d1 runs without it.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@src/drivers/d1";
import { s } from "@src/schema";
import { expect, it } from "vitest";

const author = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.toMany(() => post),
  })
  .map("authors");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

it("a V8003 refusal on D1 leaves no rejection without a handler", async () => {
  const touched: string[] = [];
  const database = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(String(property));
        throw new Error(
          `the refusal touched the database: ${String(property)}`
        );
      },
    }
  ) as unknown as D1Database;
  const client = createClient({ schema: { author, post }, database });
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    await expect(
      client.post.createMany({
        data: [
          {
            id: "p1",
            title: "first",
            author: { create: { id: "a1", name: "Ada" } },
          },
        ],
        skipDuplicates: true,
      })
    ).rejects.toMatchObject({ code: "V8003" });
    // workerd reports from a later task: give it one.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", record);
  }
  expect({ touched, unhandled }).toEqual({ touched: [], unhandled: [] });
});
