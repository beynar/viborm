/**
 * N4 row 23 (the refusals plan §4, D-52) — a demanded value the batch scratch
 * cannot carry is OBSERVED, not refused.
 *
 * The batch scratch reads back as an integer, so an `int` field was the only
 * domain a dependent could demand as an expression and every other domain hit
 * the registered `Cannot publish the updated value of 'X.f' … inside an atomic
 * batch` (R-D3). Under N1 the consumer that needs such a value takes an
 * ORDERED OBSERVATION of the row after the write: the UPDATE is queued, the
 * read rides the same native batch behind it, and anything that consumes the
 * value follows in the next — D-51's succession of statements. The answer is
 * the shipped engine's row again, computed by the provider instead of in
 * JavaScript. The scratch keeps carrying the integer keys it carries today,
 * which the last cell measures.
 *
 * MEASURED reachability: the census map named a nested dependent write as the
 * smallest payload. It is not reachable — a relation key updated with an
 * operation while the relation is mutated is refused earlier and on both
 * routes ("Cannot update relation key field 'f' with a non-literal operation
 * while mutating relation 'r'"). What reaches this owner is an operation whose
 * OWN publication demands the key it updates, which is what these cells spell.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

/** The batch-only transport, remembering which statements rode which batch. */
class GroupedBatchOnlyDriver extends BatchOnlyDriver {
  readonly groups: string[][] = [];
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.groups.push(queries.map((query) => query.sql));
    return super.executeBatch<T>(client, queries);
  }
}

const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("n4_num_keys");
const bigKey = s
  .model({ id: s.bigInt().id(), label: s.string() })
  .map("n4_big_keys");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("n4_dec_keys");
const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("n4_int_keys");
const schema = { numKey, bigKey, decKey, intKey };

const UPDATE_NUM = /^UPDATE "n4_num_keys"/;
const SELECT_NUM = /^SELECT .* FROM "n4_num_keys"/;
const STORE = /^INSERT INTO "__viborm_batch_refs"/;
const UPDATE_INT = /^UPDATE "n4_int_keys"/;
const SELECT_INT = /^SELECT .* FROM "n4_int_keys"/;

for (const [route, make] of [
  ["live", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new GroupedBatchOnlyDriver()],
] as const) {
  describe(`N4-23: publishing a computed non-int key on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    const batch = route !== "live";
    const groups = () =>
      driver instanceof GroupedBatchOnlyDriver ? driver.groups : [];
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.numKey.create({ data: { id: 6, label: "a" } });
      await client.bigKey.create({ data: { id: 6n, label: "a" } });
      await client.decKey.create({ data: { id: "6.00", label: "a" } });
      await client.intKey.create({ data: { id: 6, label: "a" } });
      driver.reset();
      return client;
    }
    const statements = () =>
      driver.statements.map((statement) => statement.sql);
    const indexOf = (pattern: RegExp, from = 0) =>
      statements().findIndex(
        (sql, index) => index >= from && pattern.test(sql)
      );

    it("a number key incremented under the batch answers the provider's row", async () => {
      const client = await world();
      assert.deepEqual(
        await client.numKey.upsert({
          where: { id: 6 },
          create: { id: 6, label: "a" },
          update: { id: { increment: 1 } },
        }),
        { id: 7, label: "a" }
      );
      assert.deepEqual(await client.numKey.findMany({}), [
        { id: 7, label: "a" },
      ]);
    });

    it("the same key multiplied answers the same way", async () => {
      const client = await world();
      assert.deepEqual(
        await client.numKey.upsert({
          where: { id: 6 },
          create: { id: 6, label: "a" },
          update: { id: { multiply: 2 } },
        }),
        { id: 12, label: "a" }
      );
    });

    it("a bigint key and a decimal key publish through the same observation", async () => {
      const client = await world();
      assert.deepEqual(
        await client.bigKey.upsert({
          where: { id: 6n },
          create: { id: 6n, label: "a" },
          update: { id: { increment: 1n } },
        }),
        { id: 7n, label: "a" }
      );
      const decimal = await client.decKey.upsert({
        where: { id: "6.00" },
        create: { id: "6.00", label: "a" },
        update: { id: { increment: "1.00" } },
      });
      // The decimal codec answers its own domain value; the observation is
      // about WHICH value, not about its spelling.
      assert.equal(String(decimal.id), "7");
      assert.equal(decimal.label, "a");
    });

    it("the observation is taken BEHIND the write", async () => {
      const client = await world();
      await client.numKey.upsert({
        where: { id: 6 },
        create: { id: 6, label: "a" },
        update: { id: { increment: 1 } },
      });
      const write = indexOf(UPDATE_NUM);
      assert.ok(write >= 0, statements().join("\n"));
      const observation = indexOf(SELECT_NUM, write + 1);
      assert.ok(observation > write, statements().join("\n"));
      if (!batch) return;
      // In the UPDATE's own native batch, behind it; the published row is
      // read in the NEXT batch — D-51's succession of statements.
      const unit = groups().findIndex((group) =>
        group.some((sql) => UPDATE_NUM.test(sql))
      );
      const group = groups()[unit]!;
      const written = group.findIndex((sql) => UPDATE_NUM.test(sql));
      assert.ok(
        group.findIndex(
          (sql, index) => index > written && SELECT_NUM.test(sql)
        ) > written,
        group.join("\n")
      );
      assert.ok(
        groups()
          .slice(unit + 1)
          .some((later) => later.some((sql) => SELECT_NUM.test(sql))),
        groups()
          .map((later) => later.join("\n"))
          .join("\n--\n")
      );
    });

    it("an INT key still travels through the scratch", async () => {
      const client = await world();
      assert.deepEqual(
        await client.intKey.upsert({
          where: { id: 6 },
          create: { id: 6, label: "a" },
          update: { id: { increment: 1 } },
        }),
        { id: 7, label: "a" }
      );
      if (!batch) return;
      // The scratch's whole point: the value travels as an expression, so no
      // read of the row sits between the scratch store and the UPDATE — the
      // first read of the table after the store is the published row, behind
      // the write.
      const store = indexOf(STORE);
      const write = indexOf(UPDATE_INT, store + 1);
      assert.ok(store >= 0 && write > store, statements().join("\n"));
      assert.ok(
        indexOf(SELECT_INT, store + 1) > write,
        statements().join("\n")
      );
    });
  });
}
