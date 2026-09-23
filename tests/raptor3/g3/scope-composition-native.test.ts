import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { UniqueConstraintError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { describe, it } from "vitest";
import type { CandidateEngineFactory } from "../harness/protocol";
import {
  liveProvider,
  runLiveWorld,
  type LiveFixture,
} from "../transitions/live-world";

const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";

function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const records: Record<string, unknown>[] = [];
  for (const row of value) {
    assert.ok(isRow(row));
    records.push(row);
  }
  return records;
}

function numberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  assert.ok(typeof value === "number");
  return value;
}

function throwTerminalFailure(world: Awaited<ReturnType<typeof runLiveWorld>>) {
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
}

function nativeBulkSchema() {
  const record = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      label: s.string().default("default-label"),
      secret: s.string().default("private"),
      score: s.int().default(0),
    })
    .map("g3_native_bulk_records");
  const defaultOnly = s
    .model({ id: s.int().id().increment() })
    .map("g3_native_bulk_defaults");
  return { record, defaultOnly };
}

async function runNativeBulk(factory: CandidateEngineFactory) {
  const schema = nativeBulkSchema();
  let mixedIds: number[] = [];
  let defaultIds: number[] = [];
  let updatedPairs: { id: number; score: number }[] = [];
  const fixture: LiveFixture = {
    expectedExecutions: 6,
    initial: { records: [], defaults: [] },
    tables: {
      records: { name: "g3_native_bulk_records", order: ["id"] },
      defaults: { name: "g3_native_bulk_defaults", order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      await candidate.execute("record", "create", {
        data: { code: "taken", label: "seed" },
        select: { id: true },
      });
      const mixed = rows(
        await candidate.execute("record", "createMany", {
          data: [
            { id: 100, code: "explicit-first", label: "first" },
            { code: "generated", label: "second" },
            { id: 200, code: "explicit-last", label: "third" },
          ],
          select: { id: true, code: true, label: true },
        })
      );
      assert.deepEqual(
        mixed.map((row) => row.code),
        ["explicit-first", "generated", "explicit-last"]
      );
      mixedIds = mixed.map((row) => numberField(row, "id"));
      assert.equal(new Set(mixedIds).size, 3);

      const defaults = rows(
        await candidate.execute("defaultOnly", "createMany", {
          data: [{}, {}],
          select: { id: true },
        })
      );
      defaultIds = defaults.map((row) => numberField(row, "id"));
      assert.equal(new Set(defaultIds).size, 2);

      const skipped = rows(
        await candidate.execute("record", "createMany", {
          data: [
            { code: "taken", label: "duplicate" },
            { code: "fresh", label: "inserted" },
          ],
          skipDuplicates: true,
          select: { id: true, code: true, label: true },
        })
      );
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0]?.code, "fresh");

      const updated = rows(
        await candidate.execute("record", "updateMany", {
          where: {
            code: {
              in: ["explicit-first", "generated", "explicit-last"],
            },
          },
          data: { score: { increment: 10 } },
          limit: 2,
          select: { id: true, score: true },
        })
      );
      assert.equal(updated.length, 2);
      updatedPairs = updated.map((row) => ({
        id: numberField(row, "id"),
        score: numberField(row, "score"),
      }));

      const deleted = rows(
        await candidate.execute("record", "deleteMany", {
          where: { code: "fresh" },
          omit: { secret: true },
        })
      );
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0]?.code, "fresh");
      const deletedRow = deleted[0];
      assert.ok(deletedRow);
      assert.equal("secret" in deletedRow, false);
      return "native-bulk-ok";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "native-bulk-ok",
      });
      const records = rows(observation.final.records ?? []);
      assert.deepEqual(records.map((row) => row.code).sort(), [
        "explicit-first",
        "explicit-last",
        "generated",
        "taken",
      ]);
      const changed = records
        .filter((row) => row.score === 10)
        .map((row) => ({ id: numberField(row, "id"), score: 10 }))
        .sort((left, right) => left.id - right.id);
      assert.equal(changed.length, 2);
      assert.deepEqual(
        updatedPairs.sort((left, right) => left.id - right.id),
        changed
      );
      assert.deepEqual(
        records
          .filter((row) => row.code !== "taken")
          .map((row) => numberField(row, "id"))
          .sort((left, right) => left - right),
        [...mixedIds].sort((left, right) => left - right)
      );
      assert.deepEqual(
        rows(observation.final.defaults ?? []).map((row) => row.id),
        defaultIds
      );
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => {
      const identity =
        liveProvider === "pg"
          ? `${names.quote("id")} INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`
          : `${names.quote("id")} INTEGER AUTO_INCREMENT PRIMARY KEY`;
      return {
        g3_native_bulk_records: `${identity},${names.quote("code")} ${textType} NOT NULL UNIQUE,${names.quote("label")} ${textType} NOT NULL,${names.quote("secret")} ${textType} NOT NULL,${names.quote("score")} INTEGER NOT NULL`,
        g3_native_bulk_defaults: identity,
      };
    },
    factory
  );
  throwTerminalFailure(world);
  if (liveProvider === "pg")
    assert(
      world.statements.some(({ sql }) =>
        /\bON CONFLICT\b.*\bDO NOTHING\b/i.test(sql)
      )
    );
  else {
    assert(world.statements.every(({ sql }) => !/\bRETURNING\b/i.test(sql)));
    assert(
      world.statements.some(
        ({ sql, completed }) => /^\s*INSERT\b/i.test(sql) && !completed
      ),
      "MySQL duplicate suppression must observe the exact rejected root"
    );
  }
  fixture.assert(world.observation);
  world.assertHealthy();
}

function nativeScopeSchema() {
  const author = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("g3_native_scope_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      notes: s.toMany(() => note),
    })
    .map("g3_native_scope_posts");
  const note = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      postId: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("g3_native_scope_notes");
  return { author, post, note };
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

function scopedOperation(
  source: PromiseLike<unknown>,
  candidate: ReturnType<CandidateEngineFactory>,
  operation: "createMany" | "update",
  args: unknown
) {
  return overrideTransactionOperation(source, {
    executeWith(transactionDriver) {
      return candidate.execute("post", operation, args, {
        kind: "borrowed-transaction",
        driver: transactionDriver,
        memberRollback: (execute, context) =>
          transactionDriver.withTransaction(execute, undefined, context),
      });
    },
  });
}

function scopeDefinitions(names: {
  quote(identifier: string): string;
  table(identifier: string): string;
}) {
  return {
    g3_native_scope_authors: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("name")} ${textType} NOT NULL UNIQUE`,
    g3_native_scope_posts: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("title")} ${textType} NOT NULL,${names.quote("authorId")} ${textType} NOT NULL,FOREIGN KEY(${names.quote("authorId")}) REFERENCES ${names.table("g3_native_scope_authors")}(${names.quote("id")})`,
    g3_native_scope_notes: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("slug")} ${textType} NOT NULL UNIQUE,${names.quote("postId")} ${textType} NOT NULL,FOREIGN KEY(${names.quote("postId")}) REFERENCES ${names.table("g3_native_scope_posts")}(${names.quote("id")})`,
  };
}

async function runNativeSuppression(factory: CandidateEngineFactory) {
  const schema = nativeScopeSchema();
  const initial = {
    authors: [{ id: "a0", name: "existing" }],
    posts: [{ id: "occupied", title: "kept", authorId: "a0" }],
    notes: [],
  };
  const success: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: {
      authors: { name: "g3_native_scope_authors", order: ["id"] },
      posts: { name: "g3_native_scope_posts", order: ["id"] },
      notes: { name: "g3_native_scope_notes", order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const client = createClient({ schema, driver });
      const candidate = candidateFactory({ schema, driver });
      const series = scopedOperation(
        client.post.findMany(),
        candidate,
        "createMany",
        {
          data: [
            {
              id: "prefix",
              title: "prefix",
              author: { create: { id: "ap", name: "prefix" } },
            },
            {
              id: "occupied",
              title: "duplicate",
              author: { create: { id: "ghost", name: "ghost" } },
            },
            {
              id: "suffix",
              title: "suffix",
              author: { create: { id: "as", name: "suffix" } },
            },
          ],
          skipDuplicates: true,
          select: { id: true, title: true },
        }
      );
      const observer = scopedOperation(
        client.post.findMany(),
        candidate,
        "update",
        {
          where: { id: "suffix" },
          data: { title: "observed" },
          select: { id: true, title: true },
        }
      );
      assert.deepEqual(await transactionArray(client, [series, observer]), [
        [
          { id: "prefix", title: "prefix" },
          { id: "suffix", title: "suffix" },
        ],
        { id: "suffix", title: "observed" },
      ]);
      return "native-suppression-ok";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "native-suppression-ok",
      });
      assert.deepEqual(observation.final, {
        authors: [
          { id: "a0", name: "existing" },
          { id: "ap", name: "prefix" },
          { id: "as", name: "suffix" },
        ],
        posts: [
          { id: "occupied", title: "kept", authorId: "a0" },
          { id: "prefix", title: "prefix", authorId: "ap" },
          { id: "suffix", title: "observed", authorId: "as" },
        ],
        notes: [],
      });
    },
  };
  const successful = await runLiveWorld(success, scopeDefinitions, factory);
  throwTerminalFailure(successful);
  assert(
    successful.completions.every(({ transactionOpen }) => transactionOpen),
    "Every candidate statement must remain inside the caller transaction"
  );
  success.assert(successful.observation);
  successful.assertHealthy();

  let descendantFailure: unknown;
  const fatalInitial = {
    ...initial,
    notes: [{ id: "n0", slug: "taken", postId: "occupied" }],
  };
  const fatal: LiveFixture = {
    expectedExecutions: 1,
    initial: fatalInitial,
    tables: success.tables,
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const client = createClient({ schema, driver });
      const candidate = candidateFactory({ schema, driver });
      const series = scopedOperation(
        client.post.findMany(),
        candidate,
        "createMany",
        {
          data: [
            {
              id: "prefix",
              title: "prefix",
              author: { create: { id: "ap", name: "prefix" } },
            },
            {
              id: "doomed",
              title: "doomed",
              author: { create: { id: "ghost", name: "ghost" } },
              notes: { create: { id: "n1", slug: "taken" } },
            },
          ],
          skipDuplicates: true,
        }
      );
      await assert.rejects(transactionArray(client, [series]), (failure) => {
        descendantFailure = failure;
        return failure instanceof UniqueConstraintError;
      });
      return "native-descendant-refused";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "native-descendant-refused",
      });
      assert.deepEqual(observation.final, fatalInitial);
    },
  };
  const failed = await runLiveWorld(fatal, scopeDefinitions, factory);
  throwTerminalFailure(failed);
  assert(descendantFailure instanceof UniqueConstraintError);
  fatal.assert(failed.observation);
  failed.assertHealthy();
}

describe(`G3 native ${liveProvider} bulk and scope composition`, () => {
  it(
    "executes grouped bulk results, scalar suppression and limited returns",
    () => runNativeBulk(createCommandEngine),
    30_000
  );

  it(
    "composes exact-root suppression into one caller transaction and keeps descendants fatal",
    () => runNativeSuppression(createCommandEngine),
    60_000
  );
});
