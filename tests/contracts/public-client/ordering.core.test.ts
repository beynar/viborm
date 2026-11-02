/**
 * viborm/ordering on in-memory SQLite (`ordering-behavior.ts`): the
 * interactive driver, and a batch-only one (D1's shape: every operation one
 * atomic batch, no interactive transaction).
 */

import { createClient } from "@client/client";
import { validateOperationPayload } from "@client/schema-introspection";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { orderingKey } from "@src/ordering";
import {
  describeOrdering,
  describeOrderingAdmission,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      return results;
    });
  }
}

const opening = (driver: () => SQLite3Driver) => async () => {
  const client = createClient({ schema, driver: driver() });
  await syncLiveSchema(client);
  return { client };
};

describeOrdering("SQLite", opening(createInMemorySQLite3Driver));
describeOrdering(
  "SQLite batch-only",
  opening(() => new BatchOnlySQLite3Driver({ dataDir: ":memory:" }))
);
describeOrderingAdmission(opening(createInMemorySQLite3Driver));

// `validateOperationPayload` checks a create as the ordered client admits it:
// a key field `orderingKey` validates, left out, is the extension's to write,
// so its default is neither filled nor refused (Pyxel's studio pre-write
// check, 1.9.0). A key a caller states is still validated.
describe("validateOperationPayload with orderingKey", () => {
  const lane = s.model({
    id: s.string().id(),
    cards: s.toMany(() => task),
  });
  const task = s.model({
    id: s.string().id(),
    laneId: s.string().nullable(),
    rank: s.string().default("").schema(orderingKey),
    note: s.string().default(""),
    lane: s
      .toOne(() => lane)
      .fields("laneId")
      .references("id"),
  });
  const tasks = { lane, task };

  test("a create leaving the key out passes, and leaves it out", () => {
    const payload = validateOperationPayload(tasks, "task", "create", {
      data: { id: "t" },
    });
    expect(payload.data.rank).toBeUndefined();
    // A field no extension appends still takes its default.
    expect(payload.data).toMatchObject({ id: "t", note: "" });
  });

  test("so does a nested create, and an upsert's create", () => {
    expect(() =>
      validateOperationPayload(tasks, "lane", "create", {
        data: { id: "l", cards: { create: [{ id: "a" }, { id: "b" }] } },
      })
    ).not.toThrow();
    expect(() =>
      validateOperationPayload(tasks, "task", "upsert", {
        where: { id: "t" },
        create: { id: "t" },
        update: {},
      })
    ).not.toThrow();
  });

  test("a key the caller states is still validated", () => {
    expect(() =>
      validateOperationPayload(tasks, "task", "create", {
        data: { id: "t", rank: "" },
      })
    ).toThrow(ValidationError);
    expect(
      validateOperationPayload(tasks, "task", "create", {
        data: { id: "t", rank: "15" },
      }).data
    ).toMatchObject({ rank: "15" });
  });
});
