/**
 * Cold-start benchmarks.
 *
 * Serverless (Cloudflare Workers) pays schema definition + createClient on
 * every new isolate. This measures that init cost — module import cost is
 * tracked separately by `pnpm size`.
 *
 * Run: pnpm bench
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { bench, describe } from "vitest";

const defineSchema = () => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string().nullable(),
      email: s.string().unique(),
      age: s.int().nullable(),
      posts: s.oneToMany(() => post),
    })
    .map("users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts");

  return { user, post };
};

describe("cold start (per serverless isolate)", () => {
  bench("define schema (2 models)", () => {
    defineSchema();
  });

  bench("define schema + createClient", () => {
    createClient({
      schema: defineSchema(),
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });
  });
});
