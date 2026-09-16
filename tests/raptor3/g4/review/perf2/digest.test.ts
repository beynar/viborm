/**
 * INDEPENDENT REVIEW — cross-tree behaviour digest for G4 perf pass 2.
 *
 * Runs the same scenarios under `ff5e77ca` and under the pass, dumping every
 * statement, parameter list, published value, refusal class, sentence and meta.
 * The two dumps must be byte-identical. Placed in both trees by the reviewer;
 * the output path comes from VIBORM_REVIEW_DIGEST.
 */

import { writeFileSync } from "node:fs";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class Recorder extends SQLite3Driver {
  readonly statements: { sql: string; params: unknown[] }[] = [];
  readonly control: string[] = [];
  transactionCalls = 0;
  batchCalls = 0;
  reset(): void {
    this.statements.length = 0;
    this.control.length = 0;
    this.transactionCalls = 0;
    this.batchCalls = 0;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, params: parameters });
    void context;
    return super.execute<T>(client, statement, parameters);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    for (const query of queries)
      this.statements.push({ sql: query.sql, params: query.params ?? [] });
    return super.executeBatch<T>(client, queries, context);
  }
  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[]
  ): Promise<QueryResult<T>> {
    this.control.push(statement);
    return super.executeRaw<T>(client, statement, parameters);
  }
  protected override async transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.transactionCalls++;
    return super.transaction(client, body, context);
  }
}

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
    age: s.int().nullable(),
    posts: s.toMany(() => entry),
  })
  .map("g4rp2_accounts");

const entry = s
  .model({
    id: s.int().id(),
    title: s.string(),
    rank: s.int(),
    accountId: s.int().nullable(),
    account: s.toOne(() => account).fields("accountId").references("id"),
  })
  .map("g4rp2_entries");

const schema = { account, entry };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID, "<uuid>");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = scrub((value as Record<string, unknown>)[key]);
    return out;
  }
  if (typeof value === "bigint") return `${value}n`;
  return value;
}

function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return { thrown: scrub(error) };
  const meta = (error as { meta?: unknown }).meta;
  return {
    class: error.constructor.name,
    message: scrub(error.message),
    meta: meta === undefined ? undefined : scrub(meta),
    cause:
      error.cause instanceof Error
        ? { class: error.cause.constructor.name, message: scrub(error.cause.message) }
        : undefined,
  };
}

describe("review digest", () => {
  it("dumps every scenario", async () => {
    const target = process.env.VIBORM_REVIEW_DIGEST;
    if (!target) return;
    const database = new Database(":memory:");
    const driver = new Recorder({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    if (!migration.applied) throw new Error("schema did not apply");
    await client.account.createMany({
      data: [
        { id: 1, email: "ada@x", name: "Ada", age: 36 },
        { id: 2, email: "bo@x", name: "Bo", age: null },
      ],
    });
    await client.entry.createMany({
      data: [
        { id: 10, title: "one", rank: 1, accountId: 1 },
        { id: 11, title: "two", rank: 2, accountId: 1 },
        { id: 12, title: "three", rank: 3, accountId: 2 },
      ],
    });

    const dump: Record<string, unknown> = {};
    const run = async (name: string, body: () => PromiseLike<unknown>) => {
      driver.reset();
      let value: unknown;
      let failure: unknown;
      try {
        value = await body();
      } catch (error) {
        failure = describeError(error);
      }
      dump[name] = scrub({
        value,
        failure,
        statements: driver.statements,
        control: driver.control,
        transactions: driver.transactionCalls,
        batches: driver.batchCalls,
      });
    };

    await run("read.default", () => client.account.findUnique({ where: { id: 1 } }));
    await run("read.default.again", () =>
      client.account.findUnique({ where: { id: 1 } })
    );
    await run("read.default.other", () =>
      client.account.findUnique({ where: { id: 2 } })
    );
    await run("read.select", () =>
      client.account.findUnique({ where: { id: 1 }, select: { id: true, name: true } })
    );
    await run("read.omit", () =>
      client.account.findUnique({ where: { id: 1 }, omit: { age: true } })
    );
    await run("read.default.after.omit", () =>
      client.account.findUnique({ where: { id: 1 } })
    );
    await run("read.include", () =>
      client.account.findMany({
        where: { name: { startsWith: "A" } },
        include: { posts: true },
        orderBy: { id: "asc" },
      })
    );
    await run("read.nested.select", () =>
      client.account.findMany({
        select: { id: true, posts: { select: { title: true }, take: 2 } },
        orderBy: { id: "asc" },
      })
    );
    await run("read.orThrow.missing", () =>
      client.account.findUniqueOrThrow({ where: { id: 99 } })
    );
    await run("read.count", () => client.entry.count({ where: { rank: { gte: 2 } } }));
    await run("read.aggregate", () =>
      client.entry.aggregate({ _sum: { rank: true }, _count: true })
    );
    await run("read.groupBy", () =>
      client.entry.groupBy({ by: ["accountId"], _count: { id: true }, orderBy: { accountId: "asc" } })
    );
    await run("write.update", () =>
      client.account.update({ where: { id: 1 }, data: { name: "Ada2" } })
    );
    await run("write.updateMany.in", () =>
      client.entry.updateMany({
        where: { id: { in: [10, 11, 12] } },
        data: { rank: { increment: 1 } },
      })
    );
    await run("write.update.missing", () =>
      client.account.update({ where: { id: 99 }, data: { name: "x" } })
    );
    await run("write.delete.missing", () =>
      client.account.delete({ where: { id: 99 } })
    );
    await run("write.create.unique.conflict", () =>
      client.account.create({ data: { id: 3, email: "ada@x", name: "Dup" } })
    );
    await run("write.create.nested", () =>
      client.account.create({
        data: {
          id: 4,
          email: "cy@x",
          name: "Cy",
          posts: { create: [{ id: 20, title: "n1", rank: 1 }, { id: 21, title: "n2", rank: 2 }] },
        },
      })
    );
    await run("write.create.nested.conflict", () =>
      client.account.create({
        data: {
          id: 5,
          email: "dee@x",
          name: "Dee",
          posts: { create: [{ id: 30, title: "ok", rank: 1 }, { id: 20, title: "clash", rank: 2 }] },
        },
      })
    );
    await run("write.upsert.update", () =>
      client.account.upsert({
        where: { id: 1 },
        create: { id: 1, email: "ada@x", name: "AdaC" },
        update: { name: "AdaU" },
      })
    );
    await run("write.upsert.create", () =>
      client.account.upsert({
        where: { id: 7 },
        create: { id: 7, email: "eve@x", name: "Eve" },
        update: { name: "EveU" },
      })
    );
    await run("write.createMany", () =>
      client.entry.createMany({
        data: [
          { id: 40, title: "a", rank: 1, accountId: 1 },
          { id: 41, title: "b", rank: 2, accountId: 2 },
        ],
      })
    );
    await run("write.deleteMany", () =>
      client.entry.deleteMany({ where: { id: { in: [40, 41] } } })
    );
    await run("write.transaction", () =>
      client.$transaction(async (tx) => {
        await tx.entry.update({ where: { id: 10 }, data: { title: "tx" } });
        return tx.entry.findUnique({ where: { id: 10 } });
      })
    );

    // The prepared/packaged seam, through the engine directly.
    const engine = createCommandEngine({ schema, driver });
    const packaged = async (
      name: string,
      model: string,
      operation: string,
      args: unknown
    ) => {
      driver.reset();
      let value: unknown;
      let failure: unknown;
      try {
        const prepared = await engine.prepareBatch(
          model,
          operation as Parameters<typeof engine.prepareBatch>[1],
          args
        );
        value = prepared
          ? {
              queries: prepared.queries.map((query) => ({
                sql: query.sql,
                params: query.params,
              })),
              guards: prepared.guards?.map((guard) => ({
                queryIndex: guard.queryIndex,
                premise: guard.premise,
                model: guard.model,
                operation: guard.operation,
                failure: guard.failure,
              })),
            }
          : undefined;
      } catch (error) {
        failure = describeError(error);
      }
      dump[name] = scrub({ value, failure });
    };

    await packaged("pkg.findUnique", "account", "findUnique", { where: { id: 1 } });
    await packaged("pkg.findUnique.again", "account", "findUnique", { where: { id: 1 } });
    await packaged("pkg.findUnique.value", "account", "findUnique", { where: { id: 2 } });
    await packaged("pkg.findMany.select", "account", "findMany", {
      select: { id: true, posts: { select: { title: true } } },
      orderBy: { id: "asc" },
      take: 5,
    });
    await packaged("pkg.delete", "account", "delete", { where: { id: 2 } });
    await packaged("pkg.updateMany", "entry", "updateMany", {
      where: { id: { in: [10, 11] } },
      data: { rank: { increment: 1 } },
    });

    // Every scenario again, this time THROUGH THE CANDIDATE: the client above
    // routes to the shipped engine by default, so that half is a control.
    const direct = async (name: string, model: string, operation: string, args: unknown) => {
      driver.reset();
      let value: unknown;
      let failure: unknown;
      try {
        value = await engine.execute(
          model,
          operation as Parameters<typeof engine.execute>[1],
          args
        );
      } catch (error) {
        failure = describeError(error);
      }
      dump[`r3.${name}`] = scrub({
        value,
        failure,
        statements: driver.statements,
        control: driver.control,
        transactions: driver.transactionCalls,
        batches: driver.batchCalls,
      });
    };

    await direct("read.default", "account", "findUnique", { where: { id: 1 } });
    await direct("read.default.again", "account", "findUnique", { where: { id: 1 } });
    await direct("read.default.other", "account", "findUnique", { where: { id: 2 } });
    await direct("read.select", "account", "findUnique", {
      where: { id: 1 },
      select: { id: true, name: true },
    });
    await direct("read.omit", "account", "findUnique", {
      where: { id: 1 },
      omit: { age: true },
    });
    await direct("read.default.after.omit", "account", "findUnique", { where: { id: 1 } });
    await direct("read.include", "account", "findMany", {
      where: { name: { startsWith: "A" } },
      include: { posts: true },
      orderBy: { id: "asc" },
    });
    await direct("read.nested.select", "account", "findMany", {
      select: { id: true, posts: { select: { title: true }, take: 2 } },
      orderBy: { id: "asc" },
    });
    await direct("read.orThrow.missing", "account", "findUniqueOrThrow", { where: { id: 99 } });
    await direct("read.findFirst.desc", "entry", "findFirst", {
      where: { rank: { gte: 1 } },
      orderBy: { rank: "desc" },
    });
    await direct("read.count", "entry", "count", { where: { rank: { gte: 2 } } });
    await direct("read.aggregate", "entry", "aggregate", { _sum: { rank: true }, _count: true });
    await direct("read.groupBy", "entry", "groupBy", {
      by: ["accountId"],
      _count: { id: true },
      orderBy: { accountId: "asc" },
    });
    await direct("write.update", "account", "update", {
      where: { id: 2 },
      data: { name: "BoR3" },
    });
    await direct("write.updateMany.in", "entry", "updateMany", {
      where: { id: { in: [10, 11, 12] } },
      data: { rank: { increment: 1 } },
    });
    await direct("write.update.missing", "account", "update", {
      where: { id: 99 },
      data: { name: "x" },
    });
    await direct("write.delete.missing", "account", "delete", { where: { id: 99 } });
    await direct("write.create.unique.conflict", "account", "create", {
      data: { id: 60, email: "ada@x", name: "DupR3" },
    });
    await direct("write.create.nested", "account", "create", {
      data: {
        id: 61,
        email: "r3a@x",
        name: "R3a",
        posts: { create: [{ id: 70, title: "n1", rank: 1 }, { id: 71, title: "n2", rank: 2 }] },
      },
    });
    await direct("write.create.nested.conflict", "account", "create", {
      data: {
        id: 62,
        email: "r3b@x",
        name: "R3b",
        posts: { create: [{ id: 72, title: "ok", rank: 1 }, { id: 70, title: "clash", rank: 2 }] },
      },
    });
    await direct("write.upsert.update", "account", "upsert", {
      where: { id: 1 },
      create: { id: 1, email: "ada@x", name: "AdaC" },
      update: { name: "AdaU3" },
    });
    await direct("write.upsert.create", "account", "upsert", {
      where: { id: 63 },
      create: { id: 63, email: "r3c@x", name: "R3c" },
      update: { name: "R3cU" },
    });
    await direct("write.createMany", "entry", "createMany", {
      data: [
        { id: 80, title: "a", rank: 1, accountId: 1 },
        { id: 81, title: "b", rank: 2, accountId: 2 },
      ],
    });
    await direct("write.deleteMany", "entry", "deleteMany", { where: { id: { in: [80, 81] } } });
    await direct("write.connect", "account", "update", {
      where: { id: 1 },
      data: { posts: { connect: [{ id: 12 }] } },
    });
    await direct("write.nested.update", "account", "update", {
      where: { id: 1 },
      data: { posts: { update: [{ where: { id: 10 }, data: { title: "nested" } }] } },
    });
    await direct("write.nested.update.missing", "account", "update", {
      where: { id: 1 },
      data: { posts: { update: [{ where: { id: 999 }, data: { title: "nope" } }] } },
    });

    await client.$disconnect();
    database.close();

    writeFileSync(target, `${JSON.stringify(dump, null, 2)}\n`);
  });
});
