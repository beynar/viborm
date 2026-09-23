import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";
import type { Pool as MySQLPool, PoolConnection } from "mysql2/promise";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

class Observed extends MySQL2Driver {
  readonly seen: { sql: string; params: unknown[] }[] = [];
  protected override async execute<T>(
    client: MySQLPool | PoolConnection,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.seen.push({ sql, params: [...params] });
    return await super.execute<T>(client, sql, params, context);
  }
}

describe.runIf(provider === "mysql" && port > 0)("probe", () => {
  it("shipped vs candidate key lookup spelling", async () => {
    const authors = `zz_a_${randomUUID().replaceAll("-", "")}`;
    const posts = `zz_p_${randomUUID().replaceAll("-", "")}`;
    const author = s
      .model({
        id: s.string().id(),
        email: s.string().unique(),
        name: s.string(),
        posts: s.toMany(() => post),
      })
      .map(authors);
    const post = s
      .model({
        id: s.string().id(),
        title: s.string(),
        authorId: s.string(),
        author: s.toOne(() => author).fields("authorId").references("id"),
      })
      .map(posts);
    const schema = { author, post };
    const mk = () =>
      new Observed({
        options: {
          host: "127.0.0.1",
          port,
          database: "raptor3_g2",
          user: "root",
          password: "",
          connectionLimit: 2,
          connectTimeout: 10_000,
        },
      });
    const setup = mk();
    await setup._executeRaw(
      `CREATE TABLE ${authors} (id VARCHAR(191) PRIMARY KEY NOT NULL, email VARCHAR(191) NOT NULL UNIQUE, name VARCHAR(191) NOT NULL)`
    );
    await setup._executeRaw(
      `CREATE TABLE ${posts} (id VARCHAR(191) PRIMARY KEY NOT NULL, title VARCHAR(191) NOT NULL, authorId VARCHAR(191) NOT NULL, FOREIGN KEY(authorId) REFERENCES ${authors}(id))`
    );
    const collation = await setup._executeRaw(
      `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${authors}'`
    );
    console.log("COLLATION", JSON.stringify(collation.rows));
    await setup._executeRaw(
      `INSERT INTO ${authors} (id, email, name) VALUES ('wanted','claim@x','winner')`
    );
    const report = async (
      label: string,
      run: (d: Observed) => Promise<unknown>
    ) => {
      const d = mk();
      let out: unknown;
      try {
        out = { ok: await run(d) };
      } catch (error) {
        out = { err: `${(error as Error).name}: ${(error as Error).message}` };
      }
      console.log(`--- ${label}`, JSON.stringify(out));
      for (const q of d.seen) console.log("   ", q.sql, JSON.stringify(q.params));
      await d.disconnect?.();
    };
    await report("shipped findUnique exact", (d) =>
      createClient({ schema, driver: d }).author.findUnique({ where: { id: "wanted" } })
    );
    await report("shipped findUnique CASE", (d) =>
      createClient({ schema, driver: d }).author.findUnique({ where: { id: "WANTED" } })
    );
    await report("candidate findUnique CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("author", "findUnique", {
        where: { id: "WANTED" },
      })
    );
    await report("shipped findFirst CASE", (d) =>
      createClient({ schema, driver: d }).author.findFirst({ where: { name: "WINNER" } })
    );
    await report("candidate findFirst CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("author", "findFirst", {
        where: { name: "WINNER" },
      })
    );
    await report("shipped findFirst by KEY CASE", (d) =>
      createClient({ schema, driver: d }).author.findFirst({ where: { id: "WANTED" } })
    );
    await report("candidate findFirst by KEY CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("author", "findFirst", {
        where: { id: "WANTED" },
      })
    );
    await report("shipped findMany by KEY CASE", (d) =>
      createClient({ schema, driver: d }).author.findMany({ where: { id: "WANTED" } })
    );
    await report("shipped findUnique EXTENDED", (d) =>
      createClient({ schema, driver: d }).author.findUnique({
        where: { id: "WANTED", name: { not: "zz" } },
      })
    );
    await report("candidate findUnique EXTENDED", (d) =>
      createCommandEngine({ schema, driver: d }).execute("author", "findUnique", {
        where: { id: "WANTED", name: { not: "zz" } },
      })
    );
    await report("shipped findUnique by UNIQUE email CASE", (d) =>
      createClient({ schema, driver: d }).author.findUnique({ where: { email: "CLAIM@X" } })
    );
    await report("candidate findUnique by UNIQUE email CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("author", "findUnique", {
        where: { email: "CLAIM@X" },
      })
    );
    await report("shipped update by KEY CASE", (d) =>
      createClient({ schema, driver: d }).author.update({
        where: { id: "WANTED" },
        data: { name: "winner" },
      })
    );
    await report("candidate update by KEY CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("author", "update", {
        where: { id: "WANTED" },
        data: { name: "winner" },
      })
    );
    await report("shipped connect CASE", (d) =>
      createClient({ schema, driver: d }).post.create({
        data: {
          id: `p3-${randomUUID().slice(0, 6)}`,
          title: "T",
          author: { connect: { id: "WANTED" } },
        },
        select: { id: true, authorId: true },
      })
    );
    await report("candidate connect CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("post", "create", {
        data: {
          id: `p4-${randomUUID().slice(0, 6)}`,
          title: "T",
          author: { connect: { id: "WANTED" } },
        },
        select: { id: true, authorId: true },
      })
    );
    await report("shipped connectOrCreate CASE", (d) =>
      createClient({ schema, driver: d }).post.create({
        data: {
          id: `p1-${randomUUID().slice(0, 6)}`,
          title: "T",
          author: {
            connectOrCreate: {
              where: { id: "WANTED" },
              create: { id: "WANTED", email: `e${randomUUID().slice(0, 6)}@x`, name: "n" },
            },
          },
        },
        select: { id: true, authorId: true },
      })
    );
    await report("candidate connectOrCreate CASE", (d) =>
      createCommandEngine({ schema, driver: d }).execute("post", "create", {
        data: {
          id: `p2-${randomUUID().slice(0, 6)}`,
          title: "T",
          author: {
            connectOrCreate: {
              where: { id: "WANTED" },
              create: { id: "WANTED", email: `e${randomUUID().slice(0, 6)}@x`, name: "n" },
            },
          },
        },
        select: { id: true, authorId: true },
      })
    );
    const rows = await setup._executeRaw(`SELECT * FROM ${authors} ORDER BY id`);
    console.log("FINAL AUTHORS", JSON.stringify(rows.rows));
    await setup._executeRaw(`DROP TABLE ${posts}`);
    await setup._executeRaw(`DROP TABLE ${authors}`);
    await setup.disconnect?.();
    assert.ok(true);
  }, 60_000);
});
